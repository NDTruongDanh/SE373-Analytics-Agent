import {
  dbToolError,
  type DbToolError,
  type SchemaCatalog,
} from "@shared/contracts";
import type { GuardAst, GuardSuccess } from "@shared/access-policy";
import { DETAIL_QUERY_LIMIT } from "../constants.js";

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

function largeScannedTables(
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
  if (!root) return false;
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
  const ref = asRecord(asRecord(node)?.["ColumnRef"]);
  const fields = ref?.["fields"];
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  const finalField = asRecord(fields.at(-1));
  const name = asRecord(finalField?.["String"])?.["sval"];
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

function comparisonOperator(expression: Record<string, unknown>): string | undefined {
  const names = expression["name"];
  if (!Array.isArray(names)) return undefined;
  const value = asRecord(asRecord(names[0])?.["String"])?.["sval"];
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

/** Require a direct conjunctive comparison so IS NOT NULL or OR branches cannot bypass the time bound. */
function hasConjunctivePurchaseDateRange(node: unknown, insideOr = false): boolean {
  const record = asRecord(node);
  if (!record) return false;
  const bool = asRecord(record["BoolExpr"]);
  if (bool) {
    const args = bool["args"];
    const isOr = bool["boolop"] === 1 || String(bool["boolop"]).toUpperCase() === "OR_EXPR";
    return Array.isArray(args) && args.some((arg) => hasConjunctivePurchaseDateRange(arg, insideOr || isOr));
  }
  const expression = asRecord(record["A_Expr"]);
  if (!expression || insideOr) return false;
  const operator = comparisonOperator(expression);
  if (!operator || ![">", ">=", "<", "<=", "BETWEEN"].includes(operator)) return false;
  return (
    columnRefName(expression["lexpr"]) === "purchase_date" ||
    columnRefName(expression["rexpr"]) === "purchase_date"
  );
}

/** Both large fact tables require a purchase_date bound; order_items receives it via orders join. */
function hasLargeTableTimeFilter(guard: GuardSuccess, large: string[]): boolean {
  const names = new Set(large.map((table) => table.toLowerCase()));
  if (!names.has("orders") && !names.has("order_items")) return true;
  return findNodes(guard.ast, "whereClause").some((where) =>
    hasConjunctivePurchaseDateRange(where),
  );
}

/** Tail-only rewrite preserves inner subquery LIMITs and leaves parameterized LIMITs for the server. */
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

  const large = largeScannedTables(guard, catalog);
  if (large.length > 0 && !hasAggregate(guard.ast) && !hasLargeTableTimeFilter(guard, large)) {
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
