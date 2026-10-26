import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { TraceEventSchema } from "@se373/contracts";

// TRACER trace writer (OBS-01 slice): stamps runId/threadId/spanId via
// randomUUID (D-13), masks phone/email inline before append, one JSON line per
// event under traces/<runId>.jsonl. The shared redactor from 01-06 replaces
// the inline mask.

const PHONE_RE = /\b0(?:3|5|7|8|9)\d{8}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export interface TracerTraceEvent {
  runId: string;
  threadId: string;
  userId: string;
  role: string;
  node: string;
  type: string;
  durationMs: number;
  payload?: unknown;
  parentSpanId?: string;
  attempt?: number;
}

/** Append one redacted event; return its spanId for chaining. */
export function writeTraceEvent(
  event: TracerTraceEvent,
  tracesDir = "traces",
): string {
  const spanId = randomUUID();
  const record = { ...event, spanId, ts: new Date().toISOString() };
  // Fail-closed: every line written must satisfy the TraceEvent contract.
  const parsed = TraceEventSchema.parse(record);
  const line = JSON.stringify(parsed)
    .replace(PHONE_RE, "MASKED_PHONE")
    .replace(EMAIL_RE, "MASKED_EMAIL");
  mkdirSync(tracesDir, { recursive: true });
  appendFileSync(path.join(tracesDir, `${event.runId}.jsonl`), `${line}\n`, "utf8");
  return spanId;
}
