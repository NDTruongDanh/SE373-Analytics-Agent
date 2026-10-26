import * as z from "zod";

// Single answer contract shared by UC-01 and UC-02 (UC-01 section 3.1/3.2,
// UC-02 Feature 5). camelCase is the canonical shape; UC-02's snake_case
// variants are not added — one shape per the freeze (see README).

export const SqlAttemptSchema = z.object({
  attemptNo: z.number().int(),
  sql: z.string().nullable(),
  schemaRefs: z.array(z.string()),
  validation: z.string(),
  explainSummary: z.string().optional(),
  execution: z.unknown().optional(),
  diagnostic: z.string().optional(),
  repairReason: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export type SqlAttempt = z.infer<typeof SqlAttemptSchema>;

const IntentFilterSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.unknown(),
});

export const SQLAnswerStatusSchema = z.enum([
  "ok",
  "no_data",
  "cannot_answer",
  "error",
]);

export const SQLAnswerSchema = z.object({
  intent: z.object({
    metric: z.string().nullable(),
    dimensions: z.array(z.string()),
    filters: z.array(IntentFilterSchema),
    timeRange: z.string().nullable(),
  }),
  sql: z.string().nullable(),
  tablesUsed: z.array(z.string()),
  citations: z.array(z.string()).default([]),
  attempts: z.array(SqlAttemptSchema).max(3),
  resultPreview: z.array(z.record(z.string(), z.unknown())).max(50),
  answerText: z.string().min(1),
  status: SQLAnswerStatusSchema,
  telemetry: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    embeddingTokens: z.number().int().nonnegative().default(0),
    estimatedCostUsd: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
  }),
});

export type SQLAnswer = z.infer<typeof SQLAnswerSchema>;

// AgentResponse: kind-discriminated union (CONT-07). The sql_answer variant
// carries the full SQLAnswer shape; the four envelope variants carry a
// status, a non-empty summary, and an unknown-typed data payload owned by
// the later UC phases (UC-03 insight, UC-05 plan/root-cause, UC-10 alert).

export const SqlAnswerResponseSchema = SQLAnswerSchema.extend({
  kind: z.literal("sql_answer"),
});

export type SqlAnswerResponse = z.infer<typeof SqlAnswerResponseSchema>;

const AgentEnvelopeBaseSchema = z.object({
  status: SQLAnswerStatusSchema,
  summary: z.string().min(1),
  data: z.unknown(),
});

export const InsightReportResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("insight_report"),
});

export type InsightReportResponse = z.infer<typeof InsightReportResponseSchema>;

export const AnalysisPlanResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("analysis_plan"),
});

export type AnalysisPlanResponse = z.infer<typeof AnalysisPlanResponseSchema>;

export const RootCauseResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("root_cause"),
});

export type RootCauseResponse = z.infer<typeof RootCauseResponseSchema>;

export const AnomalyAlertResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("anomaly_alert"),
});

export type AnomalyAlertResponse = z.infer<typeof AnomalyAlertResponseSchema>;

export const AgentResponseSchema = z.discriminatedUnion("kind", [
  SqlAnswerResponseSchema,
  InsightReportResponseSchema,
  AnalysisPlanResponseSchema,
  RootCauseResponseSchema,
  AnomalyAlertResponseSchema,
]);

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// SSE progress payloads (D-20): one zod schema per allowlisted progress
// event plus the SseProgressEventSchema union, so the 01-14 SSE host can
// import them from contracts without a new file. Payloads stay unknown at
// this layer; the 01-14 sanitizer whitelists fields before emitting.

export const SseEventNameSchema = z.enum([
  "intent_parsed",
  "schema_retrieved",
  "sql_generated",
  "sql_repaired",
  "query_running",
  "viz",
  "completed",
  "failed",
  "interrupt_waiting",
]);

export type SseEventName = z.infer<typeof SseEventNameSchema>;

export const SSE_EVENT_NAMES: readonly SseEventName[] =
  SseEventNameSchema.options;

const SseBaseFields = {
  runId: z.string().min(1),
  threadId: z.string().min(1),
  node: z.string().min(1).optional(),
};

export const SseIntentParsedEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("intent_parsed"),
  data: z.unknown().optional(),
});

export const SseSchemaRetrievedEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("schema_retrieved"),
  data: z.unknown().optional(),
});

export const SseSqlGeneratedEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("sql_generated"),
  data: z.unknown().optional(),
});

export const SseSqlRepairedEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("sql_repaired"),
  data: z.unknown().optional(),
});

export const SseQueryRunningEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("query_running"),
  data: z.unknown().optional(),
});

export const SseVizEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("viz"),
  data: z.unknown().optional(),
});

export const SseCompletedEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("completed"),
  data: z.unknown().optional(),
});

export const SseFailedEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("failed"),
  data: z.unknown().optional(),
});

export const SseInterruptWaitingEventSchema = z.object({
  ...SseBaseFields,
  event: z.literal("interrupt_waiting"),
  data: z.unknown().optional(),
});

export const SseProgressEventSchema = z.discriminatedUnion("event", [
  SseIntentParsedEventSchema,
  SseSchemaRetrievedEventSchema,
  SseSqlGeneratedEventSchema,
  SseSqlRepairedEventSchema,
  SseQueryRunningEventSchema,
  SseVizEventSchema,
  SseCompletedEventSchema,
  SseFailedEventSchema,
  SseInterruptWaitingEventSchema,
]);

export type SseProgressEvent = z.infer<typeof SseProgressEventSchema>;
