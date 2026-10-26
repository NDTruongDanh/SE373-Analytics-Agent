// HITL plumbing (AGENT-08, 01-12): pure clarification plus interrupt and
// resume helpers over stable thread ids. Keep interrupted nodes small with a
// single interrupt each. Live PostgresSaver resume proof belongs to 01-13
// and the restart-proof host endpoint belongs to 01-14 — this module stays
// DB-free: semantics only, proven on MemorySaver.

import { Command, interrupt } from "@langchain/langgraph";

/** Thread ids must stay well under the Postgres text limit. */
export const THREAD_ID_MAX_LENGTH = 255;

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
  reason: string;
  options: string[];
  table?: string;
}

export interface ClarificationPayload {
  status: "needs_clarification";
  reason: string;
  table?: string;
  sql: null;
  pendingClarification: string[];
}

/**
 * needs_clarification status payload carrying the pendingClarification
 * options the answer node offers. The caller sets attempts.
 */
export function requestClarification(
  req: ClarificationRequest,
): ClarificationPayload {
  if (!req.reason) {
    throw new Error("requestClarification requires a reason");
  }
  if (req.options.length === 0) {
    throw new Error("requestClarification requires at least one option");
  }
  return {
    status: "needs_clarification",
    reason: req.reason,
    ...(req.table ? { table: req.table } : {}),
    sql: null,
    pendingClarification: [...req.options],
  };
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
