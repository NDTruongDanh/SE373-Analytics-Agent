import { walk } from "@pgsql/traverse";
import type { NodePath } from "@pgsql/traverse";
export { deparse, parse } from "pgsql-parser";
import { parse } from "pgsql-parser";
import type { DbToolError, SchemaCatalog } from "@shared/contracts";
import { dbToolError } from "@shared/contracts";
import { FORBIDDEN_FUNCTION_SET, SYSTEM_SCHEMA_SET } from "./denylist.js";

// Derived from pgsql-parser's return type so downstream stages reuse the AST without naming a transitive package.
export type GuardAst = Awaited<ReturnType<typeof parse>>;

export type GuardSuccess = {
  ok: true;
  tables: string[];
  columns: string[];
  ast: GuardAst;
};

export type GuardFailure = {
  ok: false;
  error: DbToolError;
};

export type GuardResult = GuardSuccess | GuardFailure;

// Async parse initializes libpg_query WASM once; call at boot/test setup and never use parseSync on request paths.
export async function warmupSqlGuard(): Promise<void> {
  await parse("SELECT 1");
}

// Root is already SelectStmt, but DML can nest in CTEs (WITH x AS (DELETE ...)) and utility tags are denied fail-closed.
const DENIED_STATEMENT_TAGS: ReadonlySet<string> = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "CopyStmt",
  "TruncateStmt",
  "TransactionStmt",
  "VariableSetStmt",
  "VariableShowStmt",
  "DiscardStmt",
  "CreateStmt",
  "DropStmt",
  "AlterStmt",
  "AlterTableStmt",
  "RenameStmt",
  "GrantStmt",
  "CommentStmt",
  "ExplainStmt",
  "PrepareStmt",
  "ExecuteStmt",
  "DeallocateStmt",
  "CallStmt",
  "DoStmt",
  "ListenStmt",
  "NotifyStmt",
  "LockStmt",
  "VacuumStmt",
  "CheckPointStmt",
  "ReindexStmt",
  "ClusterStmt",
]);

type CollectedRangeVar = { schema?: string; name: string };
type CollectedColumnRef = {
  qualifier?: string;
  name: string;
  // Unqualified ORDER BY/GROUP BY ref matching a select-list alias resolves against the select list, not a table.
  aliasExempt: boolean;
  // Unqualified ORDER BY/GROUP BY ref eligible for the FROM-subquery-output fallback.
  sortGroupPosition: boolean;
};

type SubquerySource = { alias: string; subquery: unknown };

function svalText(field: unknown): string | undefined {
  if (typeof field !== "object" || field === null) return undefined;
  const stringNode = (field as Record<string, unknown>)["String"] as
    | { sval?: unknown }
    | undefined;
  return typeof stringNode?.sval === "string" ? stringNode.sval : undefined;
}

function resTargetAliasNames(
  selectNode: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const targetList = selectNode["targetList"];
  if (!Array.isArray(targetList)) return names;
  for (const entry of targetList) {
    const resTarget =
      typeof entry === "object" && entry !== null
        ? (entry as { ResTarget?: unknown }).ResTarget
        : undefined;
    const name =
      typeof resTarget === "object" && resTarget !== null
        ? (resTarget as { name?: unknown }).name
        : undefined;
    if (typeof name === "string" && name.length > 0) {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

function enclosingSelect(path: NodePath): {
  select: Record<string, unknown>;
  clauseKey: string | undefined;
} | undefined {
  let child: NodePath | null = path;
  let parent = path.parent;
  while (parent !== null) {
    if (parent.tag === "SelectStmt") {
      const keyPath = child.keyPath;
      const raw = keyPath.length >= 2 ? keyPath[keyPath.length - 2] : undefined;
      return {
        select: parent.node as Record<string, unknown>,
        clauseKey: typeof raw === "string" ? raw : undefined,
      };
    }
    child = parent;
    parent = parent.parent;
  }
  return undefined;
}

// Unwrap a SelectStmt that may arrive bare (e.g. larg) or wrapped as { SelectStmt: ... }.
function asSelectStmt(node: unknown): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record["targetList"]) || record["larg"] !== undefined) {
    return record;
  }
  return asSelectStmt(record["SelectStmt"]);
}

function columnRefLastField(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const columnRef = (node as { ColumnRef?: unknown }).ColumnRef;
  if (typeof columnRef !== "object" || columnRef === null) return undefined;
  const fields = (columnRef as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return undefined;
  const names = fields
    .map(svalText)
    .filter((s): s is string => typeof s === "string");
  if (names.length !== fields.length || names.length === 0) return undefined;
  return names[names.length - 1];
}

// Returns null for non-enumerable subqueries (star, unaliased expr, setop) so refs fall through to fail-closed catalog checks.
function subqueryOutputColumns(subquery: unknown): string[] | null {
  const select = asSelectStmt(subquery);
  if (select === undefined) return null;
  if (select["larg"] !== undefined || select["rarg"] !== undefined) {
    return null;
  }
  const targetList = select["targetList"];
  if (!Array.isArray(targetList)) return null;
  const names: string[] = [];
  for (const entry of targetList) {
    const resTarget =
      typeof entry === "object" && entry !== null
        ? (entry as { ResTarget?: unknown }).ResTarget
        : undefined;
    if (typeof resTarget !== "object" || resTarget === null) return null;
    const typed = resTarget as { name?: unknown; val?: unknown };
    if (typeof typed.name === "string" && typed.name.length > 0) {
      names.push(typed.name.toLowerCase());
      continue;
    }
    const derived = columnRefLastField(typed.val);
    if (derived === undefined) return null;
    names.push(derived.toLowerCase());
  }
  return names;
}

export async function sqlGuard(
  sql: string,
  catalog: SchemaCatalog,
): Promise<GuardResult> {
  if (sql.trim().length === 0) {
    return {
      ok: false,
      error: dbToolError("INVALID_SQL", "Invalid SQL at character 0", 0),
    };
  }
  let ast: GuardAst;
  try {
    ast = await parse(sql);
  } catch (e) {
    const pos = (e as { sqlDetails?: { cursorPosition?: unknown } })
      .sqlDetails?.cursorPosition;
    const numericPos = typeof pos === "number" ? pos : undefined;
    const where = numericPos !== undefined ? ` at character ${numericPos}` : "";
    return {
      ok: false,
      error: dbToolError("INVALID_SQL", `Invalid SQL${where}`, numericPos),
    };
  }

  const stmts = ast.stmts ?? [];
  if (stmts.length !== 1) {
    return {
      ok: false,
      error: dbToolError(
        "FORBIDDEN_STATEMENT",
        "Only a single statement is allowed",
      ),
    };
  }
  const rootTag = Object.keys(stmts[0]?.stmt ?? {})[0];
  if (rootTag !== "SelectStmt") {
    return {
      ok: false,
      error: dbToolError(
        "FORBIDDEN_STATEMENT",
        "Only SELECT/WITH queries are allowed",
      ),
    };
  }

  // Collect refs for post-walk validation because CTE names must be known before judging FROM refs across walk order.
  const cteNames = new Set<string>();
  const rangeVars: CollectedRangeVar[] = [];
  const columnRefs: CollectedColumnRef[] = [];
  const subqueries: SubquerySource[] = [];
  const aliasToTable = new Map<string, string>();

  const deniedVisitors: Record<string, (path: unknown, ctx: unknown) => void> =
    {};
  for (const tag of DENIED_STATEMENT_TAGS) {
    deniedVisitors[tag] = (_path, ctx) => {
      (ctx as { abort: (reason: string) => void }).abort(
        `FORBIDDEN_STATEMENT:${tag}`,
      );
    };
  }

  const result = walk(ast, {
    ...deniedVisitors,
    SelectStmt: (path, ctx) => {
      const node = (path as { node: Record<string, unknown> }).node;
      if (node["intoClause"] !== undefined && node["intoClause"] !== null) {
        (ctx as { abort: (r: string) => void }).abort(
          "FORBIDDEN_STATEMENT:SELECT_INTO",
        );
      }
      if (
        node["lockingClause"] !== undefined &&
        node["lockingClause"] !== null
      ) {
        (ctx as { abort: (r: string) => void }).abort(
          "FORBIDDEN_STATEMENT:FOR_UPDATE",
        );
      }
    },
    CommonTableExpr: (path) => {
      const node = (path as { node: { ctename?: unknown } }).node;
      if (typeof node.ctename === "string") {
        cteNames.add(node.ctename.toLowerCase());
      }
    },
    FuncCall: (path, ctx) => {
      const node = (path as { node: { funcname?: unknown } }).node;
      const parts = Array.isArray(node.funcname)
        ? node.funcname
            .map(svalText)
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.toLowerCase())
        : [];
      const last = parts[parts.length - 1];
      if (last !== undefined && FORBIDDEN_FUNCTION_SET.has(last)) {
        (ctx as { abort: (r: string) => void }).abort("FORBIDDEN_FUNCTION");
      }
    },
    RangeVar: (path) => {
      const node = (path as {
        node: {
          schemaname?: unknown;
          relname?: unknown;
          alias?: unknown;
        };
      }).node;
      const name = typeof node.relname === "string" ? node.relname : "";
      rangeVars.push({
        schema:
          typeof node.schemaname === "string" ? node.schemaname : undefined,
        name,
      });
      const aliasname =
        typeof node.alias === "object" && node.alias !== null
          ? (node.alias as { aliasname?: unknown }).aliasname
          : undefined;
      if (typeof aliasname === "string" && aliasname.length > 0) {
        aliasToTable.set(aliasname.toLowerCase(), name);
      }
    },
    RangeSubselect: (path) => {
      const node = (path as {
        node: { alias?: unknown; subquery?: unknown };
      }).node;
      const aliasname =
        typeof node.alias === "object" && node.alias !== null
          ? (node.alias as { aliasname?: unknown }).aliasname
          : undefined;
      if (
        typeof aliasname === "string" &&
        aliasname.length > 0 &&
        node.subquery !== undefined
      ) {
        subqueries.push({ alias: aliasname, subquery: node.subquery });
      }
    },
    ColumnRef: (path) => {
      const node = (path as { node: { fields?: unknown } }).node;
      if (!Array.isArray(node.fields)) return;
      const names = node.fields
        .map(svalText)
        .filter((s): s is string => typeof s === "string");
      // A_Star contributes no String field; a bare `*` yields zero names.
      if (names.length === 0) return;
      const last = names[names.length - 1] as string;
      const qualifier =
        names.length >= 2 ? (names[names.length - 2] as string) : undefined;
      // PG resolves unqualified ORDER BY/GROUP BY ColumnRefs against select-list aliases (or larg for setops);
      // HAVING still forbids select aliases, and positional refs (ORDER BY 1) are A_Const nodes.
      let aliasExempt = false;
      let sortGroupPosition = false;
      if (names.length === 1 && qualifier === undefined) {
        const enclosing = enclosingSelect(path as NodePath);
        if (
          enclosing !== undefined &&
          (enclosing.clauseKey === "sortClause" ||
            enclosing.clauseKey === "groupClause")
        ) {
          sortGroupPosition = true;
          let aliases = resTargetAliasNames(enclosing.select);
          if (aliases.size === 0) {
            const larg = asSelectStmt(enclosing.select["larg"]);
            if (larg !== undefined) {
              aliases = resTargetAliasNames(larg);
            }
          }
          if (aliases.has(last.toLowerCase())) {
            aliasExempt = true;
          }
        }
      }
      columnRefs.push({ qualifier, name: last, aliasExempt, sortGroupPosition });
    },
  });

  if (result.aborted) {
    const reason = result.reason ?? "";
    if (reason === "FORBIDDEN_FUNCTION") {
      return {
        ok: false,
        error: dbToolError("FORBIDDEN_FUNCTION", "Function is not allowed"),
      };
    }
    return {
      ok: false,
      error: dbToolError(
        "FORBIDDEN_STATEMENT",
        "Statement is not a plain read-only SELECT",
      ),
    };
  }

  // Exact-first then lowercase lookup: PG folds unquoted identifiers to lowercase while preserving quoted mixed-case.
  const tableIndex = new Map<string, SchemaCatalog["tables"][number]>();
  for (const table of catalog.tables) {
    tableIndex.set(table.name.toLowerCase(), table);
    tableIndex.set(table.name, table);
  }
  const lookupTable = (
    name: string,
  ): SchemaCatalog["tables"][number] | undefined =>
    tableIndex.get(name) ?? tableIndex.get(name.toLowerCase());

  // Opaque subqueries are omitted here so references to them fail closed as UNKNOWN_TABLE.
  const subqueryOutputs = new Map<string, string[]>();
  for (const { alias, subquery } of subqueries) {
    const outputs = subqueryOutputColumns(subquery);
    if (outputs !== null) {
      subqueryOutputs.set(alias.toLowerCase(), outputs);
    }
  }
  const derivedOutputs = new Set<string>();
  for (const outputs of subqueryOutputs.values()) {
    for (const name of outputs) {
      derivedOutputs.add(name);
    }
  }

  const seenTables = new Set<string>();
  for (const rv of rangeVars) {
    if (
      rv.schema !== undefined &&
      SYSTEM_SCHEMA_SET.has(rv.schema.toLowerCase())
    ) {
      return {
        ok: false,
        error: dbToolError("UNKNOWN_TABLE", "System schemas are not allowed"),
      };
    }
    if (cteNames.has(rv.name.toLowerCase())) continue;
    const table = lookupTable(rv.name);
    if (table === undefined) {
      return {
        ok: false,
        error: dbToolError("UNKNOWN_TABLE", `Unknown table: ${rv.name}`),
      };
    }
    seenTables.add(rv.name.toLowerCase());
    aliasToTable.set(rv.name.toLowerCase(), rv.name);
  }

  const seenColumns = new Set<string>();
  const columnIn = (tableName: string, column: string): boolean => {
    const table = lookupTable(tableName);
    if (table === undefined) return false;
    if (table.columns.some((c) => c.name === column)) return true;
    const lowered = column.toLowerCase();
    return table.columns.some((c) => c.name.toLowerCase() === lowered);
  };
  const anyTableHas = (column: string): boolean => {
    for (const t of seenTables) {
      if (columnIn(t, column)) return true;
    }
    return false;
  };

  for (const ref of columnRefs) {
    if (ref.aliasExempt) {
      seenColumns.add(ref.name.toLowerCase());
      continue;
    }
    if (ref.qualifier !== undefined) {
      const q = ref.qualifier.toLowerCase();
      // Guard leaves CTE outputs opaque for downstream policy resolution; FROM-subquery refs require an enumerated column.
      if (cteNames.has(q)) continue;
      // CTEs with FROM aliases are likewise deferred to downstream policy resolution.
      const cteSource = aliasToTable.get(q);
      if (cteSource !== undefined && cteNames.has(cteSource.toLowerCase())) continue;
      const outputs = subqueryOutputs.get(q);
      if (outputs !== undefined) {
        if (!outputs.includes(ref.name.toLowerCase())) {
          return {
            ok: false,
            error: dbToolError("UNKNOWN_TABLE", `Unknown column: ${ref.name}`),
          };
        }
      } else {
        const tableName = aliasToTable.get(q);
        if (tableName === undefined || !columnIn(tableName, ref.name)) {
          return {
            ok: false,
            error: dbToolError("UNKNOWN_TABLE", `Unknown column: ${ref.name}`),
          };
        }
      }
    } else if (
      ref.sortGroupPosition &&
      derivedOutputs.has(ref.name.toLowerCase())
    ) {
      // Allow ORDER BY/GROUP BY over a provably enumerated FROM-subquery output column.
    } else if (seenTables.size > 0 && !anyTableHas(ref.name)) {
      return {
        ok: false,
        error: dbToolError("UNKNOWN_TABLE", `Unknown column: ${ref.name}`),
      };
    } else if (seenTables.size === 0) {
      // Fail closed on any named column reference when the query has no FROM tables.
      return {
        ok: false,
        error: dbToolError("UNKNOWN_TABLE", `Unknown column: ${ref.name}`),
      };
    }
    seenColumns.add(ref.name.toLowerCase());
  }

  return {
    ok: true,
    tables: [...seenTables].sort(),
    columns: [...seenColumns].sort(),
    ast,
  };
}
