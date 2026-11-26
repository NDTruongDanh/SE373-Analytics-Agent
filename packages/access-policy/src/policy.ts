import { walk } from "@pgsql/traverse";
import type { NodePath } from "@pgsql/traverse";
import { deparse, parse } from "pgsql-parser";
import type { DbToolError, ErrorCode, SchemaCatalog } from "@shared/contracts";
import { dbToolError, type RowScopeApplied } from "@shared/contracts";
import { sqlGuard } from "./guard.js";
import type { GuardAst } from "./guard.js";
import { DEFAULT_SENSITIVE_COLUMNS } from "./sensitive-columns.js";
import {
  DEFAULT_ROW_SCOPE_LINEAGE,
  type LineageEntry,
  type RowScopeLineage,
} from "./row-scope-lineage.js";

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
  | {
      allowed: true;
      sql: string;
      maskedColumns: string[];
      rowScopeApplied: RowScopeApplied[];
    }
  | { allowed: false; error: DbToolError };

export { RowScopeAppliedSchema, type RowScopeApplied } from "@shared/contracts";

export interface AccessPolicy {
  readonly name: string;
  check(input: {
    ast: GuardAst;
    sql: string;
    catalog: SchemaCatalog;
    principal: Principal;
  }): Promise<PolicyResult>;
}

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

// AST flags (agg_star/agg_distinct/over) miss plain aggregate calls like count(col), so check known names too.
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
  | { kind: "table"; tableName: string; qualifier: string; cte?: boolean }
  | {
      kind: "derived";
      alias: string;
      outputs: Map<string, DerivedOutput> | null;
      sourceNode: unknown;
    };

type LevelScope = {
  node: Record<string, unknown>;
  entries: ScopeEntry[];
  // Select-list aliases: ORDER BY prefers these, whereas GROUP BY prefers table columns (PG resolution order).
  aliases: Map<string, DerivedOutput>;
  // Set when FROM has unenumerable sources (e.g. SRFs) so bare * denies fail-closed instead of dropping columns.
  ungovernable: boolean;
  // Enclosing level of a WHERE/HAVING/SELECT-list subquery, searched for correlated references.
  parent?: LevelScope;
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
        // Direct projection only when ColumnRef is the bare ResTarget.val; normalize because visitor nodes are unwrapped.
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
  // Unknown clause positions default to non-projection so sensitive refs deny fail-closed.
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

  build(
    selectNode: Record<string, unknown>,
    ctes: Map<string, CteDef>,
    parent?: LevelScope,
  ): LevelScope {
    const hit = this.memo.get(selectNode);
    if (hit !== undefined) return hit;
    // Set operations have no FROM of their own; ORDER BY/GROUP BY resolve against the left branch.
    if (selectNode["larg"] !== undefined || selectNode["rarg"] !== undefined) {
      const scope: LevelScope = {
        node: selectNode,
        entries: [],
        aliases: new Map(),
        ungovernable: false,
        ...(parent !== undefined ? { parent } : {}),
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
      // Deny multi-level/recursive CTEs fail-closed because their outputs cannot be safely enumerated.
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
      ...(parent !== undefined ? { parent } : {}),
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

    // Build CTE inner scopes (termination guaranteed by multi-level check above) and non-FROM nested subqueries.
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
    const nested: { node: Record<string, unknown>; sublink: boolean }[] = [];
    // The walker only recognizes tagged nodes, so wrap the level to make it a SelectStmt ancestor.
    walk({ SelectStmt: selectNode } as never, {
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
          nested.push({ node, sublink: (path as NodePath).parent?.tag === "SubLink" });
        }
      },
    });
    for (const { node, sublink } of nested) this.build(node, ctes, sublink ? self : undefined);
  }

  private addFromItem(
    item: unknown,
    scope: LevelScope,
    ctes: Map<string, CteDef>,
  ): void {
    // FROM items arrive tag-wrapped ({RangeVar}, {RangeSubselect}, {JoinExpr}); unwrap one level.
    const wrapper = asRecord(item);
    if (wrapper === undefined) return;
    const join = asRecord(wrapper["JoinExpr"]);
    if (join !== undefined) {
      // Join quals resolve against the enclosing level.
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
            cte: true,
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
    // Mark unenumerable FROM items (e.g. RangeFunction) ungovernable so * and refs against them fail closed.
    scope.ungovernable = true;
  }

  // Single-table passthrough CTEs act as a direct table alias when projecting only plain columns or stars.
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
    // Derived expressions are non-sensitive only if every inner column ref resolves as non-sensitive;
    // unresolvable refs taint fail-closed, while bare aggregates like count(*) stay non-sensitive.
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
      // Unnamed expression outputs cannot be referenced by name; skip without failing other outputs.
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
            // Always qualify expanded star columns so joins with duplicate column names stay unambiguous on rewrite.
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
      if (scope.parent !== undefined) return this.resolveRef(val, scope.parent, "where");
      deny("UNKNOWN_TABLE", `Unknown qualifier: ${qualifier}`);
    }
    // PG name resolution: ORDER BY checks select-list aliases first, other clauses check FROM sources first.
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
      if (scope.parent !== undefined) return this.resolveRef(val, scope.parent, "where");
      deny("UNKNOWN_TABLE", `Unknown column: ${name}`);
    }
    deny("UNKNOWN_TABLE", `Ambiguous column: ${name}`);
  }
}

// Collect ColumnRef nodes without descending into their fields, preserving wrapper form for resolveRef.
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
  // Subquery columns are resolved and policed at their own level, not against this one.
  if (record["SubLink"] !== undefined) return;
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

// Normalize both unwrapped visitor ColumnRef nodes and wrapped raw-AST ColumnRefs to { fields }.
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

// Read-only SELECT node vocabulary; any other parse-tree node denies, so new syntax fails closed.
const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  "A_ArrayExpr",
  "A_Const",
  "A_Expr",
  "A_Indices",
  "A_Indirection",
  "A_Star",
  "Alias",
  "BitString",
  "BoolExpr",
  "Boolean",
  "BooleanTest",
  "CaseExpr",
  "CaseWhen",
  "CoalesceExpr",
  "CollateClause",
  "ColumnRef",
  "CommonTableExpr",
  "Float",
  "FuncCall",
  "GroupingSet",
  "Integer",
  "JoinExpr",
  "List",
  "MinMaxExpr",
  "NamedArgExpr",
  "NullTest",
  "RangeSubselect",
  "RangeVar",
  "ResTarget",
  "RowExpr",
  "SQLValueFunction",
  "SelectStmt",
  "SortBy",
  "String",
  "SubLink",
  "TypeCast",
  "TypeName",
  "WindowDef",
  "WithClause",
]);

const NODE_TAG = /^[A-Z][A-Za-z_]*$/;

function assertAllowedNodes(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertAllowedNodes(item);
    return;
  }
  const record = asRecord(node);
  if (record === undefined) return;
  for (const [key, value] of Object.entries(record)) {
    if (NODE_TAG.test(key) && typeof value === "object" && value !== null) {
      if (!ALLOWED_NODE_TYPES.has(key)) {
        deny("FORBIDDEN_STATEMENT", `SQL construct is not allowed: ${key}`);
      }
      const inner = value as Record<string, unknown>;
      if (key === "SelectStmt" && Array.isArray(inner["valuesLists"]) && inner["valuesLists"].length > 0) {
        deny("FORBIDDEN_STATEMENT", "VALUES lists are not allowed");
      }
      if (inner["lateral"] === true) {
        deny("FORBIDDEN_STATEMENT", "LATERAL is not allowed");
      }
    }
    assertAllowedNodes(value);
  }
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
  for (const stmt of stmts) assertAllowedNodes((stmt as Record<string, unknown>)["stmt"]);
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
      // A subquery's own select list feeds a comparison, not the result, so masking would still leak.
      const inSubquery = (scope as LevelScope).parent !== undefined;
      refs.push({
        resolved: { ...resolved, clause: inSubquery && clause === "projection" ? "where" : clause },
        resTarget,
        direct: direct && !inSubquery,
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

export function resolveColumns(
  ast: GuardAst,
  catalog: SchemaCatalog,
  extraSensitive: SensitiveEntry[] = DEFAULT_SENSITIVE_COLUMNS.columns,
): ResolvedColumnRef[] {
  const analysis = analyze(ast, catalog, extraSensitive);
  const out = analysis.refs.map((r) => r.resolved);
  // Include star-expanded columns so audit and callers see the same refs the rewrite pass governs.
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

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function lineageEntry(
  tables: Record<string, LineageEntry>,
  table: string,
): LineageEntry | undefined {
  if (table in tables) return tables[table];
  const lowered = table.toLowerCase();
  for (const [name, entry] of Object.entries(tables)) {
    if (name.toLowerCase() === lowered) return entry;
  }
  return undefined;
}

function scopedKeySubquery(
  table: string,
  keyColumn: string,
  tables: Record<string, LineageEntry>,
  rowScope: NonNullable<Principal["rowScope"]>,
): string {
  const entry = lineageEntry(tables, table);
  const select = `SELECT ${quoteIdent(keyColumn)} FROM ${quoteIdent(table)}`;
  if (entry === "direct") {
    return `${select} WHERE ${quoteIdent(rowScope.column)} = ${sqlLiteral(rowScope.value)}`;
  }
  if (entry === undefined || entry === "global") {
    throw new PolicyError("FORBIDDEN_STATEMENT", `Row-scope lineage is broken at ${table}`);
  }
  return `${select} WHERE ${quoteIdent(entry.column)} IN (${scopedKeySubquery(entry.via, entry.parentColumn, tables, rowScope)})`;
}

async function whereFragment(predicateSql: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = await parse(`SELECT 1 WHERE ${predicateSql}`);
  } catch (error) {
    throw new PolicyError(
      "FORBIDDEN_STATEMENT",
      `Row-scope predicate failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const select = asSelectStmt(
    (parsed as { stmts?: { stmt?: unknown }[] }).stmts?.[0]?.stmt,
  );
  const where = select?.["whereClause"];
  if (where === undefined) {
    throw new PolicyError("FORBIDDEN_STATEMENT", "Row-scope predicate failed to parse");
  }
  return where;
}

function andWhere(node: Record<string, unknown>, key: "whereClause" | "havingClause", predicate: unknown): void {
  const existing = node[key] as unknown;
  node[key] =
    existing === undefined || existing === null
      ? predicate
      : { BoolExpr: { boolop: "AND_EXPR", args: [existing, predicate] } };
}

export const MIN_GROUP_SIZE = 5;

export class ColumnScopePolicy implements AccessPolicy {
  readonly name = "ColumnScopePolicy";
  private readonly extra: SensitiveEntry[];
  private readonly lineage: RowScopeLineage;

  constructor(
    extraSensitive: SensitiveEntry[] = DEFAULT_SENSITIVE_COLUMNS.columns,
    lineage: RowScopeLineage = DEFAULT_ROW_SCOPE_LINEAGE,
  ) {
    this.extra = extraSensitive.map((e) => ({ ...e }));
    Object.freeze(this.extra);
    this.lineage = structuredClone(lineage);
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

    // Expand only stars exposing sensitive columns so non-sensitive queries stay byte-identical.
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

    // Inject server-minted row-scope predicates per level and record table/column only (never values).
    const rowScopeApplied: RowScopeApplied[] = [];
    try {
      if (principal.rowScope !== undefined && principal.rowScope !== null) {
        const lineage = Object.entries(this.lineage.scopes).find(
          ([column]) => column.toLowerCase() === principal.rowScope?.column.toLowerCase(),
        )?.[1];
        if (lineage === undefined) {
          throw new PolicyError(
            "FORBIDDEN_STATEMENT",
            `No row-scope lineage declared for ${principal.rowScope.column}`,
          );
        }
        if (await this.injectRowScopes(analysis.levels, principal.rowScope, lineage.tables, rowScopeApplied)) {
          mutated = true;
        }
      }
      // Small groups can re-identify people, so roles without data:sensitive only see groups of MIN_GROUP_SIZE+.
      if (!hasSensitive && (await this.applyGroupSizeFloor(analysis.levels[0]?.node))) {
        mutated = true;
      }
    } catch (error) {
      if (error instanceof PolicyError) {
        return { allowed: false, error: dbToolError(error.code, error.message) };
      }
      throw error;
    }

    if (!mutated) {
      return { allowed: true, sql, maskedColumns: [], rowScopeApplied: [] };
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
    const byScope = (a: RowScopeApplied, b: RowScopeApplied): number =>
      a.table < b.table ? -1 : a.table > b.table ? 1 : a.column < b.column ? -1 : a.column > b.column ? 1 : 0;
    return {
      allowed: true,
      sql: finalSql,
      maskedColumns: [...maskedColumns].sort(),
      rowScopeApplied: [...rowScopeApplied].sort(byScope),
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
        if (job.level.parent !== undefined) {
          throw new PolicyError(
            "SENSITIVE_COLUMN_DENIED",
            "Sensitive column without data:sensitive: star inside a subquery",
          );
        }
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
      // Skip items already rewritten by expandSensitiveStars (no longer a plain ColumnRef).
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

  private async injectRowScopes(
    levels: LevelScope[],
    rowScope: NonNullable<Principal["rowScope"]>,
    tables: Record<string, LineageEntry>,
    applied: RowScopeApplied[],
  ): Promise<boolean> {
    let injected = false;
    for (const level of levels) {
      const direct = new Map<string, number>();
      for (const entry of level.entries) {
        if (entry.kind !== "table") continue;
        const lineage = lineageEntry(tables, entry.tableName);
        if (lineage === undefined) {
          deny("FORBIDDEN_STATEMENT", `Table has no row-scope lineage: ${entry.tableName}`);
        }
        // A pass-through CTE is scoped inside its own query level and may not expose the scope column.
        if (lineage === "global" || entry.cte === true) continue;
        const table = entry.tableName.toLowerCase();
        let predicateSql: string;
        if (lineage === "direct") {
          direct.set(table, (direct.get(table) ?? 0) + 1);
          if ((direct.get(table) ?? 0) > 1) {
            deny("FORBIDDEN_STATEMENT", "Row-scope placement is ambiguous");
          }
          predicateSql = `${quoteIdent(entry.qualifier)}.${quoteIdent(rowScope.column)} = ${sqlLiteral(rowScope.value)}`;
        } else {
          predicateSql =
            `${quoteIdent(entry.qualifier)}.${quoteIdent(lineage.column)} IN ` +
            `(${scopedKeySubquery(lineage.via, lineage.parentColumn, tables, rowScope)})`;
        }
        applied.push({ table, column: rowScope.column });
        andWhere(level.node, "whereClause", await whereFragment(predicateSql));
        injected = true;
      }
      // A non-enumerable derived source over a scoped table hides where the predicate must go.
      for (const entry of level.entries) {
        if (entry.kind !== "derived" || entry.outputs !== null) continue;
        for (const rel of collectRangeVars(entry.sourceNode)) {
          if (lineageEntry(tables, rel) !== "global") {
            deny("FORBIDDEN_STATEMENT", "Row-scope table is referenced opaquely");
          }
        }
      }
    }
    return injected;
  }

  private async applyGroupSizeFloor(node: Record<string, unknown> | undefined): Promise<boolean> {
    if (node === undefined) return false;
    if (node["larg"] !== undefined || node["rarg"] !== undefined) {
      const left = await this.applyGroupSizeFloor(asSelectStmt(node["larg"]));
      const right = await this.applyGroupSizeFloor(asSelectStmt(node["rarg"]));
      return left || right;
    }
    const group = node["groupClause"];
    if (!Array.isArray(group) || group.length === 0) return false;
    let parsed: unknown;
    try {
      parsed = await parse(`SELECT 1 HAVING count(*) >= ${MIN_GROUP_SIZE}`);
    } catch {
      throw new PolicyError("FORBIDDEN_STATEMENT", "Group-size floor failed to parse");
    }
    const having = asSelectStmt(
      (parsed as { stmts?: { stmt?: unknown }[] }).stmts?.[0]?.stmt,
    )?.["havingClause"];
    andWhere(node, "havingClause", having);
    return true;
  }
}

function columnRefQualifier(val: unknown): string | null {
  const fields = columnRefFields(val);
  if (fields === undefined || fields.length < 2) return null;
  return fields[fields.length - 2] as string;
}
