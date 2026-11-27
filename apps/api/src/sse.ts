import type { Response } from "express";
import type { PendingClarification } from "@shared/agent";
import {
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
} from "@shared/contracts";
import { SSE_ALLOWLIST } from "./constants.js";

export { SSE_ALLOWLIST };

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
  checkpointId?: string;
  node?: string;
  data?: unknown;
}

// Defense-in-depth wire tripwire (not the canonical redactor) for VN 10-digit 0-led phones and emails.
// Negative lookbehind avoids matching digits inside longer integers or after decimal points.
const PHONE_LIKE = /(?<!\d|\d[.,])0\d{9}/;
const EMAIL_LIKE = /\S+@\S+\.\S+/;

export function containsWirePii(text: string): boolean {
  return PHONE_LIKE.test(text) || EMAIL_LIKE.test(text);
}

function scrubMessage(message: string): string {
  if (containsWirePii(message)) return "[withheld: possible PII in message]";
  return message.slice(0, 500);
}

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

export function schemaPayload(tablesUsed: string[]): Record<string, unknown> {
  return { tables: [...tablesUsed], tableCount: tablesUsed.length };
}

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

// Allow only a restricted, literal-free order-status proposal after gateway acceptance; withhold everything else rather than regex-redacting.
export function displayableSql(sql: string): string | null {
  if (sql.length === 0 || sql.length > 4000 || !/^\s*(?:select|with)\b/i.test(sql)) return null;
  if (!/^[a-zA-Z_\s.,()*+\-/;<>!=]+$/.test(sql) || /--|\/\*|\*\//.test(sql)) return null;
  const safeWords = new Set(["select", "status", "count", "distinct", "as", "n", "total", "order_count", "order_total", "from", "public", "orders", "group", "by", "order", "asc", "desc", "nulls", "first", "last"]);
  if ((sql.match(/[a-zA-Z_]+/g) ?? []).some((word) => !safeWords.has(word.toLowerCase()))) return null;
  return sql;
}

export function sqlRepairedPayload(
  sql: string | null,
  tablesUsed: string[],
  attempt: number,
): Record<string, unknown> {
  return { ...sqlPayload(sql, tablesUsed), attempt };
}

export function runningPayload(statusGroups: number): Record<string, unknown> {
  return { statusGroups };
}

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

export interface InterruptPayloadInput {
  action?: string;
  reason?: string;
  checkpointId?: string;
  asOf?: string;
  pendingClarification?: PendingClarification | string[] | null;
  plan?: unknown;
  currentPlan?: unknown;
}

export function interruptPayload(input: InterruptPayloadInput): Record<string, unknown> {
  const plan = input.currentPlan ?? input.plan;
  let pending: unknown;
  if (Array.isArray(input.pendingClarification)) {
    pending = [...input.pendingClarification];
  } else if (input.pendingClarification) {
    const pc = input.pendingClarification as PendingClarification;
    pending = { ...pc, options: [...pc.options] };
  }
  return {
    ...(input.action ? { action: input.action } : {}),
    ...(input.reason ? { reason: scrubMessage(input.reason) } : {}),
    ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    ...(input.asOf ? { asOf: input.asOf } : {}),
    ...(pending ? { pendingClarification: pending } : {}),
    ...(plan !== undefined ? { plan, currentPlan: plan } : {}),
  };
}

// Validate against the event schema and degrade to a failed event on mismatch so raw payloads never reach the wire.
export function emitSseEvent(
  res: Response,
  event: SseEventName,
  envelope: SseEnvelope,
): void {
  const schema = SCHEMAS[event];
  const candidate = {
    runId: String(envelope.runId ?? ""),
    threadId: String(envelope.threadId ?? ""),
    ...(envelope.checkpointId && event === "interrupt_waiting"
      ? { checkpointId: envelope.checkpointId }
      : {}),
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
