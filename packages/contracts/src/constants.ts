export const CONTRACTS_VERSION = "1.2.0";

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
