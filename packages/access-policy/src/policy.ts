// Column resolution plus scope/row-scope enforcement (POL-01..03).
// Pure: no DB or network I/O. The AST is shared with the 01-05 sqlGuard
// stage (GuardSuccess.ast) so the pipeline never parses twice; every
// deparse output is re-parsed plus re-guarded fail-closed.
//
// Fail-closed summary: ambiguous unqualified columns, unknown qualifiers,
// non-enumerable subquery outputs, multi-level CTEs and LATERAL over
// sensitive tables all deny. Masking preserves output column names;
// row-scope predicates are AND-ed per query level with the level's alias.
import { walk } from "@pgsql/traverse";
import type { NodePath } from "@pgsql/traverse";
import { deparse, parse } from "pgsql-parser";
import type { DbToolError, ErrorCode, SchemaCatalog } from "@shared/contracts";
import { dbToolError } from "@shared/contracts";
import { sqlGuard } from "./guard.js";
import type { GuardAst } from "./guard.js";
import { DEFAULT_SENSITIVE_COLUMNS } from "./sensitive-columns.js";

export type Clause =
  | "projection"
  | "where"
  | "join"
  | "group"
  | "having"
  | "order"
  | "funcarg"
  | "aggregate";

export type ResolvedColumnRef = {
  table: string;
  column: string;
  clause: Clause;
  sensitive: boolean;
};

export type SensitiveEntry = { table: string; column: string };

export type Principal = {
  userId: string;
  role: string;
  scopes: string[];
  rowScope?: { table?: string; column: string; value: string } | null;
};

export type PolicyResult =
  | { allowed: true; sql: string; maskedColumns: string[] }
  | { allowed: false; error: DbToolError };

export interface AccessPolicy {
  readonly name: string;
  check(input: {
    ast: GuardAst;
    sql: string;
    catalog: SchemaCatalog;
    principal: Principal;
  }): Promise<PolicyResult>;
}

// Thrown by resolveColumns on fail-closed shapes; ColumnScopePolicy.check
// converts it into a deny PolicyResult. Standalone callers (01-11
// pre-check) treat any throw as deny.
export class PolicyError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

function deny(code: ErrorCode, message: string): never {
  throw new PolicyError(code, message);
}

function svalText(field: unknown): string | undefined {
  if (typeof field !== "object" || field === null) return undefined;
  const stringNode = (field as Record<string, unknown>)["String"] as
    | { sval?: unknown }
    | undefined;
  return typeof stringNode?.sval === "string" ? stringNode.sval : undefined;
}

function asRecord(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  return node as Record<string, unknown>;
}

function asSelectStmt(node: unknown): Record<string, unknown> | undefined {
  const record = asRecord(node);
  if (record === undefined) return undefined;
  if (Array.isArray(record["targetList"]) || record["larg"] !== undefined) {
    return record;
  }
  return asSelectStmt(record["SelectStmt"]);
}

function lookupTable(
  catalog: SchemaCatalog,
  name: string,
): SchemaCatalog["tables"][number] | undefined {
  for (const table of catalog.tables) {
    if (table.name === name) return table;
  }
  const lowered = name.toLowerCase();
  for (const table of catalog.tables) {
    if (table.name.toLowerCase() === lowered) return table;
  }
  return undefined;
}

function columnIn(
  table: SchemaCatalog["tables"][number],
  column: string,
): SchemaCatalog["tables"][number]["columns"][number] | undefined {
  for (const col of table.columns) {
    if (col.name === column) return col;
  }
  const lowered = column.toLowerCase();
  for (const col of table.columns) {
    if (col.name.toLowerCase() === lowered) return col;
  }
  return undefined;
}

function extraSet(extra: SensitiveEntry[]): Set<string> {
  const set = new Set<string>();
  for (const entry of extra) {
    set.add(`${entry.table.toLowerCase()}.${entry.column.toLowerCase()}`);
  }
  return set;
}

function isSensitive(
  table: string,
  column: string,
  catalog: SchemaCatalog,
  extra: Set<string>,
): boolean {
  if (extra.has(`${table.toLowerCase()}.${column.toLowerCase()}`)) {
    return true;
  }
  const catalogTable = lookupTable(catalog, table);
  if (catalogTable === undefined) return false;
  const col = columnIn(catalogTable, column);
  return col?.sensitive === true;
}

// Aggregate names for the funcarg/aggregate clause split. Any ColumnRef
// under a FuncCall with agg_star/agg_order/agg_distinct/over, or whose
// function name is in this set, records clause `aggregate`; other function
// arguments record `funcarg`. Both deny identically without data:sensitive.
const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "array_agg",
  "string_agg",
  "json_agg",
  "jsonb_agg",
  "bool_and",
  "bool_or",
  "every",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "variance",
  "var_pop",
  "var_samp",
  "corr",
  "covar_pop",
  "covar_samp",
  "mode",
  "percentile_cont",
  "percentile_disc",
  "rank",
  "dense_rank",
  "row_number",
  "lag",
  "lead",
  "first_value",
  "last_value",
  "nth_value",
  "ntile",
  "cume_dist",
  "percent_rank",
]);

type DerivedOutput = {
  table: string | null;
  column: string | null;
  sensitive: boolean;
};

type ScopeEntry =
  | { kind: "table"; tableName: string; qualifier: string }
  | {
      kind: "derived";
      alias: string;
      outputs: Map<string, DerivedOutput> | null;
      sourceNode: unknown;
    };

type LevelScope = {
  node: Record<string, unknown>;
  entries: ScopeEntry[];
  // Select-list output aliases of this level (ORDER BY prefers them, GROUP
  // BY prefers table columns — PG name resolution, v1 bug-C2 territory).
  aliases: Map<string, DerivedOutput>;
  // True when the level reads from something star expansion cannot
  // enumerate (set-returning functions); bare `*` then denies fail-closed
  // instead of silently dropping columns.
  ungovernable: boolean;
};

type CteDef = { name: string; query: Record<string, unknown> };

type StarColumn = {
  table: string;
  column: string;
  sensitive: boolean;
  outName: string;
  qualifier: string;
};

type Analysis = {
  memo: Map<object, LevelScope>;
  refs: { resolved: ResolvedColumnRef; resTarget: Record<string, unknown> | null; direct: boolean }[];
  stars: {
    level: LevelScope;
    targetList: Record<string, unknown>[];
    index: number;
    qualifier: string | null;
    cols: StarColumn[] | null;
  }[];
  levels: LevelScope[];
};

function rangeVarRelname(item: Record<string, unknown>): string | undefined {
  const relname = item["relname"];
  return typeof relname === "string" ? relname : undefined;
}

function rangeVarAlias(item: Record<string, unknown>): string | undefined {
  const alias = asRecord(item["alias"]);
  const aliasname = alias?.["aliasname"];
  return typeof aliasname === "string" && aliasname.length > 0
    ? aliasname
    : undefined;
}

function collectRangeVars(node: unknown): string[] {
  const names: string[] = [];
  walk(node as never, {
    RangeVar: (path: NodePath) => {
      const rel = rangeVarRelname(
        (path as { node: Record<string, unknown> }).node,
      );
      if (rel !== undefined) names.push(rel);
    },
  });
  return names;
}

// Nearest enclosing SelectStmt ancestor of a walked node plus the nearest
// ResTarget/FuncCall boundary markers on the way up.
function climb(path: NodePath): {
  level: Record<string, unknown> | undefined;
  resTarget: Record<string, unknown> | null;
  direct: boolean;
  func: Record<string, unknown> | null;
} {
  const target = (path as { node: Record<string, unknown> }).node;
  let resTarget: Record<string, unknown> | null = null;
  let func: Record<string, unknown> | null = null;
  let parent = path.parent;
  while (parent !== null) {
    if (resTarget === null && parent.tag === "ResTarget") {
      resTarget = parent.node as Record<string, unknown>;
    }
    if (func === null && parent.tag === "FuncCall") {
      func = parent.node as Record<string, unknown>;
    }
    if (parent.tag === "SelectStmt") {
      return {
        level: parent.node as Record<string, unknown>,
        resTarget,
        // Direct projection hit only when the ColumnRef itself is the
        // select-item value (not nested in an expression or call). The
        // visitor node is the unwrapped inner object while ResTarget.val
        // is the wrapped form, so compare through the normalizer.
        direct:
          resTarget !== null && innerColumnRef(resTarget["val"]) === target,
        func,
      };
    }
    parent = parent.parent;
  }
  return { level: undefined, resTarget, direct: false, func };
}

function classifyClause(keyPath: ReadonlyArray<string | number>, hasFunc: boolean, isAggregate: boolean): Clause {
  if (hasFunc) return isAggregate ? "aggregate" : "funcarg";
  for (let i = keyPath.length - 1; i >= 0; i--) {
    const seg = keyPath[i];
    if (seg === "sortClause") return "order";
    if (seg === "groupClause") return "group";
    if (seg === "havingClause") return "having";
    if (seg === "whereClause") return "where";
    if (seg === "quals") return "join";
    if (seg === "targetList") return "projection";
  }
  // Unknown position (VALUES lists, window frames resolved above): treat as
  // a non-projection clause so sensitive refs deny fail-closed.
  return "where";
}

function funcIsAggregate(func: Record<string, unknown>): boolean {
  if (func["agg_star"] === true) return true;
  const aggOrder = func["agg_order"];
  if (Array.isArray(aggOrder) && aggOrder.length > 0) return true;
  if (func["agg_distinct"] === true) return true;
  if (func["over"] !== undefined && func["over"] !== null) return true;
  const funcname = func["funcname"];
  if (Array.isArray(funcname)) {
    const parts = funcname
      .map(svalText)
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.toLowerCase());
    const last = parts[parts.length - 1];
    if (last !== undefined && AGGREGATE_FUNCTIONS.has(last)) return true;
  }
  return false;
}

class ScopeBuilder {
  readonly memo = new Map<object, LevelScope>();
  readonly levels: LevelScope[] = [];
  constructor(
    readonly catalog: SchemaCatalog,
    readonly extra: Set<string>,
  ) {}

  build(selectNode: Record<string, unknown>, ctes: Map<string, CteDef>): LevelScope {
    const hit = this.memo.get(selectNode);
    if (hit !== undefined) return hit;
    // Set operations: the level has no FROM of its own; ORDER BY/GROUP BY
    // resolve against the left branch outputs.
    if (selectNode["larg"] !== undefined || selectNode["rarg"] !== undefined) {
      const scope: LevelScope = {
        node: selectNode,
        entries: [],
        aliases: new Map(),
        ungovernable: false,
      };
      this.memo.set(selectNode, scope);
      this.levels.push(scope);
      for (const branch of [selectNode["larg"], selectNode["rarg"]]) {
        const inner = asSelectStmt(branch);
        if (inner !== undefined) {
          const innerScope = this.build(inner, ctes);
          if (scope.aliases.size === 0) {
            for (const [k, v] of innerScope.aliases) scope.aliases.set(k, v);
          }
        }
      }
      this.recurseNested(selectNode, ctes, scope);
      return scope;
    }

    const localCtes = new Map<string, CteDef>(ctes);
    const withClause = asRecord(selectNode["withClause"]);
    const cteNodes = withClause?.["ctes"];
    if (Array.isArray(cteNodes)) {
      const siblingNames = new Set<string>();
      const defs: CteDef[] = [];
      for (const entry of cteNodes) {
        const cte = asRecord(asRecord(entry)?.["CommonTableExpr"]);
        const name = cte?.["ctename"];
        const query = asSelectStmt(cte?.["ctequery"]);
        if (typeof name !== "string" || query === undefined) {
          deny("FORBIDDEN_STATEMENT", "Cannot enumerate CTE definition");
        }
        siblingNames.add(name.toLowerCase());
        defs.push({ name, query });
      }
      // Multi-level CTE: any CTE whose subtree reads another visible CTE
      // (sibling, self, or outer) cannot be enumerated — deny fail-closed.
      const visible = new Set<string>([...ctes.keys(), ...siblingNames]);
      for (const def of defs) {
        for (const rel of collectRangeVars(def.query)) {
          if (visible.has(rel.toLowerCase())) {
            deny(
              "FORBIDDEN_STATEMENT",
              `Multi-level CTE reference is not supported: ${rel}`,
            );
          }
        }
      }
      for (const def of defs) localCtes.set(def.name.toLowerCase(), def);
    }

    const scope: LevelScope = {
      node: selectNode,
      entries: [],
      aliases: new Map(),
      ungovernable: false,
    };
    this.memo.set(selectNode, scope);
    this.levels.push(scope);

    const fromClause = selectNode["fromClause"];
    if (Array.isArray(fromClause)) {
      for (const item of fromClause) {
        this.addFromItem(item, scope, localCtes);
      }
    }

    const targetList = selectNode["targetList"];
    if (Array.isArray(targetList)) {
      for (const entry of targetList) {
        const resTarget = asRecord(asRecord(entry)?.["ResTarget"]);
        if (resTarget === undefined) continue;
        const name = resTarget["name"];
        if (typeof name !== "string" || name.length === 0) continue;
        scope.aliases.set(name.toLowerCase(), this.underlyingOf(resTarget["val"], scope));
      }
    }

    // CTE inner scopes (siblings visible; self/sibling refs already denied
    // above so recursion terminates) plus subqueries nested outside FROM
    // (EXISTS / IN / scalar subselects in WHERE and friends).
    if (Array.isArray(cteNodes)) {
      for (const entry of cteNodes) {
        const cte = asRecord(asRecord(entry)?.["CommonTableExpr"]);
        const query = asSelectStmt(cte?.["ctequery"]);
        if (query !== undefined) this.build(query, localCtes);
      }
    }
    this.recurseNested(selectNode, localCtes, scope);
    return scope;
  }

  private recurseNested(
    selectNode: Record<string, unknown>,
    ctes: Map<string, CteDef>,
    self: LevelScope,
  ): void {
    const nested: Record<string, unknown>[] = [];
    walk(selectNode as never, {
      SelectStmt: (path: NodePath) => {
        const node = (path as { node: Record<string, unknown> }).node;
        if (node === selectNode || node === (self.node as unknown)) return;
        let ancestor = (path as NodePath).parent;
        while (ancestor !== null && ancestor.tag !== "SelectStmt") {
          ancestor = ancestor.parent;
        }
        if (
          ancestor !== null &&
          (ancestor.node as Record<string, unknown>) === selectNode
        ) {
          nested.push(node);
        }
      },
    });
    for (const node of nested) this.build(node, ctes);
  }

  private addFromItem(
    item: unknown,
    scope: LevelScope,
    ctes: Map<string, CteDef>,
  ): void {
    // FROM items arrive tag-wrapped ({RangeVar: ...}, {RangeSubselect:
    // ...}, {JoinExpr: ...}); unwrap one level before reading fields.
    const wrapper = asRecord(item);
    if (wrapper === undefined) return;
    const join = asRecord(wrapper["JoinExpr"]);
    if (join !== undefined) {
      // JoinExpr: recurse into both arms; quals belong to this level.
      this.addFromItem(join["larg"], scope, ctes);
      this.addFromItem(join["rarg"], scope, ctes);
      return;
    }
    const sub = asRecord(wrapper["RangeSubselect"]);
    if (sub !== undefined) {
      const alias = rangeVarAlias(sub);
      if (alias === undefined) {
        deny("UNKNOWN_TABLE", "Subquery in FROM must have an alias");
      }
      if (sub["lateral"] === true) {
        this.checkLateral(sub["subquery"], alias);
      }
      const inner = asSelectStmt(sub["subquery"]);
      const outputs =
        inner === undefined ? null : this.enumerateOutputs(inner, ctes);
      scope.entries.push({ kind: "derived", alias, outputs, sourceNode: sub["subquery"] });
      if (inner !== undefined) this.build(inner, ctes);
      return;
    }
    const rangeVar = asRecord(wrapper["RangeVar"]);
    if (rangeVar !== undefined) {
      const relname = rangeVarRelname(rangeVar);
      if (relname === undefined) return;
      const qualifier = rangeVarAlias(rangeVar) ?? relname;
      const cte = ctes.get(relname.toLowerCase());
      if (cte !== undefined) {
        const passthrough = this.passthroughBase(cte, ctes);
        if (passthrough !== undefined) {
          scope.entries.push({
            kind: "table",
            tableName: passthrough,
            qualifier,
          });
        } else {
          scope.entries.push({
            kind: "derived",
            alias: qualifier,
            outputs: this.enumerateOutputs(cte.query, ctes),
            sourceNode: cte.query,
          });
        }
        return;
      }
      const table = lookupTable(this.catalog, relname);
      if (table === undefined) {
        deny("UNKNOWN_TABLE", `Unknown table: ${relname}`);
      }
      scope.entries.push({ kind: "table", tableName: (table as SchemaCatalog["tables"][number]).name, qualifier });
      return;
    }
    // RangeFunction and anything else: star expansion cannot enumerate it,
    // so bare `*` over this level denies fail-closed instead of dropping
    // columns. Qualified refs against it also deny (no scope entry).
    scope.ungovernable = true;
  }

  private checkLateral(subquery: unknown, alias: string): void {
    for (const rel of collectRangeVars(subquery)) {
      const table = lookupTable(this.catalog, rel);
      if (table === undefined) continue;
      const touchesSensitive =
        table.columns.some((c) => c.sensitive) ||
        table.columns.some((c) =>
          this.extra.has(`${table.name.toLowerCase()}.${c.name.toLowerCase()}`),
        );
      if (touchesSensitive) {
        deny(
          "FORBIDDEN_STATEMENT",
          `LATERAL over sensitive table is not supported: ${alias}`,
        );
      }
    }
  }

  // Single-base-table passthrough: the CTE wraps one catalog table with
  // plain columns/stars only, so the CTE name acts as a table alias.
  private passthroughBase(
    cte: CteDef,
    ctes: Map<string, CteDef>,
  ): string | undefined {
    const inner = cte.query;
    if (inner["larg"] !== undefined || inner["rarg"] !== undefined) {
      return undefined;
    }
    const fromClause = inner["fromClause"];
    if (!Array.isArray(fromClause) || fromClause.length !== 1) return undefined;
    const only = asRecord(asRecord(fromClause[0])?.["RangeVar"]);
    if (only === undefined || only["subquery"] !== undefined) {
      return undefined;
    }
    const relname = rangeVarRelname(only);
    if (relname === undefined) return undefined;
    if (ctes.has(relname.toLowerCase())) return undefined;
    const table = lookupTable(this.catalog, relname);
    if (table === undefined) return undefined;
    const targetList = inner["targetList"];
    if (!Array.isArray(targetList)) return undefined;
    for (const entry of targetList) {
      const val = asRecord(asRecord(entry)?.["ResTarget"])?.["val"];
      if (!isPlainColumnRef(val) && !isStarRef(val)) return undefined;
    }
    return table.name;
  }

  private underlyingOf(
    val: unknown,
    scope: LevelScope,
  ): DerivedOutput {
    // Expression outputs hide their inputs only when every column ref
    // inside is traceable and non-sensitive; anything unresolvable or
    // sensitive taints the output fail-closed. Bare aggregates over no
    // columns (count(*)) are not sensitive.
    const refs: Record<string, unknown>[] = [];
    collectColumnRefNodes(val, refs);
    let sensitive = false;
    for (const ref of refs) {
      try {
        if (this.resolveRef(ref, scope, "projection").sensitive) {
          sensitive = true;
          break;
        }
      } catch {
        sensitive = true;
        break;
      }
    }
    if (refs.length > 0) {
      const first = columnRefFields(refs[0]);
      if (refs.length === 1 && first !== undefined && first.length <= 2 && !sensitive) {
        try {
          const resolved = this.resolveRef(refs[0], scope, "projection");
          return { table: resolved.table, column: resolved.column, sensitive: false };
        } catch {
          return { table: null, column: null, sensitive: true };
        }
      }
    }
    return { table: null, column: null, sensitive };
  }

  enumerateOutputs(
    selectNode: Record<string, unknown>,
    ctes: Map<string, CteDef>,
  ): Map<string, DerivedOutput> | null {
    if (selectNode["larg"] !== undefined || selectNode["rarg"] !== undefined) {
      return null;
    }
    const scope = this.build(selectNode, ctes);
    const outputs = new Map<string, DerivedOutput>();
    const targetList = selectNode["targetList"];
    if (!Array.isArray(targetList)) return null;
    for (const entry of targetList) {
      const resTarget = asRecord(asRecord(entry)?.["ResTarget"]);
      if (resTarget === undefined) return null;
      const val = resTarget["val"];
      if (isStarRef(val)) {
        const starCols = this.expandStar(scope, starQualifier(val), ctes);
        if (starCols === null) return null;
        for (const col of starCols) {
          outputs.set(col.outName.toLowerCase(), {
            table: col.table,
            column: col.column,
            sensitive: col.sensitive,
          });
        }
        continue;
      }
      const name = resTarget["name"];
      if (typeof name === "string" && name.length > 0) {
        outputs.set(name.toLowerCase(), this.underlyingOf(val, scope));
        continue;
      }
      if (isPlainColumnRef(val)) {
        const resolved = this.resolveRef(val, scope, "projection");
        outputs.set(resolved.column.toLowerCase(), {
          table: resolved.table,
          column: resolved.column,
          sensitive: resolved.sensitive,
        });
        continue;
      }
      // Unnamed expression output cannot be referenced by name; skip it
      // (refs to anything else still resolve).
    }
    return outputs;
  }

  expandStar(
    scope: LevelScope,
    qualifier: string | null,
    ctes: Map<string, CteDef>,
  ): StarColumn[] | null {
    void ctes;
    if (scope.ungovernable) return null;
    const cols: StarColumn[] = [];
    for (const entry of scope.entries) {
      if (qualifier !== null) {
        const q = qualifier.toLowerCase();
        const matches =
          entry.kind === "table"
            ? entry.qualifier.toLowerCase() === q
            : entry.alias.toLowerCase() === q;
        if (!matches) continue;
      }
      if (entry.kind === "table") {
        const table = lookupTable(this.catalog, entry.tableName);
        if (table === undefined) return null;
        for (const col of table.columns) {
          cols.push({
            table: table.name,
            column: col.name,
            sensitive: isSensitive(table.name, col.name, this.catalog, this.extra),
            outName: col.name,
            // Always qualifier-anchored: bare `*` over a join would turn
            // duplicate column names ambiguous if left unqualified.
            qualifier: entry.qualifier,
          });
        }
      } else {
        if (entry.outputs === null) return null;
        for (const [outName, out] of entry.outputs) {
          cols.push({
            table: out.table ?? entry.alias,
            column: out.column ?? outName,
            sensitive: out.sensitive,
            outName,
            qualifier: entry.alias,
          });
        }
      }
      if (qualifier !== null) break;
    }
    if (qualifier !== null && cols.length === 0) return null;
    return cols;
  }

  resolveRef(
    val: unknown,
    scope: LevelScope,
    clause: Clause,
  ): { table: string; column: string; sensitive: boolean } {
    const fields = columnRefFields(val);
    if (fields === undefined) {
      deny("UNKNOWN_TABLE", "Cannot resolve non-identifier column reference");
    }
    const qualifier = fields.length >= 2 ? (fields[fields.length - 2] as string) : undefined;
    const name = fields[fields.length - 1] as string;
    if (qualifier !== undefined) {
      const q = qualifier.toLowerCase();
      for (const entry of scope.entries) {
        if (entry.kind === "table" && entry.qualifier.toLowerCase() === q) {
          const table = lookupTable(this.catalog, entry.tableName);
          if (table === undefined) deny("UNKNOWN_TABLE", `Unknown table: ${qualifier}`);
          const found = table as SchemaCatalog["tables"][number];
          const col = columnIn(found, name);
          if (col === undefined) deny("UNKNOWN_TABLE", `Unknown column: ${name}`);
          const resolved = col as SchemaCatalog["tables"][number]["columns"][number];
          return {
            table: found.name,
            column: resolved.name,
            sensitive: isSensitive(found.name, resolved.name, this.catalog, this.extra),
          };
        }
        if (entry.kind === "derived" && entry.alias.toLowerCase() === q) {
          if (entry.outputs === null) {
            deny("UNKNOWN_TABLE", `Cannot enumerate subquery outputs: ${qualifier}`);
          }
          const out = (entry.outputs as Map<string, DerivedOutput>).get(name.toLowerCase());
          if (out === undefined) deny("UNKNOWN_TABLE", `Unknown column: ${name}`);
          const output = out as DerivedOutput;
          return {
            table: output.table ?? entry.alias,
            column: output.column ?? name,
            sensitive: output.sensitive,
          };
        }
      }
      deny("UNKNOWN_TABLE", `Unknown qualifier: ${qualifier}`);
    }
    // Unqualified: ORDER BY prefers select-list aliases (PG), every other
    // clause prefers table columns; ambiguity denies fail-closed.
    if (clause === "order") {
      const alias = scope.aliases.get(name.toLowerCase());
      if (alias !== undefined) {
        return {
          table: alias.table ?? name,
          column: alias.column ?? name,
          sensitive: alias.sensitive,
        };
      }
    }
    const candidates: { table: string; column: string; sensitive: boolean }[] = [];
    for (const entry of scope.entries) {
      if (entry.kind === "table") {
        const table = lookupTable(this.catalog, entry.tableName);
        if (table === undefined) continue;
        const col = columnIn(table, name);
        if (col !== undefined) {
          candidates.push({
            table: table.name,
            column: col.name,
            sensitive: isSensitive(table.name, col.name, this.catalog, this.extra),
          });
        }
      } else if (entry.outputs !== null) {
        const out = entry.outputs.get(name.toLowerCase());
        if (out !== undefined) {
          candidates.push({
            table: out.table ?? entry.alias,
            column: out.column ?? name,
            sensitive: out.sensitive,
          });
        }
      }
    }
    if (candidates.length === 1) return candidates[0] as { table: string; column: string; sensitive: boolean };
    if (candidates.length === 0) {
      if (clause === "group" || clause === "order") {
        const alias = scope.aliases.get(name.toLowerCase());
        if (alias !== undefined) {
          return {
            table: alias.table ?? name,
            column: alias.column ?? name,
            sensitive: alias.sensitive,
          };
        }
      }
      deny("UNKNOWN_TABLE", `Unknown column: ${name}`);
    }
    deny("UNKNOWN_TABLE", `Ambiguous column: ${name}`);
  }
}

// Collect every ColumnRef node in a subtree (wrapped or bare) without
// descending into a ColumnRef's own fields. Pushes the wrapped form when
// present so resolveRef sees qualifier context uniformly.
function collectColumnRefNodes(
  node: unknown,
  out: Record<string, unknown>[],
): void {
  const record = asRecord(node);
  if (record === undefined) return;
  if (innerColumnRef(record) !== undefined) {
    out.push(record);
    return;
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) collectColumnRefNodes(item, out);
    } else {
      collectColumnRefNodes(value, out);
    }
  }
}

function isPlainColumnRef(val: unknown): boolean {
  const fields = innerColumnRef(val)?.["fields"];
  if (!Array.isArray(fields) || fields.length === 0) return false;
  return fields.every((f) => typeof svalText(f) === "string");
}

function isStarRef(val: unknown): boolean {
  const fields = innerColumnRef(val)?.["fields"];
  if (!Array.isArray(fields)) return false;
  return fields.some((f) => asRecord(f)?.["A_Star"] !== undefined);
}

function starQualifier(val: unknown): string | null {
  const fields = innerColumnRef(val)?.["fields"];
  if (!Array.isArray(fields) || fields.length !== 2) return null;
  const first = svalText(fields[0]);
  return first ?? null;
}

// Walk visitors receive the tag's inner object (e.g. a ColumnRef visitor
// gets `{fields: ...}`, not `{ColumnRef: {fields: ...}}`), while raw-tree
// reads (ResTarget.val, targetList items) see the wrapped form. Normalize
// both to the inner `{fields: ...}` object.
function innerColumnRef(val: unknown): Record<string, unknown> | undefined {
  const record = asRecord(val);
  if (record === undefined) return undefined;
  if (Array.isArray(record["fields"])) return record;
  const inner = asRecord(record["ColumnRef"]);
  if (inner !== undefined && Array.isArray(inner["fields"])) return inner;
  return undefined;
}

function columnRefFields(val: unknown): string[] | undefined {
  const fields = innerColumnRef(val)?.["fields"];
  if (!Array.isArray(fields)) return undefined;
  if (fields.some((f) => asRecord(f)?.["A_Star"] !== undefined)) return undefined;
  const names: string[] = [];
  for (const field of fields) {
    const text = svalText(field);
    if (text === undefined) return undefined;
    names.push(text);
  }
  if (names.length === 0) return undefined;
  return names;
}

function analyze(
  ast: GuardAst,
  catalog: SchemaCatalog,
  extra: SensitiveEntry[],
): Analysis {
  const stmts = (ast as unknown as { stmts?: unknown }).stmts;
  if (!Array.isArray(stmts) || stmts.length !== 1) {
    deny("FORBIDDEN_STATEMENT", "Policy expects a single-statement AST");
  }
  const root = asSelectStmt(
    (stmts[0] as Record<string, unknown>)["stmt"],
  );
  if (root === undefined) {
    deny("FORBIDDEN_STATEMENT", "Policy expects a SELECT AST");
  }
  const builder = new ScopeBuilder(catalog, extraSet(extra));
  const rootScope = builder.build(root as Record<string, unknown>, new Map());

  const refs: Analysis["refs"] = [];
  const stars: Analysis["stars"] = [];
  walk(ast as never, {
    ColumnRef: (path: NodePath) => {
      const node = (path as { node: Record<string, unknown> }).node;
      const { level, resTarget, direct, func } = climb(path);
      if (level === undefined) {
        deny("FORBIDDEN_STATEMENT", "Column reference outside any SELECT level");
      }
      const scope = builder.memo.get(level as object);
      if (scope === undefined) {
        deny("FORBIDDEN_STATEMENT", "No scope for reference level");
      }
      const rawFields = (node as Record<string, unknown>)["fields"];
      const hasStar =
        Array.isArray(rawFields) &&
        rawFields.some((f) => asRecord(f)?.["A_Star"] !== undefined);
      if (hasStar) return; // Star jobs are collected per SelectStmt below.
      const names = columnRefFields(node);
      if (names === undefined) {
        deny("UNKNOWN_TABLE", "Cannot resolve non-identifier column reference");
      }
      const clause = classifyClause(
        (path as { keyPath: ReadonlyArray<string | number> }).keyPath,
        func !== null,
        func !== null && funcIsAggregate(func),
      );
      const resolved = builder.resolveRef(
        node,
        scope as LevelScope,
        clause,
      );
      refs.push({
        resolved: { ...resolved, clause },
        resTarget,
        direct,
      });
    },
    SelectStmt: (path: NodePath) => {
      const node = (path as { node: Record<string, unknown> }).node;
      const scope = builder.memo.get(node as object);
      if (scope === undefined) return;
      const targetList = node["targetList"];
      if (!Array.isArray(targetList)) return;
      for (let i = 0; i < targetList.length; i++) {
        const resTarget = asRecord(asRecord(targetList[i])?.["ResTarget"]);
        if (resTarget === undefined) continue;
        if (isStarRef(resTarget["val"])) {
          const qualifier = starQualifier(resTarget["val"]);
          stars.push({
            level: scope,
            targetList: targetList as Record<string, unknown>[],
            index: i,
            qualifier,
            cols: builder.expandStar(scope, qualifier, new Map()),
          });
        }
      }
    },
  });
  void rootScope;
  return { memo: builder.memo, refs, stars, levels: builder.levels };
}

/**
 * Resolve every column reference in a parsed AST against the array-of-tables
 * catalog: expands `*`/`t.*`, records `{table, column, clause, sensitive}`
 * per ref. Throws PolicyError (fail-closed) on ambiguous unqualified
 * columns, unknown qualifiers, non-enumerable subquery outputs, multi-level
 * CTEs and LATERAL over sensitive tables.
 */
export function resolveColumns(
  ast: GuardAst,
  catalog: SchemaCatalog,
  extraSensitive: SensitiveEntry[] = DEFAULT_SENSITIVE_COLUMNS.columns,
): ResolvedColumnRef[] {
  const analysis = analyze(ast, catalog, extraSensitive);
  const out = analysis.refs.map((r) => r.resolved);
  // Star expansion records one ref per expanded column so masking and audit
  // see the same refs the rewrite pass acts on.
  for (const job of analysis.stars) {
    if (job.cols === null) {
      throw new PolicyError("UNKNOWN_TABLE", "Cannot enumerate star expansion");
    }
    for (const col of job.cols) {
      out.push({
        table: col.table,
        column: col.column,
        clause: "projection",
        sensitive: col.sensitive,
      });
    }
  }
  return out;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function maskingFragment(
  qualifier: string | undefined,
  column: string,
  columnType: string | undefined,
): string {
  const ref =
    qualifier !== undefined
      ? `${quoteIdent(qualifier)}.${quoteIdent(column)}`
      : quoteIdent(column);
  if (columnType !== undefined && /char|text|cite|name|clob/i.test(columnType)) {
    return `left(${ref}, 3) || '****'`;
  }
  if (columnType !== undefined) {
    return `CAST(NULL AS ${columnType})`;
  }
  throw new PolicyError(
    "FORBIDDEN_STATEMENT",
    `Cannot mask column without a known type: ${column}`,
  );
}

function fragmentVal(fragmentSql: string): Promise<unknown> {
  return parse(`SELECT ${fragmentSql}`).then(
    (frag) => {
      const targetList = (
        frag as unknown as {
          stmts: { stmt: { SelectStmt: { targetList: { ResTarget: { val: unknown } }[] } } }[];
        }
      ).stmts[0]?.stmt.SelectStmt.targetList;
      if (!Array.isArray(targetList) || targetList.length !== 1) {
        throw new PolicyError("FORBIDDEN_STATEMENT", "Masking fragment failed to parse");
      }
      return targetList[0]?.ResTarget.val;
    },
    (error) => {
      throw new PolicyError(
        "FORBIDDEN_STATEMENT",
        `Masking fragment failed to parse: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
}

function rowScopeTables(
  rowScope: NonNullable<Principal["rowScope"]>,
  catalog: SchemaCatalog,
): string[] {
  if (rowScope.table !== undefined) return [rowScope.table.toLowerCase()];
  const tables: string[] = [];
  for (const table of catalog.tables) {
    if (table.columns.some((c) => c.name.toLowerCase() === rowScope.column.toLowerCase())) {
      tables.push(table.name.toLowerCase());
    }
  }
  return tables;
}

export class ColumnScopePolicy implements AccessPolicy {
  readonly name = "ColumnScopePolicy";
  private readonly extra: SensitiveEntry[];

  constructor(extraSensitive: SensitiveEntry[] = DEFAULT_SENSITIVE_COLUMNS.columns) {
    this.extra = extraSensitive.map((e) => ({ ...e }));
    Object.freeze(this.extra);
  }

  async check(input: {
    ast: GuardAst;
    sql: string;
    catalog: SchemaCatalog;
    principal: Principal;
  }): Promise<PolicyResult> {
    const { ast, sql, catalog, principal } = input;
    let analysis: Analysis;
    try {
      analysis = analyze(ast, catalog, this.extra);
    } catch (error) {
      if (error instanceof PolicyError) {
        return { allowed: false, error: dbToolError(error.code, error.message) };
      }
      throw error;
    }

    const hasSensitive = principal.scopes.includes("data:sensitive");

    const denySensitive = (table: string, column: string, clause: Clause): PolicyResult => ({
      allowed: false,
      error: dbToolError(
        "SENSITIVE_COLUMN_DENIED",
        `Sensitive column without data:sensitive: ${table}.${column} in ${clause}`,
      ),
    });

    // Clause/aggregate violations abort before any rewrite.
    if (!hasSensitive) {
      for (const ref of analysis.refs) {
        if (!ref.resolved.sensitive) continue;
        if (ref.resolved.clause !== "projection" || !ref.direct) {
          return denySensitive(ref.resolved.table, ref.resolved.column, ref.resolved.clause);
        }
      }
    }

    let mutated = false;
    const maskedColumns = new Set<string>();

    // Star expansion first (only stars that would expose sensitive columns
    // without data:sensitive are rewritten; the rest stay byte-identical).
    if (!hasSensitive) {
      try {
        await this.expandSensitiveStars(analysis, catalog, maskedColumns);
        await this.maskDirectRefs(analysis, catalog, maskedColumns);
        mutated = maskedColumns.size > 0;
      } catch (error) {
        if (error instanceof PolicyError) {
          return { allowed: false, error: dbToolError(error.code, error.message) };
        }
        throw error;
      }
    }

    // Row-scope predicates, injected per query level whose FROM directly
    // includes a scoped table (hand-built equality on the level's alias or
    // bare name). Opaque or ambiguous placement denies FORBIDDEN_STATEMENT.
    if (principal.rowScope !== undefined && principal.rowScope !== null) {
      const scoped = rowScopeTables(principal.rowScope, catalog);
      if (scoped.length > 0) {
        const injection = this.injectRowScopes(analysis.levels, principal.rowScope, scoped);
        if (injection === "deny-opaque") {
          return {
            allowed: false,
            error: dbToolError(
              "FORBIDDEN_STATEMENT",
              "Row-scope table is referenced opaquely",
            ),
          };
        }
        if (injection === "deny-ambiguous") {
          return {
            allowed: false,
            error: dbToolError(
              "FORBIDDEN_STATEMENT",
              "Row-scope placement is ambiguous",
            ),
          };
        }
        if (injection) mutated = true;
      }
    }

    if (!mutated) {
      return { allowed: true, sql, maskedColumns: [] };
    }

    let finalSql: string;
    try {
      finalSql = await deparse(ast);
    } catch {
      return {
        allowed: false,
        error: dbToolError("FORBIDDEN_STATEMENT", "Policy rewrite failed to render"),
      };
    }
    let reparsed: GuardAst;
    try {
      reparsed = await parse(finalSql);
    } catch {
      return {
        allowed: false,
        error: dbToolError("FORBIDDEN_STATEMENT", "Policy rewrite failed to re-parse"),
      };
    }
    const reguard = await sqlGuard(finalSql, catalog);
    if (!reguard.ok) {
      return { allowed: false, error: reguard.error };
    }
    void reparsed;
    return {
      allowed: true,
      sql: finalSql,
      maskedColumns: [...maskedColumns].sort(),
    };
  }

  private async expandSensitiveStars(
    analysis: Analysis,
    catalog: SchemaCatalog,
    maskedColumns: Set<string>,
  ): Promise<void> {
    // Splice each star list once, descending by index so splices stay valid.
    const byList = new Map<Record<string, unknown>[], Analysis["stars"]>();
    for (const job of analysis.stars) {
      const list = byList.get(job.targetList);
      if (list !== undefined) list.push(job);
      else byList.set(job.targetList, [job]);
    }
    for (const [targetList, jobs] of byList) {
      const ordered = [...jobs].sort((a, b) => b.index - a.index);
      for (const job of ordered) {
        if (job.cols === null) {
          throw new PolicyError("UNKNOWN_TABLE", "Cannot enumerate star expansion");
        }
        if (!job.cols.some((c) => c.sensitive)) continue;
        const items: Record<string, unknown>[] = [];
        for (const col of job.cols) {
          if (col.sensitive) {
            const table = lookupTable(catalog, col.table);
            const columnType =
              table !== undefined ? columnIn(table, col.column)?.type : undefined;
            const val = await fragmentVal(
              maskingFragment(col.qualifier, col.column, columnType),
            );
            items.push({ ResTarget: { name: col.outName, val } });
            maskedColumns.add(`${col.table.toLowerCase()}.${col.column.toLowerCase()}`);
          } else {
            const val = await fragmentVal(
              `${quoteIdent(col.qualifier)}.${quoteIdent(col.column)}`,
            );
            items.push({ ResTarget: { name: col.outName, val } });
          }
        }
        targetList.splice(job.index, 1, ...items);
      }
    }
  }

  private async maskDirectRefs(
    analysis: Analysis,
    catalog: SchemaCatalog,
    maskedColumns: Set<string>,
  ): Promise<void> {
    for (const ref of analysis.refs) {
      if (!ref.resolved.sensitive) continue;
      if (ref.resolved.clause !== "projection" || !ref.direct) continue;
      if (ref.resTarget === null) continue;
      // Star-expanded items created above are already masked; skip nodes
      // that no longer sit under a live plain-ColumnRef value slot.
      const current = ref.resTarget["val"] as unknown;
      if (!isPlainColumnRef(current)) continue;
      const table = lookupTable(catalog, ref.resolved.table);
      const columnType =
        table !== undefined ? columnIn(table, ref.resolved.column)?.type : undefined;
      const qualifier = columnRefQualifier(current);
      const val = await fragmentVal(
        maskingFragment(qualifier ?? undefined, ref.resolved.column, columnType),
      );
      ref.resTarget["val"] = val;
      if (typeof ref.resTarget["name"] !== "string") {
        ref.resTarget["name"] = ref.resolved.column;
      }
      maskedColumns.add(
        `${ref.resolved.table.toLowerCase()}.${ref.resolved.column.toLowerCase()}`,
      );
    }
  }

  // Returns true when a predicate was injected, false when no level names a
  // scoped table, or a deny string when placement is impossible.
  private injectRowScopes(
    levels: LevelScope[],
    rowScope: NonNullable<Principal["rowScope"]>,
    scoped: string[],
  ): boolean | "deny-opaque" | "deny-ambiguous" {
    let injected = false;
    for (const level of levels) {
      const direct = level.entries.filter(
        (e): e is Extract<ScopeEntry, { kind: "table" }> =>
          e.kind === "table" && scoped.includes(e.tableName.toLowerCase()),
      );
      const byTable = new Map<string, typeof direct>();
      for (const entry of direct) {
        const list = byTable.get(entry.tableName.toLowerCase()) ?? [];
        list.push(entry);
        byTable.set(entry.tableName.toLowerCase(), list);
      }
      for (const list of byTable.values()) {
        if (list.length > 1) return "deny-ambiguous";
      }
      for (const entry of direct) {
        const predicate = {
          A_Expr: {
            kind: "AEXPR_OP",
            name: [{ String: { sval: "=" } }],
            lexpr: {
              ColumnRef: {
                fields: [
                  { String: { sval: entry.qualifier } },
                  { String: { sval: rowScope.column } },
                ],
              },
            },
            rexpr: {
              A_Const: { sval: { sval: rowScope.value } },
            },
          },
        };
        const where = level.node["whereClause"] as unknown;
        if (where === undefined || where === null) {
          level.node["whereClause"] = predicate;
        } else {
          level.node["whereClause"] = {
            BoolExpr: { boolop: "AND_EXPR", args: [where, predicate] },
          };
        }
        injected = true;
      }
      // Opaque placement: a non-enumerable derived entry built over a scoped
      // table hides the predicate column — deny instead of guessing.
      for (const entry of level.entries) {
        if (entry.kind !== "derived" || entry.outputs !== null) continue;
        for (const rel of collectRangeVars(entry.sourceNode)) {
          if (scoped.includes(rel.toLowerCase())) return "deny-opaque";
        }
      }
    }
    return injected;
  }
}

function columnRefQualifier(val: unknown): string | null {
  const fields = columnRefFields(val);
  if (fields === undefined || fields.length < 2) return null;
  return fields[fields.length - 2] as string;
}
