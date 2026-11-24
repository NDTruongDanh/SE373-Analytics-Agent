import { appendTraceEvent } from "../traces/writer.js";
import type { SpanEmitter, SpanEvent } from "../state.js";
import type { ExecutorSpan, SpanSink } from "../queryExecutor/executor.js";
import type { RowScopeApplied } from "@shared/access-policy";

export {
  buildLangSmithRunConfig,
  createLangSmithTracer,
  flushLangSmith,
  isLangSmithEnabled,
  langSmithClientCountForTests,
  LANGSMITH_ENV_FLAGS,
  LANGSMITH_PROJECT_DEFAULT,
  piiSafeProcessor,
  PiiSafeLangChainTracer,
  resetLangSmithForTests,
  scrubLangSmithEnv,
  scrubSerialized,
  type AnonymizerValues,
  type CreateTracerOptions,
  type LangSmithRunConfig,
  type LangSmithRunMeta,
} from "./langsmith.js";

export {
  buildTraceTree,
  deriveSummary,
  joinAudits,
  nestEvents,
  type TraceApprovals,
  type TraceSummary,
  type TraceTree,
  type TreeAuditLine,
  type TreeInputEvent,
  type TreeNode,
} from "./traceTree.js";

export {
  isRateLimitFailure,
  ModelRetryError,
  resolveModelRetryConfig,
  toModelDbToolError,
  type ModelRetryConfig,
} from "./retry.js";

export interface SpanContext {
  runId: string;
  threadId: string;
  userId: string;
  role: string;
  tracesDir?: string;
}

export type IncomingSpan = SpanEvent | ExecutorSpan;

export type ChildEmit = (event: IncomingSpan) => string;

export interface RunTotals {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  sqlAttempts: number;
  sqlFailures: number;
  repairs: number;
}

export interface AgentSpanEmitter extends SpanEmitter, SpanSink {
  span<T>(
    node: string,
    type: string,
    fn: (child: ChildEmit) => Promise<T>,
    opts?: { parentSpanId?: string; attempt?: number },
  ): Promise<T>;
  emitSkillCall(
    skill: string,
    opts?: { parentSpanId?: string; attempt?: number },
  ): string;
  emitLlmCall(
    node: string,
    opts?: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCostUsd?: number;
      pricingKnown?: boolean;
      durationMs?: number;
      parentSpanId?: string;
      attempt?: number;
    },
  ): string;
  emitToolCall(
    node: string,
    tool: string,
    opts?: {
      rowCount?: number;
      columns?: string[];
      maskedColumns?: string[];
      rowScopeApplied?: RowScopeApplied[];
      parentSpanId?: string;
      attempt?: number;
    },
  ): string;
  totals(): RunTotals;
  emitRunDone(
    status: string,
    opts?: { parentSpanId?: string; attempt?: number },
  ): string;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPayloadRecord(event: IncomingSpan): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** Accumulate per-run totals; repair node_done counts independently of whether a run_query failed. */
function observeTotals(totals: RunTotals, event: IncomingSpan): void {
  if (event.type === "llm_call") {
    totals.llmCalls += 1;
    const payload = asPayloadRecord(event);
    const input = asFiniteNumber(payload["inputTokens"]);
    const output = asFiniteNumber(payload["outputTokens"]);
    const cost = asFiniteNumber(payload["estimatedCostUsd"]);
    if (input !== null) totals.inputTokens += Math.max(0, Math.floor(input));
    if (output !== null) totals.outputTokens += Math.max(0, Math.floor(output));
    if (cost !== null) totals.estimatedCostUsd += Math.max(0, cost);
    return;
  }
  if (event.type === "tool_call") {
    totals.toolCalls += 1;
    const payload = asPayloadRecord(event);
    if (payload["tool"] === "run_query") {
      totals.sqlAttempts += 1;
      if (payload["ok"] === false) totals.sqlFailures += 1;
    }
    return;
  }
  if (event.type === "node_done" && event.node === "repair") {
    totals.repairs += 1;
  }
}

export function createSpanEmitter(ctx: SpanContext): AgentSpanEmitter {
  const tracesDir = ctx.tracesDir ?? "traces";
  // Per-run state only (never module globals) so concurrent runs cannot cross-talk.
  const totals: RunTotals = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    toolCalls: 0,
    sqlAttempts: 0,
    sqlFailures: 0,
    repairs: 0,
  };

  const base = (event: IncomingSpan): string => {
    observeTotals(totals, event);
    return appendTraceEvent(
      {
        runId: ctx.runId,
        threadId: ctx.threadId,
        userId: ctx.userId,
        role: ctx.role,
        node: event.node,
        type: event.type,
        durationMs: event.durationMs ?? 0,
        payload: event.payload,
        parentSpanId: event.parentSpanId,
        attempt: event.attempt,
      },
      tracesDir,
    ).spanId;
  };

  const emitter = base as AgentSpanEmitter;

  emitter.span = async <T>(
    node: string,
    type: string,
    fn: (child: ChildEmit) => Promise<T>,
    opts: { parentSpanId?: string; attempt?: number } = {},
  ): Promise<T> => {
    const startId = base({
      node,
      type,
      durationMs: 0,
      payload: { phase: "start" },
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });
    const child: ChildEmit = (event) =>
      base({
        node: event.node,
        type: event.type,
        durationMs: event.durationMs ?? 0,
        payload: event.payload,
        parentSpanId: startId,
        attempt: event.attempt,
      });
    const started = Date.now();
    try {
      const value = await fn(child);
      base({
        node,
        type,
        durationMs: Date.now() - started,
        payload: { phase: "end", ok: true },
        parentSpanId: startId,
        attempt: opts.attempt,
      });
      return value;
    } catch (error) {
      base({
        node,
        type,
        durationMs: Date.now() - started,
        payload: { phase: "end", ok: false },
        parentSpanId: startId,
        attempt: opts.attempt,
      });
      throw error;
    }
  };

  emitter.emitSkillCall = (
    skill: string,
    opts: { parentSpanId?: string; attempt?: number } = {},
  ): string =>
    base({
      node: "skills",
      type: "skill_call",
      durationMs: 0,
      payload: { skill },
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });

  emitter.totals = (): RunTotals => ({ ...totals });

  emitter.emitRunDone = (
    status: string,
    opts: { parentSpanId?: string; attempt?: number } = {},
  ): string =>
    base({
      node: "answer",
      type: "run_done",
      durationMs: 0,
      payload: { status, ...totals },
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });

  emitter.emitLlmCall = (
    node: string,
    opts: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCostUsd?: number;
      pricingKnown?: boolean;
      durationMs?: number;
      parentSpanId?: string;
      attempt?: number;
    } = {},
  ): string =>
    base({
      node,
      type: "llm_call",
      durationMs: opts.durationMs ?? 0,
      payload: {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.inputTokens !== undefined ? { inputTokens: opts.inputTokens } : {}),
        ...(opts.outputTokens !== undefined ? { outputTokens: opts.outputTokens } : {}),
        ...(opts.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: opts.estimatedCostUsd }
          : {}),
        ...(opts.pricingKnown !== undefined ? { pricingKnown: opts.pricingKnown } : {}),
      },
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });

  emitter.emitToolCall = (
    node: string,
    tool: string,
    opts: {
      rowCount?: number;
      columns?: string[];
      maskedColumns?: string[];
      rowScopeApplied?: RowScopeApplied[];
      ok?: boolean;
      /** Contract error code only — never message or PII. */
      code?: string;
      parentSpanId?: string;
      attempt?: number;
    } = {},
  ): string =>
    base({
      node,
      type: "tool_call",
      durationMs: 0,
      payload: {
        tool,
        ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
        ...(opts.code !== undefined ? { code: opts.code } : {}),
        ...(opts.rowCount !== undefined ? { rowCount: opts.rowCount } : {}),
        ...(opts.columns !== undefined ? { columns: opts.columns } : {}),
        ...(opts.maskedColumns !== undefined ? { maskedColumns: opts.maskedColumns } : {}),
        ...(opts.rowScopeApplied !== undefined
          ? { rowScopeApplied: opts.rowScopeApplied }
          : {}),
      },
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });

  return emitter;
}
