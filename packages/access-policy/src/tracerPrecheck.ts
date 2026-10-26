// TRACER SELECT-only pre-check (D-01 placement: this file lives in
// access-policy, never in mcp-server). Accepts a single SELECT or
// WITH...SELECT statement by keyword + parenthesis-balance inspection.
// 01-08 replaces this with the full-AST sqlGuard.

export const TRACER_FORBIDDEN_MESSAGE =
  "tracer pre-check: only a single SELECT (or WITH...SELECT) statement is allowed";

const LEADING_KEYWORD = /^(SELECT|WITH)\b/i;
const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|ANALYZE|EXPLAIN|COMMENT|SECURITY|REINDEX|CLUSTER|LISTEN|NOTIFY|PREPARE|EXECUTE|DEALLOCATE|DISCARD|SET|SHOW|RESET|START|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|LOCK|TABLESAMPLE)\b/i;

function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/;+\s*$/, "");
}

function parensBalanced(sql: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  let prev = "";
  for (const ch of stripLineComments(sql)) {
    if (inString !== null) {
      if (ch === inString && prev !== "\\") inString = null;
    } else if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
    prev = ch;
  }
  return inString === null && depth === 0;
}

function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx < 0 ? line : line.slice(0, idx);
    })
    .join("\n");
}

export interface TracerPrecheckResult {
  ok: boolean;
  error?: string;
}

/** Return `{ok: true}` for a single SELECT/WITH-SELECT, else `{ok: false}`. */
export function tracerPrecheck(sql: string): TracerPrecheckResult {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: TRACER_FORBIDDEN_MESSAGE };
  }
  const body = stripTrailingSemicolons(trimmed);
  if (body.includes(";")) {
    return { ok: false, error: TRACER_FORBIDDEN_MESSAGE };
  }
  if (!LEADING_KEYWORD.test(body)) {
    return { ok: false, error: TRACER_FORBIDDEN_MESSAGE };
  }
  if (FORBIDDEN_KEYWORDS.test(body)) {
    return { ok: false, error: TRACER_FORBIDDEN_MESSAGE };
  }
  if (!parensBalanced(body)) {
    return { ok: false, error: TRACER_FORBIDDEN_MESSAGE };
  }
  return { ok: true };
}
