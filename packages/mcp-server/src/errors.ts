// Single choke point for DB driver error formatting (POL-05, T-01-06-04).
// Adapted verbatim from the v1 reference per D-06 (DSN/host/IPv4/user,
// detail-only path, stack-frame patterns, single entry point, 500-char cap)
// with the ARCH-REVIEW C1 fix: runtime query errors map to
// SQL_EXECUTION_ERROR (repairable, never retryable), never INTERNAL_ERROR.
// Every catch around pool checkout, session setup, cursor reads, and
// teardown funnels through sanitizeError — no other file formats driver
// errors for output. Stack traces never leave the process; the composed
// message is capped at the DbToolErrorSchema 500-char max. The shared PII
// redactor runs after the infra patterns so echoed literals in database
// messages (e.g. `invalid input syntax for ...: "090..."`) are masked too.
import {
  dbToolError,
  type DbToolError,
  type ErrorCode,
} from "@se373/contracts";
import { redactPII } from "@se373/access-policy";

// postgres://user:pass@host:port/db — kills credentials, host, port, dbname.
const DSN_PATTERN = /postgres(ql)?:\/\/[^\s"'`]+/gi;
// host=… fragments in connection errors.
const HOST_ASSIGN_PATTERN = /host\s*=\s*[^\s;,]+/gi;
// Bare IPv4 literals.
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// `for user "…"` — never echo which credential failed.
const USER_PATTERN = /\buser\s+"[^"]*"/gi;
// Filesystem paths. Applied to detail/hint ONLY — never to message, where a
// `/` may be SQL division (e.g. `SELECT 10/2`).
const PATH_PATTERN = /\/[\w.\-/~]+(\.\w{1,5})?/g;
// Stack-frame lines, in case a driver embeds them in message text.
const STACK_FRAME_PATTERN = /^\s*at\s.*\(.*:\d+.*$/gm;

function redactInfra(text: string): string {
  return text
    .replace(DSN_PATTERN, "postgres://<redacted>")
    .replace(HOST_ASSIGN_PATTERN, "host=<redacted>")
    .replace(IPV4_PATTERN, "<redacted>")
    .replace(USER_PATTERN, 'user "<redacted>"');
}

function redactPath(text: string): string {
  return text.replace(PATH_PATTERN, "<redacted-path>");
}

function pgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// PG SQLSTATE → contract code (codes per the Postgres 16 errcodes appendix).
// Class-22 (data exceptions from valid-parse SQL) and the residual class-42
// semantic errors (the classic LLM mistakes: grouping, duplicate alias, bad
// names) map to repairable SQL_EXECUTION_ERROR. Class-08 (connection) and
// 53xxx (resource) stay retryable INTERNAL_ERROR; the default branch is
// INTERNAL_ERROR so unknown codes fail safe.
function contractCodeFor(code: string | undefined): ErrorCode {
  switch (code) {
    case "57014": // query_canceled (statement_timeout)
      return "TIMEOUT";
    case "42601": // syntax_error
      return "INVALID_SQL";
    case "42P01": // undefined_table
    case "42703": // undefined_column (columns map here per CONTEXT)
    case "3D000": // invalid_catalog_name
    case "3F000": // invalid_schema_name
      return "UNKNOWN_TABLE";
    case "25006": // read_only_sql_transaction (write slipped past the guard)
    case "42501": // insufficient_privilege
      return "FORBIDDEN_STATEMENT";
    default:
      break;
  }
  if (code !== undefined && /^22/.test(code)) {
    return "SQL_EXECUTION_ERROR";
  }
  if (code !== undefined && /^42/.test(code)) {
    return "SQL_EXECUTION_ERROR";
  }
  if (code !== undefined && (/^08/.test(code) || /^53/.test(code))) {
    return "INTERNAL_ERROR";
  }
  return "INTERNAL_ERROR";
}

function pickText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickCursorPosition(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const raw = (err as { position?: unknown }).position;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0
    ? n
    : undefined;
}

export function sanitizeError(err: unknown): DbToolError {
  const fields =
    typeof err === "object" && err !== null
      ? (err as Record<string, unknown>)
      : {};
  const message =
    pickText(fields["message"]) ??
    (typeof err === "string" && err.length > 0 ? err : "Internal error");
  const detail = pickText(fields["detail"]);
  const hint = pickText(fields["hint"]);

  let composed = redactInfra(message);
  if (detail !== undefined) {
    composed += ` (${redactPath(redactInfra(detail))})`;
  }
  if (hint !== undefined) {
    composed += ` (${redactPath(redactInfra(hint))})`;
  }
  composed = composed.replace(STACK_FRAME_PATTERN, "");
  composed = redactPII(composed).redacted;
  if (composed.length === 0) {
    composed = "Internal error";
  }
  if (composed.length > 500) {
    composed = composed.slice(0, 500);
  }
  const code = contractCodeFor(pgCode(err));
  const cursorPosition =
    code === "INVALID_SQL" ? pickCursorPosition(err) : undefined;
  return dbToolError(code, composed, cursorPosition);
}
