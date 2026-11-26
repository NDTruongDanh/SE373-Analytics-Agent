import {
  ReducedValue,
  StateSchema,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import {
  AnalysisPlanSchema,
  RootCauseAnswerSchema,
  SQLAnswerStatusSchema,
} from "@shared/contracts";
import { z } from "zod";
import { BUDGET_DEFAULTS, RESULT_PREVIEW_MAX } from "./constants.js";

export { BUDGET_DEFAULTS, RESULT_PREVIEW_MAX } from "./constants.js";

// Plain JSON only (no Pool, class instances, or functions): checkpoints serialize verbatim to PostgresSaver.
// Keep full query buffers outside state; only the <=50-row resultPreview is checkpointed.

export const IntentSchema = z.object({
  metric: z.string().nullable().default(null),
  dimensions: z.array(z.string()).default([]),
  filters: z
    .array(
      z.object({
        field: z.string(),
        operator: z.string(),
        value: z.unknown(),
      }),
    )
    .default([]),
  timeRange: z.string().nullable().default(null),
  requestedMetrics: z.array(z.string()).default([]),
  schemaEntities: z.array(z.string()).default([]),
  queryMode: z.enum(["standard_query", "definition_lookup"]).default("standard_query"),
});

export const ClarificationFieldSchema = z.enum([
  "metric",
  "timeRange",
  "scope",
  "filterValue",
  "table",
]);
export type ClarificationField = z.infer<typeof ClarificationFieldSchema>;

export const PendingClarificationSchema = z.object({
  field: ClarificationFieldSchema,
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(4),
  attempts: z.number().int().min(0).max(2),
});
export type PendingClarification = z.infer<typeof PendingClarificationSchema>;

const SemanticChunkSchema = z.object({
  chunkId: z.string().min(1),
  docType: z
    .enum(["table", "column", "metric", "join_rule", "example", "event"])
    .optional(),
  table: z.string().nullable().optional(),
  tables: z.array(z.string()).optional(),
  score: z.number().optional(),
  text: z.string().optional(),
  aliasMatched: z.boolean().optional(),
  denseScore: z.number().optional(),
});

export const CatalogTableSchema = z.object({
  name: z.string().min(1).max(128),
  schema: z.string().default("public"),
  description: z.string().max(500).optional(),
});
export type CatalogTable = z.infer<typeof CatalogTableSchema>;

const BudgetStateSchema = z
  .object({
    llmCalls: z.number().int().nonnegative().default(0),
    tokensUsed: z.number().int().nonnegative().default(0),
    maxLlmCalls: z.number().int().positive().default(BUDGET_DEFAULTS.maxLlmCalls),
    maxTokens: z.number().int().positive().default(BUDGET_DEFAULTS.maxTokens),
    deadlineMs: z
      .number()
      .int()
      .nonnegative()
      .default(0),
  })
  // Seed reducer defaults at the object level so partial writes merge against full limits on fresh runs.
  .default(() => ({
    llmCalls: 0,
    tokensUsed: 0,
    maxLlmCalls: BUDGET_DEFAULTS.maxLlmCalls,
    maxTokens: BUDGET_DEFAULTS.maxTokens,
    deadlineMs: 0,
  }));
type BudgetState = z.infer<typeof BudgetStateSchema>;
const BudgetUpdateSchema = z.object({
  llmCalls: z.number().int().nonnegative().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  maxLlmCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  deadlineMs: z.number().int().nonnegative().optional(),
});
type BudgetUpdate = z.infer<typeof BudgetUpdateSchema>;

const TelemetryStateSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().default(0),
    completionTokens: z.number().int().nonnegative().default(0),
    latencyMs: z.number().nonnegative().default(0),
  })
  .default(() => ({ promptTokens: 0, completionTokens: 0, latencyMs: 0 }));
type TelemetryState = z.infer<typeof TelemetryStateSchema>;
const TelemetryUpdateSchema = z.object({
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
});
type TelemetryUpdate = z.infer<typeof TelemetryUpdateSchema>;

export const AgentStateSchema = new StateSchema({
  question: z.string().default(""),
  ucId: z.string().default(""),
  intent: IntentSchema.default(() => ({
    metric: null,
    dimensions: [],
    filters: [],
    timeRange: null,
    requestedMetrics: [],
    schemaEntities: [],
    queryMode: "standard_query" as const,
  })),
  semanticChunks: z.array(SemanticChunkSchema).default([]),
  catalogTables: z.array(CatalogTableSchema).default([]),
  catalogStatus: z.enum(["unloaded", "ready", "empty", "error"]).default("unloaded"),
  semanticQuery: z.string().nullable().default(null),
  semanticRetrieveStatus: z.enum(["unloaded", "ok", "error"]).default("unloaded"),
  semanticErrorCode: z.string().nullable().default(null),
  resultPreview: z
    .array(z.record(z.string(), z.unknown()))
    .max(RESULT_PREVIEW_MAX)
    .default([]),
  resultTruncated: z.boolean().default(false),
  rowCount: z.number().int().nonnegative().nullable().default(null),
  columns: z.array(z.string()).default([]),
  sql: z.string().nullable().default(null),
  tablesUsed: z.array(z.string()).default([]),
  toolsCalled: z.array(z.string()).default([]),
  status: SQLAnswerStatusSchema.default("no_data"),
  answerText: z.string().default(""),
  budgetExceeded: z.boolean().default(false),
  budget: new ReducedValue(BudgetStateSchema, {
    inputSchema: BudgetUpdateSchema,
    reducer: (current: BudgetState, next: BudgetUpdate): BudgetState => ({
      llmCalls: current.llmCalls + (next.llmCalls ?? 0),
      tokensUsed: current.tokensUsed + (next.tokensUsed ?? 0),
      maxLlmCalls: next.maxLlmCalls ?? current.maxLlmCalls,
      maxTokens: next.maxTokens ?? current.maxTokens,
      deadlineMs: next.deadlineMs ?? current.deadlineMs,
    }),
  }),
  telemetry: new ReducedValue(TelemetryStateSchema, {
    inputSchema: TelemetryUpdateSchema,
    reducer: (current: TelemetryState, next: TelemetryUpdate): TelemetryState => ({
      promptTokens: current.promptTokens + (next.promptTokens ?? 0),
      completionTokens: current.completionTokens + (next.completionTokens ?? 0),
      latencyMs: current.latencyMs + (next.latencyMs ?? 0),
    }),
  }),
  runId: z.string().default(""),
  threadId: z.string().default(""),
  vizSpec: z.unknown().nullable().default(null),
  pendingClarification: PendingClarificationSchema.nullable().default(null),
  clarificationAttempts: z.number().int().min(0).max(2).default(0),
  analysisPlan: AnalysisPlanSchema.nullable().default(null),
  rootCauseAnswer: RootCauseAnswerSchema.nullable().default(null),
});

export type AgentState = typeof AgentStateSchema.State;
export type AgentUpdate = typeof AgentStateSchema.Update;
export type AgentStatus = AgentState["status"];

export interface SpanEvent {
  node: string;
  type: string;
  durationMs: number;
  payload?: unknown;
  parentSpanId?: string;
  attempt?: number;
}

export type SpanEmitter = (event: SpanEvent) => string;

export interface RootRuntime {
  emit: SpanEmitter;
  config: LangGraphRunnableConfig;
}

export type RetrieveFn = (
  state: AgentState,
  rt: RootRuntime,
) => Promise<AgentUpdate>;

export type UcEntryHandler = (
  state: AgentState,
  rt: RootRuntime,
) => Promise<AgentUpdate>;

export type VizFn = (state: AgentState, rt: RootRuntime) => Promise<AgentUpdate>;

export type SynthesizeFn = (
  state: AgentState,
  rt: RootRuntime,
) => Promise<AgentUpdate>;
