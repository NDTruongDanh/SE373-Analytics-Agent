// LocalQuerySafetyGate (GUARD-03, 01-11). Pure agent-side pre-check that runs
// AFTER sqlGuard from @shared/access-policy and BEFORE any MCP call: sqlGuard
// owns syntax/table/column validity, this gate owns the agent-side policy
// extras — sensitive-column denial in any clause, cross/conditionless-join
// denial, large-table clarification, and the detail-query LIMIT clamp.
// Fail-closed: every denial is a DbToolError built through the contracts
// helper. Server-side AccessPolicy (01-06/01-08) remains authoritative.

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

/** Generic recursive walk over the raw pgsql-parser JSON (no traverse dep). */
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

/**
 * Sensitive-column check (01-06 set semantics, agent-side): deny when a
 * catalog-marked sensitive column of a scanned table appears anywhere in the
 * query. GuardSuccess.columns already collects named refs from every clause
 * (projection, WHERE, JOIN ON, GROUP BY, HAVING, ORDER BY, function and
 * aggregate args), so one set-membership test covers all clauses.
 */
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

/**
 * Join check: deny any JoinExpr with no ON/USING condition (CROSS JOIN and
 * conditionless joins both parse to an unconditioned JoinExpr) and any
 * comma-separated FROM list (an implicit cross join). NATURAL JOIN is left
 * to the server-side guard — it carries join semantics the agent cannot
 * resolve without output mapping.
 */
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

/** A table counts as large when any of its catalog columns is large-flagged. */
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

/** True when any WHERE clause exists anywhere in the tree (filter present). */
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

/** Aggregate = a known aggregate call, or a GROUP BY / HAVING at the root. */
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

/**
 * True only for a direct, conjunctive comparison on purchase_date. This keeps
 * literals, IS NOT NULL, and an OR escape hatch from satisfying the large-table
 * policy while accepting qualified ColumnRef nodes and CURRENT_DATE windows.
 */
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

/**
 * UC-01 performance policy: both large fact tables must be bounded by the
 * indexed parent-order timestamp. `order_items` gets its bound through the
 * required join to `orders`; province/region can further narrow a query but
 * cannot replace the time bound.
 */
function hasLargeTableTimeFilter(guard: GuardSuccess, large: string[]): boolean {
  const names = new Set(large.map((table) => table.toLowerCase()));
  if (!names.has("orders") && !names.has("order_items")) return true;
  return findNodes(guard.ast, "whereClause").some((where) =>
    hasConjunctivePurchaseDateRange(where),
  );
}

/**
 * Clamp or append a top-level LIMIT. Operates on the statement tail so inner
 * subquery LIMITs are untouched; non-numeric LIMITs (parameters) are left
 * for the server. Returns the SQL unchanged when a LIMIT at or under the cap
 * is already present.
 */
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
    // A LIMIT the tail pattern cannot parse (e.g. a parameter) — leave it
    // for the server-side guard rather than producing invalid SQL.
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
