import {
  dbToolError,
  type DbToolError,
  type SchemaCatalog,
} from "@shared/contracts";
import type { GuardAst, GuardSuccess } from "@shared/access-policy";
import {
  DETAIL_QUERY_LIMIT,
  FANOUT_CHILD_TABLES,
  FANOUT_SENSITIVE_AGGREGATES,
} from "../constants.js";
import {
  loadSemanticJoinRules,
  type SemanticJoinRuleMeta,
} from "../semantic/catalog.js";

export { DETAIL_QUERY_LIMIT } from "../constants.js";

export type SafetyGateResult =
  | { verdict: "pass"; sql: string }
  | { verdict: "deny"; error: DbToolError }
  | { verdict: "needs_clarification"; reason: string; table: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function findNodes(root: unknown, key: string): unknown[] {
  const out: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    for (const [name, value] of Object.entries(record)) {
      if (name === key) out.push(value);
      visit(value);
    }
  };
  visit(root);
  return out;
}

function rootSelectStmt(ast: GuardAst): Record<string, unknown> | undefined {
  const root = asRecord(ast as unknown);
  const stmts = root?.["stmts"];
  if (!Array.isArray(stmts) || stmts.length === 0) return undefined;
  const stmt = asRecord(stmts[0])?.["stmt"];
  return asRecord(asRecord(stmt)?.["SelectStmt"]);
}

/** GuardSuccess.columns already collects refs from every clause, so one set check covers all clauses. */
function sensitiveRef(
  guard: GuardSuccess,
  catalog: SchemaCatalog,
): { table: string; column: string } | undefined {
  const referenced = new Set(guard.columns.map((c) => c.toLowerCase()));
  const scanned = new Set(guard.tables.map((t) => t.toLowerCase()));
  for (const table of catalog.tables) {
    if (!scanned.has(table.name.toLowerCase())) continue;
    for (const column of table.columns) {
      if (
        column.sensitive &&
        referenced.has(column.name.toLowerCase())
      ) {
        return { table: table.name, column: column.name };
      }
    }
  }
  return undefined;
}

/** NATURAL JOIN is left to the server guard because resolving it requires output-column mapping. */
function unconditionedJoin(ast: GuardAst, sql: string): string | undefined {
  for (const node of findNodes(ast, "JoinExpr")) {
    const join = asRecord(node);
    if (!join) continue;
    const quals = join["quals"];
    const usingClause = join["usingClause"];
    const hasUsing = Array.isArray(usingClause) && usingClause.length > 0;
    const isNatural = join["isNatural"] === true;
    if (quals !== undefined && quals !== null) continue;
    if (hasUsing || isNatural) continue;
    if (/\bcross\s+join\b/i.test(sql)) {
      return "CROSS JOIN is not allowed";
    }
    return "join without an ON/USING condition is not allowed";
  }
  for (const node of findNodes(ast, "fromClause")) {
    if (Array.isArray(node) && node.length > 1) {
      return "comma-separated FROM items form a cross join; use explicit JOIN ... ON";
    }
  }
  return undefined;
}

export function largeScannedTables(
  guard: GuardSuccess,
  catalog: SchemaCatalog,
): string[] {
  const scanned = new Set(guard.tables.map((t) => t.toLowerCase()));
  return catalog.tables
    .filter(
      (table) =>
        scanned.has(table.name.toLowerCase()) &&
        table.columns.some((column) => column.large),
    )
    .map((table) => table.name);
}

export function hasWhereFilter(ast: GuardAst): boolean {
  return findNodes(ast, "whereClause").some(
    (value) => value !== undefined && value !== null,
  );
}

const AGGREGATE_FUNCTIONS = new Set([
  "array_agg",
  "avg",
  "bit_and",
  "bit_or",
  "bool_and",
  "bool_or",
  "count",
  "every",
  "json_agg",
  "json_object_agg",
  "jsonb_agg",
  "jsonb_object_agg",
  "max",
  "min",
  "range_agg",
  "range_intersect_agg",
  "string_agg",
  "sum",
  "xmlagg",
]);

function functionName(node: unknown): string | undefined {
  const call = asRecord(node);
  const parts = call?.["funcname"];
  if (!Array.isArray(parts) || parts.length === 0) return undefined;
  const finalPart = asRecord(parts.at(-1));
  const name = asRecord(finalPart?.["String"])?.["sval"];
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

function hasAggregate(ast: GuardAst): boolean {
  const root = rootSelectStmt(ast);
  return root ? selectHasAggregate(root) : false;
}

function selectHasAggregate(root: Record<string, unknown>): boolean {
  const targetList = root["targetList"];
  if (
    findNodes(targetList, "FuncCall").some((node) =>
      AGGREGATE_FUNCTIONS.has(functionName(node) ?? ""),
    )
  ) {
    return true;
  }
  const group = root["groupClause"];
  if (Array.isArray(group) && group.length > 0) return true;
  const having = root["havingClause"];
  return having !== undefined && having !== null;
}

function columnRefName(node: unknown): string | undefined {
  return columnRefFieldName(asRecord(node)?.["ColumnRef"]);
}

function columnRefFieldName(columnRef: unknown): string | undefined {
  const ref = asRecord(columnRef);
  const fields = ref?.["fields"];
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  const finalField = asRecord(fields.at(-1));
  const name = asRecord(finalField?.["String"])?.["sval"];
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

function columnRefQualifier(columnRef: unknown): string | undefined {
  const ref = asRecord(columnRef);
  const fields = ref?.["fields"];
  if (!Array.isArray(fields) || fields.length < 2) return undefined;
  const qualField = asRecord(fields.at(-2));
  const name = asRecord(qualField?.["String"])?.["sval"];
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

function comparisonOperator(expression: Record<string, unknown>): string | undefined {
  const names = expression["name"];
  if (!Array.isArray(names)) return undefined;
  const value = asRecord(asRecord(names[0])?.["String"])?.["sval"];
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

/** Aliases computed only from purchase_date (MIN, date_trunc) keep the first-purchase CTE shape valid. */
function purchaseDateAliases(ast: GuardAst): Set<string> {
  const aliases = new Set(["purchase_date"]);
  for (const node of findNodes(ast, "ResTarget")) {
    const target = asRecord(node);
    const name = target?.["name"];
    if (typeof name !== "string") continue;
    const refs = findNodes(target?.["val"], "ColumnRef").map(columnRefFieldName);
    if (refs.length > 0 && refs.every((ref) => ref === "purchase_date")) {
      aliases.add(name.toLowerCase());
    }
  }
  return aliases;
}

/** Require a direct conjunctive comparison so IS NOT NULL or OR branches cannot bypass the time bound. */
function hasConjunctivePurchaseDateRange(
  node: unknown,
  dateColumns: ReadonlySet<string>,
  insideOr = false,
): boolean {
  const record = asRecord(node);
  if (!record) return false;
  const bool = asRecord(record["BoolExpr"]);
  if (bool) {
    const args = bool["args"];
    const isOr = bool["boolop"] === 1 || String(bool["boolop"]).toUpperCase() === "OR_EXPR";
    return (
      Array.isArray(args) &&
      args.some((arg) => hasConjunctivePurchaseDateRange(arg, dateColumns, insideOr || isOr))
    );
  }
  const expression = asRecord(record["A_Expr"]);
  if (!expression || insideOr) return false;
  const operator = comparisonOperator(expression);
  if (!operator || !["=", ">", ">=", "<", "<=", "BETWEEN"].includes(operator)) return false;
  return [expression["lexpr"], expression["rexpr"]].some((side) =>
    dateColumns.has(columnRefName(side) ?? ""),
  );
}

/** Both large fact tables require a purchase_date bound, aggregates included; order_items receives it via orders join. */
function hasLargeTableTimeFilter(guard: GuardSuccess, large: string[]): boolean {
  const names = new Set(large.map((table) => table.toLowerCase()));
  if (!names.has("orders") && !names.has("order_items")) return true;
  const dateColumns = purchaseDateAliases(guard.ast);
  return findNodes(guard.ast, "whereClause").some((where) =>
    hasConjunctivePurchaseDateRange(where, dateColumns),
  );
}

function extractBaseTable(fromItem: unknown): string | undefined {
  if (Array.isArray(fromItem)) {
    return extractBaseTable(fromItem[0]);
  }
  const record = asRecord(fromItem);
  if (!record) return undefined;
  const range = asRecord(record["RangeVar"]);
  if (range && typeof range["relname"] === "string") {
    return range["relname"].toLowerCase();
  }
  const join = asRecord(record["JoinExpr"]);
  if (join) {
    return extractBaseTable(join["larg"]);
  }
  return undefined;
}

function extractTableAliases(fromItem: unknown, out: Map<string, string>): void {
  if (Array.isArray(fromItem)) {
    for (const entry of fromItem) extractTableAliases(entry, out);
    return;
  }
  const record = asRecord(fromItem);
  if (!record) return;
  const range = asRecord(record["RangeVar"]);
  if (range) {
    const relname = typeof range["relname"] === "string" ? range["relname"].toLowerCase() : undefined;
    if (relname) {
      out.set(relname, relname);
      const aliasNode = asRecord(range["alias"]);
      const alias = typeof aliasNode?.["aliasname"] === "string" ? (aliasNode["aliasname"] as string).toLowerCase() : undefined;
      if (alias) out.set(alias, relname);
    }
    return;
  }
  const join = asRecord(record["JoinExpr"]);
  if (join) {
    extractTableAliases(join["larg"], out);
    extractTableAliases(join["rarg"], out);
  }
}

function getJoinRuleMap(joinRules: readonly SemanticJoinRuleMeta[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const rule of joinRules) {
    if (rule.cardinality === "1:N" && rule.tables.length >= 2) {
      const parent = rule.table ?? rule.tables[0]!;
      for (const t of rule.tables) {
        if (t !== parent) {
          if (!map.has(parent)) map.set(parent, new Set());
          map.get(parent)!.add(t);
        }
      }
    } else if (rule.cardinality === "M:N" && rule.tables.length >= 3) {
      const parent = rule.table ?? rule.tables[0]!;
      for (const t of rule.tables) {
        if (t !== parent) {
          if (!map.has(parent)) map.set(parent, new Set());
          map.get(parent)!.add(t);
        }
      }
    }
  }
  return map;
}

function extractAggMeasureColumnRefs(node: unknown): unknown[] {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      out.push(...extractAggMeasureColumnRefs(item));
    }
    return out;
  }
  const record = asRecord(node);
  if (!record) return [];
  if (record["CaseExpr"]) {
    const caseExpr = asRecord(record["CaseExpr"]);
    const out: unknown[] = [];
    if (caseExpr) {
      const whens = caseExpr["args"];
      if (Array.isArray(whens)) {
        for (const w of whens) {
          const whenRec = asRecord(asRecord(w)?.["CaseWhen"]);
          if (whenRec?.["result"]) {
            out.push(...extractAggMeasureColumnRefs(whenRec["result"]));
          }
        }
      }
      if (caseExpr["defresult"]) {
        out.push(...extractAggMeasureColumnRefs(caseExpr["defresult"]));
      }
    }
    return out;
  }
  if (record["A_Expr"]) {
    const expr = asRecord(record["A_Expr"]);
    const out: unknown[] = [];
    if (expr?.["lexpr"]) out.push(...extractAggMeasureColumnRefs(expr["lexpr"]));
    if (expr?.["rexpr"]) out.push(...extractAggMeasureColumnRefs(expr["rexpr"]));
    return out;
  }
  return findNodes(node, "ColumnRef");
}

function evaluateJoinFanout(
  ast: GuardAst,
  catalog: SchemaCatalog,
  joinRules: readonly SemanticJoinRuleMeta[] = loadSemanticJoinRules(),
): DbToolError | undefined {
  const ruleMap = getJoinRuleMap(joinRules);
  for (const t of catalog.tables) {
    const childName = t.name.toLowerCase();
    for (const fk of t.foreignKeys ?? []) {
      const parentName = fk.referencesTable.toLowerCase();
      if (parentName !== childName) {
        if (!ruleMap.has(parentName)) ruleMap.set(parentName, new Set());
        ruleMap.get(parentName)!.add(childName);
      }
    }
  }

  for (const node of findNodes(ast, "SelectStmt")) {
    const stmt = asRecord(node);
    if (!stmt) continue;
    const aliases = new Map<string, string>();
    extractTableAliases(stmt["fromClause"], aliases);
    const scanned = new Set(aliases.values());
    if (scanned.size < 2) continue;

    const aggCalls = findNodes([stmt["targetList"], stmt["havingClause"]], "FuncCall").filter(
      (n) => {
        const call = asRecord(n);
        if (call?.["agg_distinct"] === true) return false;
        return FANOUT_SENSITIVE_AGGREGATES.includes(functionName(n) ?? "");
      },
    );
    if (aggCalls.length === 0) continue;

    for (const parent of scanned) {
      const childrenSet = ruleMap.get(parent);
      const fallbackChildren = parent === "orders" ? FANOUT_CHILD_TABLES : [];
      const candidateChildNames = childrenSet ? [...childrenSet] : [...fallbackChildren];
      const presentChildren = candidateChildNames.filter((c) => scanned.has(c));
      if (presentChildren.length >= 2) {
        return dbToolError(
          "INVALID_SQL",
          `Join fan-out: ${presentChildren.join(" and ")} are joined at the same level as SUM/AVG/COUNT, ` +
            "which repeats rows before aggregating. Pre-aggregate each child table by order_id " +
            "in its own CTE, then join the CTEs.",
        );
      }
      if (presentChildren.length === 1) {
        const child = presentChildren[0]!;
        for (const callNode of aggCalls) {
          const call = asRecord(callNode);
          if (!call) continue;
          const colRefs = extractAggMeasureColumnRefs(call["args"]);
          if (colRefs.length === 0) {
            const baseTable = extractBaseTable(stmt["fromClause"]);
            if (baseTable === parent) {
              return dbToolError(
                "INVALID_SQL",
                `Join fan-out: aggregate over column on the "1" side of 1:N join between ${parent} and ${child} without grain-safe pre-aggregation. Pre-aggregate child table in a CTE, then join.`,
              );
            }
            continue;
          }
          for (const colRef of colRefs) {
            const qualifier = columnRefQualifier(colRef);
            const colName = columnRefFieldName(colRef);
            let resolvedTable: string | undefined;
            if (qualifier) {
              resolvedTable = aliases.get(qualifier);
            } else if (colName) {
              const matches = catalog.tables.filter(
                (tbl) =>
                  scanned.has(tbl.name.toLowerCase()) &&
                  tbl.columns.some((c) => c.name.toLowerCase() === colName),
              );
              if (matches.length === 1) {
                resolvedTable = matches[0]?.name.toLowerCase();
              }
            }
            if (resolvedTable === parent) {
              return dbToolError(
                "INVALID_SQL",
                `Join fan-out: aggregate over column "${colName ?? "unknown"}" on the "1" side of 1:N join between ${parent} and ${child} without grain-safe pre-aggregation. Pre-aggregate child table in a CTE, then join.`,
              );
            }
          }
        }
      }
    }
  }
  return undefined;
}

export function clampLimit(sql: string, cap: number): string {
  const body = sql.replace(/;+\s*$/, "");
  const limited = /\bLIMIT\s+(ALL|\d+)(\s+OFFSET\s+\d+)?\s*$/i.exec(body);
  if (limited) {
    const head = body.slice(0, limited.index);
    const tail = limited[0];
    const amount = limited[1];
    if (/^ALL$/i.test(amount)) {
      return `${head}${tail.replace(/ALL/i, String(cap))}`;
    }
    if (Number(amount) > cap) {
      return `${head}${tail.replace(amount, String(cap))}`;
    }
    return sql;
  }
  if (/\bLIMIT\b/i.test(body)) {
    return sql;
  }
  const offsetOnly = /\bOFFSET\s+\d+\s*$/i.exec(body);
  if (offsetOnly) {
    return `${body.slice(0, offsetOnly.index)}LIMIT ${cap} ${body.slice(offsetOnly.index)}`;
  }
  return `${body} LIMIT ${cap}`;
}

export function localQuerySafetyGate(
  sql: string,
  guard: GuardSuccess,
  catalog: SchemaCatalog,
  joinRules?: readonly SemanticJoinRuleMeta[],
): SafetyGateResult {
  const sensitive = sensitiveRef(guard, catalog);
  if (sensitive) {
    return {
      verdict: "deny",
      error: dbToolError(
        "SENSITIVE_COLUMN_DENIED",
        `Sensitive column referenced: ${sensitive.table}.${sensitive.column}`,
      ),
    };
  }

  const badJoin = unconditionedJoin(guard.ast, sql);
  if (badJoin) {
    return {
      verdict: "deny",
      error: dbToolError("FORBIDDEN_STATEMENT", badJoin),
    };
  }

  const fanout = evaluateJoinFanout(guard.ast, catalog, joinRules);
  if (fanout) {
    return {
      verdict: "deny",
      error: fanout,
    };
  }

  const large = largeScannedTables(guard, catalog);
  if (large.length > 0 && !hasLargeTableTimeFilter(guard, large)) {
    const table = large[0];
    return {
      verdict: "needs_clarification",
      table,
      reason:
        `Query scans large table "${table}" without an indexed ` +
        "orders.purchase_date filter; choose a time range before running it.",
    };
  }

  if (!hasAggregate(guard.ast)) {
    return { verdict: "pass", sql: clampLimit(sql, DETAIL_QUERY_LIMIT) };
  }
  return { verdict: "pass", sql };
}
