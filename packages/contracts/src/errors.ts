import { z } from "zod";
import {
  ErrorCodes,
  REPAIRABLE_CODES,
  RETRYABLE_CODES,
} from "./constants.js";

export {
  ErrorCodes,
  REPAIRABLE_CODES,
  RETRYABLE_CODES,
} from "./constants.js";

export type ErrorCode = (typeof ErrorCodes)[number];

export const DbToolErrorSchema = z.object({
  code: z.enum(ErrorCodes),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  repairable: z.boolean(),
  cursorPosition: z.number().int().nonnegative().optional(),
});

export type DbToolError = z.infer<typeof DbToolErrorSchema>;

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
