export const CONTRACTS_VERSION = "1.1.0";

// The 12 frozen error codes: UC-09 A.7 codes E1-E9 plus E11, with E10
// (truncation) represented by the `truncated` boolean flag rather than an
// error, plus RATE_LIMITED reserved per UC-09 F17 to reconcile the count,
// plus SQL_EXECUTION_ERROR for runtime query failures (repairable, never
// retryable — ARCH-REVIEW C1).
export const ErrorCodes = [
  "UNAUTHORIZED",
  "SCOPE_DENIED",
  "INVALID_PARAMS",
  "INVALID_SQL",
  "FORBIDDEN_STATEMENT",
  "FORBIDDEN_FUNCTION",
  "UNKNOWN_TABLE",
  "SENSITIVE_COLUMN_DENIED",
  "SQL_EXECUTION_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;

export const RETRYABLE_CODES: (typeof ErrorCodes)[number][] = [
  "TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

export const REPAIRABLE_CODES: (typeof ErrorCodes)[number][] = [
  "INVALID_SQL",
  "UNKNOWN_TABLE",
  "SQL_EXECUTION_ERROR",
];

export const SSE_EVENT_NAMES = [
  "intent_parsed",
  "schema_retrieved",
  "sql_generated",
  "sql_repaired",
  "query_running",
  "viz",
  "completed",
  "failed",
  "interrupt_waiting",
] as const;
