import { z } from "zod";
import { AnomalyAlertSchema } from "./alert.js";
import { AnalysisPlanSchema, RootCauseAnswerSchema } from "./rca.js";
import {
  CHART_TYPE_TO_COMPONENT,
  ChartTypeSchema,
  OpenuiChartSpecSchema,
} from "./render.js";

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
  "needs_clarification",
  "restricted",
  "error",
  "false_premise",
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
  caveats: z.array(z.string()).default([]),
  governed: z.boolean().optional(),
  telemetry: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    embeddingTokens: z.number().int().nonnegative().default(0),
    estimatedCostUsd: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
  }),
});

export type SQLAnswer = z.infer<typeof SQLAnswerSchema>;

export const SqlAnswerResponseSchema = SQLAnswerSchema.extend({
  kind: z.literal("sql_answer"),
});

export type SqlAnswerResponse = z.infer<typeof SqlAnswerResponseSchema>;

const AgentEnvelopeBaseSchema = z.object({
  status: SQLAnswerStatusSchema,
  summary: z.string().min(1),
  data: z.unknown(),
});

export const EvidencePointerSchema = z.object({
  column: z.string().min(1).max(128),
  rowKey: z.string().min(1).max(256),
  value: z.union([z.number(), z.string().min(1).max(1000)]),
});

export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

export const ClaimDerivationSchema = z.enum([
  "cell",
  "pct_change",
  "pp_change",
  "share_of_total",
  "sum",
  "mean",
  "rank",
]);

export type ClaimDerivation = z.infer<typeof ClaimDerivationSchema>;

export const InsightClaimSchema = z.object({
  claim: z.string().min(1).max(2000),
  derivation: ClaimDerivationSchema.optional(),
  evidence: z.array(EvidencePointerSchema).min(1),
});

export type InsightClaim = z.infer<typeof InsightClaimSchema>;

export const InsightChartTypeSchema = ChartTypeSchema;

export type InsightChartType = z.infer<typeof InsightChartTypeSchema>;

export const InsightReportSchema = z.object({
  chartType: InsightChartTypeSchema,
  chartSpec: OpenuiChartSpecSchema,
  chartReason: z.string().min(1).max(500),
  insights: z.array(InsightClaimSchema).max(10),
  caveats: z.array(z.string().min(1).max(500)).default([]),
}).superRefine((report, ctx) => {
  const expected = CHART_TYPE_TO_COMPONENT[report.chartType];
  if (report.chartSpec.chart !== expected) {
    ctx.addIssue({
      code: "custom",
      message: `chartType "${report.chartType}" requires chartSpec.chart "${expected}", got "${report.chartSpec.chart}"`,
      path: ["chartSpec", "chart"],
    });
  }
});

export type InsightReport = z.infer<typeof InsightReportSchema>;

export const InsightReportResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("insight_report"),
  data: InsightReportSchema,
});

export type InsightReportResponse = z.infer<typeof InsightReportResponseSchema>;

export const AnalysisPlanResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("analysis_plan"),
  data: AnalysisPlanSchema,
});

export type AnalysisPlanResponse = z.infer<typeof AnalysisPlanResponseSchema>;

export const RootCauseResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("root_cause"),
  data: RootCauseAnswerSchema,
});

export type RootCauseResponse = z.infer<typeof RootCauseResponseSchema>;

export const AnomalyAlertResponseSchema = AgentEnvelopeBaseSchema.extend({
  kind: z.literal("anomaly_alert"),
  data: AnomalyAlertSchema,
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

export { SSE_EVENT_NAMES } from "./constants.js";

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
  checkpointId: z.string().min(1).optional(),
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
