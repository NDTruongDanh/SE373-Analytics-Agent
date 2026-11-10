// HITL plumbing (AGENT-08, 01-12): pure clarification plus interrupt and
// resume helpers over stable thread ids. Keep interrupted nodes small with a
// single interrupt each. Live PostgresSaver resume proof belongs to 01-13
// and the restart-proof host endpoint belongs to 01-14 — this module stays
// DB-free: semantics only, proven on MemorySaver.

import { Command, interrupt } from "@langchain/langgraph";
import { THREAD_ID_MAX_LENGTH } from "./constants.js";
import type {
  ClarificationField,
  PendingClarification,
} from "./state.js";

export { THREAD_ID_MAX_LENGTH } from "./constants.js";

/**
 * Build chat:{userId}:{sessionId}. Throws on empty parts or over-length ids
 * (fail-closed: never resume into a truncated thread).
 */
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

/** Thread equality: resume only on the same thread_id. */
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

/**
 * needs_clarification status payload carrying the pendingClarification
 * options the answer node offers. The caller sets attempts.
 */
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

/** Pause a query at the structured UC-01 clarification edge. */
export function pauseForClarification(request: PendingClarification): unknown {
  return interrupt({ action: "clarify_then_query", pendingClarification: request });
}

/** A resume response is accepted only when it exactly matches a presented option. */
export function isClarificationOption(
  request: PendingClarification,
  value: unknown,
): value is string {
  return typeof value === "string" && request.options.includes(value);
}

export interface ReviewPayload {
  action: string;
  sql?: string;
  reason?: string;
}

/**
 * Pause the node carrying the review payload. Call inside a node only; the
 * graph suspends here and resumes when the host invokes resumeDecision's
 * Command on the same thread_id.
 */
export function pauseForApproval(review: ReviewPayload): unknown {
  return interrupt(review);
}

/**
 * Build the resume Command for invocation on the same thread_id — never a
 * fresh input object (fresh inputs re-run generation and can double-execute
 * side effects).
 */
export function resumeDecision(value: unknown): Command {
  return new Command({ resume: value });
}
