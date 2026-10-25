import { walk } from "@pgsql/traverse";
import { parse } from "pgsql-parser";
import type { DbToolError, SchemaCatalog } from "@se373/contracts";
import { dbToolError } from "@se373/contracts";
import { FORBIDDEN_FUNCTION_SET, SYSTEM_SCHEMA_SET } from "./denylist.js";

export type GuardSuccess = {
  ok: true;
  /** Lowercased table names referenced by the query (CTEs excluded). */
  tables: string[];
  /** Lowercased named columns referenced by the query (`*` excluded). */
  columns: string[];
};

export type GuardFailure = {
  ok: false;
  error: DbToolError;
};

export type GuardResult = GuardSuccess | GuardFailure;

// WASM init once: async parse self-initializes libpg_query on first call.
// Never use parseSync on a request path — it throws cold
// ("WASM module not initialized"). Call once at server boot / test setup.
export async function warmupSqlGuard(): Promise<void> {
  await parse("SELECT 1");
}

// Statement tags that are never allowed anywhere in the walked tree.
// Root is already restricted to SelectStmt; DML tags matter because they can
// nest inside CTEs (WITH x AS (DELETE ...) SELECT ...). Utility tags cannot
// nest syntactically but are denied defense-in-depth (fail closed).
const DENIED_STATEMENT_TAGS: ReadonlySet<string> = new Set([
  // DML / writes
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "CopyStmt",
  "TruncateStmt",
  // Transactions / session state
  "TransactionStmt",
  "VariableSetStmt",
  "VariableShowStmt",
  "DiscardStmt",
  // DDL and privilege changes
  "CreateStmt",
  "DropStmt",
  "AlterStmt",
  "AlterTableStmt",
  "RenameStmt",
  "GrantStmt",
  "CommentStmt",
  // Execution / introspection escapes
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
type CollectedColumnRef = { qualifier?: string; name: string };

function svalText(field: unknown): string | undefined {
  if (typeof field !== "object" || field === null) return undefined;
  const stringNode = (field as Record<string, unknown>)["String"] as
    | { sval?: unknown }
    | undefined;
  return typeof stringNode?.sval === "string" ? stringNode.sval : undefined;
}

export async function sqlGuard(
  sql: string,
  catalog: SchemaCatalog,
): Promise<GuardResult> {
  if (sql.trim().length === 0) {
    return {
      ok: false,
      error: dbToolError("INVALID_SQL", "Invalid SQL at character 0"),
    };
  }
  let ast: { version?: number; stmts?: { stmt: Record<string, unknown> }[] };
  try {
    ast = (await parse(sql)) as typeof ast;
  } catch (e) {
    const pos = (e as { sqlDetails?: { cursorPosition?: unknown } })
      .sqlDetails?.cursorPosition;
    const where =
      typeof pos === "number" ? ` at character ${pos}` : "";
    return {
      ok: false,
      error: dbToolError("INVALID_SQL", `Invalid SQL${where}`),
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

  // Single pass: abort on structural violations, collect the names that the
  // post-walk catalog check validates (CTE names must be known before FROM
  // refs are judged, and walk order across clauses is not contractual).
  const cteNames = new Set<string>();
  const rangeVars: CollectedRangeVar[] = [];
  const columnRefs: CollectedColumnRef[] = [];
  // Alias (FROM x AS o) and bare-name to real-table map, filled during the
  // walk (aliases) and the post-walk table check (bare names).
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
      // FROM alias (AS o / o): qualified refs use the alias, so map it to
      // the real table for the post-walk column check.
      const aliasname =
        typeof node.alias === "object" && node.alias !== null
          ? (node.alias as { aliasname?: unknown }).aliasname
          : undefined;
      if (typeof aliasname === "string" && aliasname.length > 0) {
        aliasToTable.set(aliasname.toLowerCase(), name);
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
      columnRefs.push({ qualifier, name: last });
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

  // Catalog lookup: exact-first, lowercase-fallback (quoted mixed-case
  // identifiers match exactly; PG folds unquoted identifiers to lowercase).
  const tableIndex = new Map<string, string[]>();
  for (const [name, cols] of Object.entries(catalog.tables)) {
    tableIndex.set(name.toLowerCase(), cols);
    tableIndex.set(name, cols);
  }
  const lookupTable = (name: string): string[] | undefined =>
    tableIndex.get(name) ?? tableIndex.get(name.toLowerCase());

  const seenTables = new Set<string>();
  for (const rv of rangeVars) {
    if (rv.schema !== undefined && SYSTEM_SCHEMA_SET.has(rv.schema.toLowerCase())) {
      return {
        ok: false,
        error: dbToolError("UNKNOWN_TABLE", "System schemas are not allowed"),
      };
    }
    if (cteNames.has(rv.name.toLowerCase())) continue;
    const cols = lookupTable(rv.name);
    if (cols === undefined) {
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
    const cols = lookupTable(tableName);
    if (cols === undefined) return false;
    if (cols.includes(column)) return true;
    const lowered = column.toLowerCase();
    return cols.some((c) => c.toLowerCase() === lowered);
  };
  const anyTableHas = (column: string): boolean => {
    for (const t of seenTables) {
      if (columnIn(t, column)) return true;
    }
    return false;
  };

  for (const ref of columnRefs) {
    if (ref.qualifier !== undefined) {
      const q = ref.qualifier.toLowerCase();
      // Subquery/CTE outputs cannot be resolved against the catalog yet
      // (full resolveColumns lands in UC09-01); refs qualified by a CTE name
      // pass here. Unknown qualifiers fail closed.
      if (cteNames.has(q)) continue;
      const tableName = aliasToTable.get(q);
      if (tableName === undefined || !columnIn(tableName, ref.name)) {
        return {
          ok: false,
          error: dbToolError("UNKNOWN_TABLE", `Unknown column: ${ref.name}`),
        };
      }
    } else if (seenTables.size > 0 && !anyTableHas(ref.name)) {
      return {
        ok: false,
        error: dbToolError("UNKNOWN_TABLE", `Unknown column: ${ref.name}`),
      };
    } else if (seenTables.size === 0) {
      // No FROM tables (e.g. SELECT 1 has no ColumnRef at all): any named
      // column reference cannot resolve — fail closed.
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
  };
}
