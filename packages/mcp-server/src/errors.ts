import {
  dbToolError,
  type DbToolError,
  type ErrorCode,
} from "@shared/contracts";
import { redactPII } from "@shared/access-policy";

const DSN_PATTERN = /postgres(ql)?:\/\/[^\s"'`]+/gi;
const HOST_ASSIGN_PATTERN = /host\s*=\s*[^\s;,]+/gi;
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const USER_PATTERN = /\buser\s+"[^"]*"/gi;
// Applied to detail/hint only — never message, where `/` may be SQL division.
const PATH_PATTERN = /\/[\w.\-/~]+(\.\w{1,5})?/g;
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

// Class-22 data and residual class-42 semantic errors map to repairable SQL_EXECUTION_ERROR;
// connection/resource (08/53) and unknown codes fail safe as INTERNAL_ERROR.
function contractCodeFor(code: string | undefined): ErrorCode {
  switch (code) {
    case "57014": // query_canceled (statement_timeout)
      return "TIMEOUT";
    case "42601": // syntax_error
      return "INVALID_SQL";
    case "42P01": // undefined_table
    case "42703": // undefined_column
    case "3D000": // invalid_catalog_name
    case "3F000": // invalid_schema_name
      return "UNKNOWN_TABLE";
    case "25006": // read_only_sql_transaction
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
