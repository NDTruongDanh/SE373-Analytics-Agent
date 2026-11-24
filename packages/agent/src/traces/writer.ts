import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactPII, redactRow } from "@shared/access-policy";
import { TraceEventSchema } from "@shared/contracts";

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
  redacted: boolean;
  file: string;
}

// Key-aware cell redaction first; appendTraceEvent runs a serialized PII scan backstop for any remaining shapes.
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

export function appendTraceEvent(
  event: TracerTraceEvent,
  tracesDir = "traces",
): AppendResult {
  const spanId = randomUUID();
  const { payload, hit: rowHit } = redactPayloadRows(event.payload);
  const record = { ...event, payload, spanId, ts: new Date().toISOString() };
  const parsed = TraceEventSchema.parse(record);
  const { redacted, hit: textHit } = redactPII(JSON.stringify(parsed));
  mkdirSync(tracesDir, { recursive: true });
  const file = path.join(tracesDir, `${event.runId}.jsonl`);
  appendFileSync(file, `${redacted}\n`, "utf8");
  return { spanId, redacted: rowHit || textHit, file };
}

export function writeTraceEvent(
  event: TracerTraceEvent,
  tracesDir = "traces",
): string {
  return appendTraceEvent(event, tracesDir).spanId;
}
