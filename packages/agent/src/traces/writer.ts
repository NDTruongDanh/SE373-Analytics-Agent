import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactPII, redactRow } from "@se373/access-policy";
import { TraceEventSchema } from "@se373/contracts";

// Full OBS-01 TraceWriter (01-09 expansion of the 01-01 TRACER slice): stamps
// runId/threadId/spanId via randomUUID (D-13), redacts every payload through
// the shared @se373/access-policy redactor before serialization, and appends
// one JSON line per event under traces/<runId>.jsonl. No inline mask remains.

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

export interface AppendResult {
  spanId: string;
  /** True when the shared redactor masked at least one value in this event. */
  redacted: boolean;
  file: string;
}

// Row-level first pass: plain-record payloads (single rows or row arrays,
// e.g. resultPreview) go through redactRow so string cells are masked in
// place. The stringify-and-scan backstop in appendTraceEvent catches PII in
// any other payload shape.
function redactPayloadRows(payload: unknown): {
  payload: unknown;
  hit: boolean;
} {
  let hit = false;
  if (Array.isArray(payload)) {
    if (
      payload.every(
        (entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    ) {
      const rows = payload.map((entry) => {
        const { row, hit: cellHit } = redactRow({
          ...(entry as Record<string, unknown>),
        });
        hit = hit || cellHit;
        return row;
      });
      return { payload: rows, hit };
    }
    return { payload, hit };
  }
  if (typeof payload === "object" && payload !== null) {
    const { row, hit: cellHit } = redactRow({
      ...(payload as Record<string, unknown>),
    });
    return { payload: row, hit: cellHit };
  }
  return { payload, hit };
}

/**
 * Append one redacted event; return its spanId plus the redactor hit flag
 * and the file written so audit layers can record masking decisions.
 * The on-disk line carries redacted text only.
 */
export function appendTraceEvent(
  event: TracerTraceEvent,
  tracesDir = "traces",
): AppendResult {
  const spanId = randomUUID();
  const { payload, hit: rowHit } = redactPayloadRows(event.payload);
  const record = { ...event, payload, spanId, ts: new Date().toISOString() };
  // Fail-closed: every line written must satisfy the TraceEvent contract.
  const parsed = TraceEventSchema.parse(record);
  const { redacted, hit: textHit } = redactPII(JSON.stringify(parsed));
  mkdirSync(tracesDir, { recursive: true });
  const file = path.join(tracesDir, `${event.runId}.jsonl`);
  appendFileSync(file, `${redacted}\n`, "utf8");
  return { spanId, redacted: rowHit || textHit, file };
}

/**
 * Append one redacted event; return its spanId for chaining.
 * Kept for the 01-01 graph/tracer call sites (01-10 owns graph.ts):
 * the inline mask is gone, redaction now runs through the shared redactor.
 */
export function writeTraceEvent(
  event: TracerTraceEvent,
  tracesDir = "traces",
): string {
  return appendTraceEvent(event, tracesDir).spanId;
}
