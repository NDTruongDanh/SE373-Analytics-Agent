import { z } from "zod";
import { AnomalyAlertSchema } from "./alert.js";
import { AnalysisPlanSchema, RootCauseAnswerSchema } from "./rca.js";
import {
  CHART_TYPE_TO_COMPONENT,
  ChartTypeSchema,
  OpenuiChartSpecSchema,
} from "./render.js";

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
// carries the full SQLAnswer shape; the analysis_plan and root_cause variants
// carry strict UC-05 payloads, and the insight_report variant carries the
// strict UC-03 InsightReportSchema below. Only anomaly_alert still carries an
// unknown-typed data payload (owned by UC-10).

export const SqlAnswerResponseSchema = SQLAnswerSchema.extend({
  kind: z.literal("sql_answer"),
});

export type SqlAnswerResponse = z.infer<typeof SqlAnswerResponseSchema>;

const AgentEnvelopeBaseSchema = z.object({
  status: SQLAnswerStatusSchema,
  summary: z.string().min(1),
  data: z.unknown(),
});

// UC-03 evidence-backed insight payload (PRD UC-03, architecture §3.2 K7).
// Every number in an insight claim must trace to an EvidencePointer whose
// column/rowKey/value cell exists in RunQueryOutput; the numeric validator
// re-checks the match within <= 1% rounding tolerance. camelCase is canonical.

// Single query cell backing one number or label inside a claim.
export const EvidencePointerSchema = z.object({
  column: z.string().min(1).max(128),
  rowKey: z.string().min(1).max(256),
  value: z.union([z.number(), z.string().min(1).max(1000)]),
});

export type EvidencePointer = z.infer<typeof EvidencePointerSchema>;

// One natural-language finding plus the pointers that prove it. evidence must
// be non-empty so no claim ships without at least one verifiable cell.
export const InsightClaimSchema = z.object({
  claim: z.string().min(1).max(2000),
  evidence: z.array(EvidencePointerSchema).min(1),
});

export type InsightClaim = z.infer<typeof InsightClaimSchema>;

// Chart selector canonical in RenderChartInputSchema (contracts/render.ts):
// line = trends via OpenUI LineChart, bar = comparisons via BarChart,
// pie = share of 2-6 groups via PieChart, scatter = correlations via
// ScatterChart, table = detail rows via Table, none = scalar/no_data.
// This alias keeps the UC-03 import surface (`InsightChartTypeSchema`) stable.
export const InsightChartTypeSchema = ChartTypeSchema;

export type InsightChartType = z.infer<typeof InsightChartTypeSchema>;

// Full UC-03 report: OpenUI chart spec plus verified insights. chartSpec is
// a strict OpenUI genui-lib mirror (render.ts) — it serializes
// deterministically to OpenUI Lang (e.g. `chart = BarChart(labels, series)`)
// for the web <Renderer/>. chartType must match the spec component
// (CHART_TYPE_TO_COMPONENT). insights may be empty only for chartType
// "none" / status "no_data" — the K7 validator strips unverified claims and
// requires caveats there.
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
  data: AnomalyAlertSchema, // <--- Bổ sung dòng này để siết chặt validation
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
