// SSE allowlist plus sanitized emitter (API-01/API-03, 01-14, wave 6).
//
// The allowlist matches exactly the 01-02 per-event zod schemas in
// @se373/contracts (D-20): intent_parsed, schema_retrieved, sql_generated,
// sql_repaired, query_running, viz, completed, failed, interrupt_waiting.
// Every emit validates against its per-event schema before writing and
// degrades to a failed event on mismatch — raw payloads never reach the
// wire (T-01-14-02).
//
// Sanitization is construction-based: payload builders pick whitelisted
// fields only (counts, column/table names, status, scrubbed message), so
// SQL literals, row cell values, and tokens can never reach the wire. The
// canonical PII redaction stays in the trace/audit layers (01-06 redactor
// via the 01-09 writer); the small tripwire below is defense-in-depth for
// the two free-text fields the wire legitimately carries (answerText,
// error message) and degrades to failed on a hit.

import type { Response } from "express";
import {
  SSE_EVENT_NAMES,
  SseCompletedEventSchema,
  SseFailedEventSchema,
  SseIntentParsedEventSchema,
  SseInterruptWaitingEventSchema,
  SseQueryRunningEventSchema,
  SseSchemaRetrievedEventSchema,
  SseSqlGeneratedEventSchema,
  SseSqlRepairedEventSchema,
  SseVizEventSchema,
  type SseEventName,
} from "@se373/contracts";

/** Allowlist exactly matching the contracts per-event schemas (D-20). */
export const SSE_ALLOWLIST: readonly SseEventName[] = SSE_EVENT_NAMES;

const SCHEMAS = {
  intent_parsed: SseIntentParsedEventSchema,
  schema_retrieved: SseSchemaRetrievedEventSchema,
  sql_generated: SseSqlGeneratedEventSchema,
  sql_repaired: SseSqlRepairedEventSchema,
  query_running: SseQueryRunningEventSchema,
  viz: SseVizEventSchema,
  completed: SseCompletedEventSchema,
  failed: SseFailedEventSchema,
  interrupt_waiting: SseInterruptWaitingEventSchema,
} as const;

export interface SseEnvelope {
  runId: string;
  threadId: string;
  node?: string;
  data?: unknown;
}

// Local wire tripwire (NOT the canonical redactor): a 10-digit 0-led run
// (VN mobile shape from the seed data) or an @-email in free text degrades
// the emit to failed. Counts and names can never trip it: rendered counts
// have no leading zero and names carry no @.
const PHONE_LIKE = /0\d{9}/;
const EMAIL_LIKE = /\S+@\S+\.\S+/;

/** True when free text carries a phone/email shape that must not go on the wire. */
export function containsWirePii(text: string): boolean {
  return PHONE_LIKE.test(text) || EMAIL_LIKE.test(text);
}

function scrubMessage(message: string): string {
  if (containsWirePii(message)) return "[withheld: possible PII in message]";
  return message.slice(0, 500);
}

/** intent_parsed payload: metric shape only; filter VALUES never leave the host. */
export function intentPayload(intent: {
  metric: string | null;
  dimensions: string[];
  filters: { field: string; operator: string; value?: unknown }[];
  timeRange: string | null;
}): Record<string, unknown> {
  return {
    metric: intent.metric,
    dimensions: [...intent.dimensions],
    filters: intent.filters.map((f) => ({ field: f.field, operator: f.operator })),
    timeRange: intent.timeRange,
  };
}

/** schema_retrieved payload: table names plus count only. */
export function schemaPayload(tablesUsed: string[]): Record<string, unknown> {
  return { tables: [...tablesUsed], tableCount: tablesUsed.length };
}

/** sql_generated payload: statement metadata only — the SQL text never leaves. */
export function sqlPayload(
  sql: string | null,
  tablesUsed: string[],
): Record<string, unknown> {
  const statementType =
    sql !== null && /^\s*with\b/i.test(sql)
      ? "WITH"
      : sql !== null && /^\s*select\b/i.test(sql)
        ? "SELECT"
        : "UNKNOWN";
  return { tablesUsed: [...tablesUsed], statementType };
}

/** sql_repaired payload: attempt metadata only, no error text. */
export function sqlRepairedPayload(
  sql: string | null,
  tablesUsed: string[],
  attempt: number,
): Record<string, unknown> {
  return { ...sqlPayload(sql, tablesUsed), attempt };
}

/** query_running payload: progress counts only. */
export function runningPayload(statusGroups: number): Record<string, unknown> {
  return { statusGroups };
}

/** completed payload: status plus counts plus the tripwire-scrubbed answer. */
export function completedPayload(input: {
  status: string;
  answerText: string;
  toolsCalled: string[];
  total: number;
}): Record<string, unknown> {
  if (containsWirePii(input.answerText)) {
    throw new Error("completed answer withheld: possible PII in answer text");
  }
  return {
    status: input.status,
    answerText: input.answerText,
    toolsCalled: [...input.toolsCalled],
    total: input.total,
  };
}

/** failed payload: contract error shape with a scrubbed message. */
export function failedPayload(input: {
  code: string;
  message: string;
  retryable: boolean;
  repairable: boolean;
}): Record<string, unknown> {
  return {
    code: input.code,
    message: scrubMessage(input.message),
    retryable: input.retryable,
    repairable: input.repairable,
  };
}

/** interrupt_waiting payload: clarification options only, no prompts. */
export function interruptPayload(input: {
  reason?: string;
  pendingClarification?: string[] | null;
}): Record<string, unknown> {
  return {
    ...(input.reason ? { reason: scrubMessage(input.reason) } : {}),
    ...(input.pendingClarification ? { pendingClarification: [...input.pendingClarification] } : {}),
  };
}

/**
 * Validate-then-write one SSE event. A schema mismatch degrades to a
 * failed event (never a raw passthrough); only allowlisted names are
 * emitted. Throws nothing — Express write errors are the caller's domain.
 */
export function emitSseEvent(
  res: Response,
  event: SseEventName,
  envelope: SseEnvelope,
): void {
  const schema = SCHEMAS[event];
  const candidate = {
    runId: String(envelope.runId ?? ""),
    threadId: String(envelope.threadId ?? ""),
    ...(envelope.node ? { node: envelope.node } : {}),
    event,
    ...(envelope.data !== undefined ? { data: envelope.data } : {}),
  };
  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(parsed.data)}\n\n`);
    return;
  }
  const fallback = SseFailedEventSchema.safeParse({
    runId: candidate.runId || "unknown",
    threadId: candidate.threadId || "unknown",
    event: "failed",
    data: {
      code: "INTERNAL_ERROR",
      message: `SSE envelope for '${event}' failed validation; event withheld`,
      retryable: true,
      repairable: false,
    },
  });
  if (fallback.success) {
    res.write(`event: failed\n`);
    res.write(`data: ${JSON.stringify(fallback.data)}\n\n`);
  }
}
