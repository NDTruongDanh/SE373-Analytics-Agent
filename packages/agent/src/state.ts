import {
  ReducedValue,
  StateSchema,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { SQLAnswerStatusSchema } from "@shared/contracts";
import * as z from "zod";

// AGENT-01 shared root state (01-10). Plain JSON only: no Pool, class
// instance, function, or pg import may ever enter this schema — checkpoint
// payloads serialize verbatim into PostgresSaver rows owned by 01-13/01-14.
// The full <=1000-row buffer lives in transient RAM outside state per
// architecture section 4.3; only resultPreview (<=50 rows) is checkpointed.

/** Hard cap on checkpointed preview rows (T-01-10-02 mitigation). */
export const RESULT_PREVIEW_MAX = 50;

/** Run-level budget limits (D-13). The 01-11 breaker enforces these. */
export const BUDGET_DEFAULTS = {
  maxLlmCalls: 20,
  maxTokens: 60000,
  runDeadlineMs: 120000,
} as const;

const IntentSchema = z.object({
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
});

const SemanticChunkSchema = z.object({
  chunkId: z.string().min(1),
  score: z.number().optional(),
  text: z.string().optional(),
});

const BudgetStateSchema = z
  .object({
    llmCalls: z.number().int().nonnegative().default(0),
    tokensUsed: z.number().int().nonnegative().default(0),
    maxLlmCalls: z.number().int().positive().default(BUDGET_DEFAULTS.maxLlmCalls),
    maxTokens: z.number().int().positive().default(BUDGET_DEFAULTS.maxTokens),
    runDeadlineMs: z
      .number()
      .int()
      .positive()
      .default(BUDGET_DEFAULTS.runDeadlineMs),
  })
  // Object-level default seeds the reducer channel so limits are present on
  // a fresh run and partial writes merge against full defaults (D-13).
  .default(() => ({
    llmCalls: 0,
    tokensUsed: 0,
    maxLlmCalls: BUDGET_DEFAULTS.maxLlmCalls,
    maxTokens: BUDGET_DEFAULTS.maxTokens,
    runDeadlineMs: BUDGET_DEFAULTS.runDeadlineMs,
  }));
type BudgetState = z.infer<typeof BudgetStateSchema>;
const BudgetUpdateSchema = z.object({
  llmCalls: z.number().int().nonnegative().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  maxLlmCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  runDeadlineMs: z.number().int().positive().optional(),
});
type BudgetUpdate = z.infer<typeof BudgetUpdateSchema>;

const TelemetryStateSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().default(0),
    completionTokens: z.number().int().nonnegative().default(0),
    latencyMs: z.number().nonnegative().default(0),
  })
  // Seeds the reducer channel with zero counters (same pattern as budget).
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
  /** UC id the router dispatches on; "" or unknown ids fall to the default route. */
  ucId: z.string().default(""),
  intent: IntentSchema.default(() => ({
    metric: null,
    dimensions: [],
    filters: [],
    timeRange: null,
  })),
  semanticChunks: z.array(SemanticChunkSchema).default([]),
  /** Checkpointed preview: zod max rejects anything over 50 rows. */
  resultPreview: z
    .array(z.record(z.string(), z.unknown()))
    .max(RESULT_PREVIEW_MAX)
    .default([]),
  columns: z.array(z.string()).default([]),
  sql: z.string().nullable().default(null),
  tablesUsed: z.array(z.string()).default([]),
  toolsCalled: z.array(z.string()).default([]),
  /** 1.0.0 answer statuses (D-02): ok/no_data continue to VIZ, the rest synthesize. */
  status: SQLAnswerStatusSchema.default("no_data"),
  answerText: z.string().default(""),
  /** Additive counters merge across nodes; limits survive reduction. */
  budget: new ReducedValue(BudgetStateSchema, {
    inputSchema: BudgetUpdateSchema,
    reducer: (current: BudgetState, next: BudgetUpdate): BudgetState => ({
      llmCalls: current.llmCalls + (next.llmCalls ?? 0),
      tokensUsed: current.tokensUsed + (next.tokensUsed ?? 0),
      maxLlmCalls: next.maxLlmCalls ?? current.maxLlmCalls,
      maxTokens: next.maxTokens ?? current.maxTokens,
      runDeadlineMs: next.runDeadlineMs ?? current.runDeadlineMs,
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
  /** VIZ seam output (JSON only); set by the injected VIZ implementation. */
  vizSpec: z.unknown().nullable().default(null),
  /** Clarification options carried for the 01-12 HITL resume path. */
  pendingClarification: z.array(z.string()).nullable().default(null),
});

export type AgentState = typeof AgentStateSchema.State;
export type AgentUpdate = typeof AgentStateSchema.Update;
export type AgentStatus = AgentState["status"];

// Shared root contracts (consumed by graph.ts, registry.ts, and sibling
// plans 01-11/01-12/01-13 through RootGraphDeps — none of them edit state.ts
// to satisfy these shapes).

/** Span fields every emitter stamps; the writer fills run identity. */
export interface SpanEvent {
  node: string;
  type: string;
  durationMs: number;
  payload?: unknown;
  parentSpanId?: string;
  attempt?: number;
}

export type SpanEmitter = (event: SpanEvent) => string;

/** Runtime handed to every injected implementation: span sink + run config. */
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
