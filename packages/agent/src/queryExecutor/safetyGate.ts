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

/** Cap applied to non-aggregate detail queries (GUARD-03). */
export const DETAIL_QUERY_LIMIT = 200;

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

/** Aggregate = any function call, or a GROUP BY / HAVING at the root. */
function hasAggregate(ast: GuardAst): boolean {
  if (findNodes(ast, "FuncCall").length > 0) return true;
  const root = rootSelectStmt(ast);
  if (!root) return false;
  const group = root["groupClause"];
  if (Array.isArray(group) && group.length > 0) return true;
  const having = root["havingClause"];
  return having !== undefined && having !== null;
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
  if (
    large.length > 0 &&
    !hasWhereFilter(guard.ast) &&
    !hasAggregate(guard.ast)
  ) {
    const table = large[0];
    return {
      verdict: "needs_clarification",
      table,
      reason:
        `Query scans large table "${table}" with no WHERE filter and no ` +
        `aggregate; add a filter, an aggregate, or pick a smaller table.`,
    };
  }

  if (!hasAggregate(guard.ast)) {
    return { verdict: "pass", sql: clampLimit(sql, DETAIL_QUERY_LIMIT) };
  }
  return { verdict: "pass", sql };
}
