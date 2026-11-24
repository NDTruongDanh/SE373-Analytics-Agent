import { z } from "zod";

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
  spanId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  attempt: z.number().int().nonnegative().optional(),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;
