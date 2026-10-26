import * as z from "zod";

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

export type ErrorCode = (typeof ErrorCodes)[number];

export const DbToolErrorSchema = z.object({
  code: z.enum(ErrorCodes),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  repairable: z.boolean(),
  cursorPosition: z.number().int().nonnegative().optional(),
});

export type DbToolError = z.infer<typeof DbToolErrorSchema>;

export const RETRYABLE_CODES: ErrorCode[] = [
  "TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

export const REPAIRABLE_CODES: ErrorCode[] = [
  "INVALID_SQL",
  "UNKNOWN_TABLE",
  "SQL_EXECUTION_ERROR",
];

export function dbToolError(
  code: ErrorCode,
  message: string,
  cursorPosition?: number,
): DbToolError {
  return {
    code,
    message,
    retryable: RETRYABLE_CODES.includes(code),
    repairable: REPAIRABLE_CODES.includes(code),
    ...(cursorPosition === undefined ? {} : { cursorPosition }),
  };
}
