import * as z from "zod";

// Trace event envelope (PRD 4.4): every run carries a runId; each event
// records who, which node, what happened, when, and how long it took.
// Trace and log payloads must never contain unredacted PII values.

export const TraceEventSchema = z.object({
  runId: z.string().min(1),
  threadId: z.string().min(1),
  userId: z.string().min(1),
  role: z.string().min(1),
  node: z.string().min(1),
  type: z.string().min(1),
  ts: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  payload: z.unknown().optional(),
  // CONT-05 span fields (additive): link events into a causal chain for
  // OBS-01 traces. Optional so older writers stay valid.
  spanId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  attempt: z.number().int().nonnegative().optional(),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;
