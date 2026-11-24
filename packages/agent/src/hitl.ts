import { Command, interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { NO_MATCHING_TABLE_OPTION, THREAD_ID_MAX_LENGTH } from "./constants.js";
import type {
  ClarificationField,
  PendingClarification,
} from "./state.js";

export { isGraphInterrupt };
export { NO_MATCHING_TABLE_OPTION, THREAD_ID_MAX_LENGTH } from "./constants.js";

/** Fail closed on empty parts or over-length ids so threads are never silently truncated. */
export function makeThreadId(userId: string, sessionId: string): string {
  if (!userId || !sessionId) {
    throw new Error("makeThreadId requires non-empty userId and sessionId");
  }
  const threadId = `chat:${userId}:${sessionId}`;
  if (threadId.length >= THREAD_ID_MAX_LENGTH) {
    throw new Error(
      `thread id exceeds ${THREAD_ID_MAX_LENGTH} chars (${threadId.length})`,
    );
  }
  return threadId;
}

export function isSameThread(a: string, b: string): boolean {
  return a === b;
}

export interface ClarificationRequest {
  field: ClarificationField;
  question: string;
  options: string[];
  attempts: number;
  table?: string;
}

export interface ClarificationPayload {
  status: "needs_clarification";
  reason: string;
  table?: string;
  sql: null;
  pendingClarification: PendingClarification;
}

export function requestClarification(
  req: ClarificationRequest,
): ClarificationPayload {
  if (!req.question) {
    throw new Error("requestClarification requires a question");
  }
  if (req.options.length < 2 || req.options.length > 4) {
    throw new Error("requestClarification requires two to four options");
  }
  if (!Number.isInteger(req.attempts) || req.attempts < 0 || req.attempts > 2) {
    throw new Error("requestClarification attempts must be an integer from 0 to 2");
  }
  return {
    status: "needs_clarification",
    reason: req.question,
    ...(req.table ? { table: req.table } : {}),
    sql: null,
    pendingClarification: {
      field: req.field,
      question: req.question,
      options: [...req.options],
      attempts: req.attempts,
    },
  };
}

export function pauseForClarification(request: PendingClarification): unknown {
  return interrupt({ action: "clarify_then_query", pendingClarification: request });
}

export function isClarificationOption(
  request: PendingClarification,
  value: unknown,
): value is string {
  return typeof value === "string" && request.options.includes(value);
}

export type TableClarificationVerdict =
  | { kind: "abort_rephrase" }
  | { kind: "table"; table: string }
  | { kind: "invalid" };

const ABORT_REPHRASE_ALIASES = new Set([
  "khong co bang phu hop",
  "khong co bang nao",
  "dat lai cau hoi",
  "none of the above",
  "no matching table",
  "reset",
  "cancel",
]);

function normalizeChoiceText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim();
}

export function isAbortClarificationChoice(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed === NO_MATCHING_TABLE_OPTION) return true;
  return ABORT_REPHRASE_ALIASES.has(normalizeChoiceText(trimmed));
}

export function classifyTableClarificationValue(
  request: PendingClarification,
  value: unknown,
  allowedTableNames: readonly string[],
): TableClarificationVerdict {
  if (typeof value !== "string") return { kind: "invalid" };
  const trimmed = value.trim();
  if (!trimmed) return { kind: "invalid" };
  if (isAbortClarificationChoice(trimmed)) {
    return { kind: "abort_rephrase" };
  }
  const catalogMatch = allowedTableNames.find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (catalogMatch) {
    return { kind: "table", table: catalogMatch };
  }
  if (request.options.includes(trimmed)) {
    return { kind: "table", table: trimmed };
  }
  return { kind: "invalid" };
}

export interface ReviewPayload {
  action: string;
  sql?: string;
  reason?: string;
  plan?: unknown;
  currentPlan?: unknown;
  planId?: string;
}

export function pauseForApproval(review: ReviewPayload): unknown {
  return interrupt(review);
}

/** Resume on the same thread_id via Command; fresh inputs re-run generation and can double-execute side effects. */
export function resumeDecision(value: unknown): Command {
  return new Command({ resume: value });
}
