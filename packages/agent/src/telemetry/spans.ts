// Hierarchical span emitter (AGENT-07, 01-12): stamps spanId via randomUUID
// (D-13) plus optional parentSpanId and attempt, and delegates every write
// to the 01-09 redacted TraceWriter — redaction-before-write is inherited,
// never a local copy. Payloads carry counts and column names only, never
// cell values. The base callable satisfies both the 01-10 SpanEmitter and
// the 01-11 SpanSink (incoming spanId values are ignored: the writer mints).

import { appendTraceEvent } from "../traces/writer.js";
import type { SpanEmitter, SpanEvent } from "../state.js";
import type { ExecutorSpan, SpanSink } from "../queryExecutor/executor.js";
import type { RowScopeApplied } from "@shared/access-policy";

// Phase 3 LangSmith export surface, re-exported here so hosts keep a
// single `@shared/agent/telemetry` import (the package exports map points
// that subpath at this module; the map itself stays untouched).
export {
  buildLangSmithRunConfig,
  createLangSmithTracer,
  flushLangSmith,
  isLangSmithEnabled,
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

// Phase 3 G4 trace viewer model, re-exported here so viewers and future
// web code share one `@shared/agent/telemetry` import (the package exports
// map points that subpath at this module; the map itself stays untouched).
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

export interface SpanContext {
  runId: string;
  threadId: string;
  userId: string;
  role: string;
  tracesDir?: string;
}

/** Either sibling-plan span shape; normalized before the single write path. */
export type IncomingSpan = SpanEvent | ExecutorSpan;

/** Child emitter bound to one parent span id by span(). */
export type ChildEmit = (event: IncomingSpan) => string;

/** Per-run roll-up for the terminal run_done span (Phase 3 G3). */
export interface RunTotals {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  sqlAttempts: number;
  sqlFailures: number;
}

export interface AgentSpanEmitter extends SpanEmitter, SpanSink {
  /**
   * Run fn between a start and an end event, handing it a child emitter
   * bound to the start span. Resolves with fn's value; the end event is
   * written on both success and failure (ok flag), then errors rethrow.
   */
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
  /**
   * Snapshot of the per-run roll-up so far (a copy, never live state).
   */
  totals(): RunTotals;
  /**
   * Write the terminal run_done span carrying status plus the roll-up.
   * The run_done event itself never perturbs the counters.
   */
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

/**
 * Fold one event into the per-run roll-up, inside the existing emit paths
 * so every host that shares the emitter gets consistent totals. An
 * llm_call contributes its call plus token/cost sums; every tool_call
 * contributes a tool call, and run_query ones additionally count as SQL
 * attempts; each repair node_done follows a failed SQL attempt (guard or
 * gate denial, TIMEOUT simplification, repairable MCP error routed to
 * retry), so it counts as a SQL failure.
 */
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
    if (asPayloadRecord(event)["tool"] === "run_query") {
      totals.sqlAttempts += 1;
    }
    return;
  }
  if (event.type === "node_done" && event.node === "repair") {
    totals.sqlFailures += 1;
  }
}

export function createSpanEmitter(ctx: SpanContext): AgentSpanEmitter {
  const tracesDir = ctx.tracesDir ?? "traces";
  // Per-run instance state (mirroring the runs map discipline in
  // apps/api): one emitter per run, never module globals, so concurrent
  // runs cannot cross-talk.
  const totals: RunTotals = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    toolCalls: 0,
    sqlAttempts: 0,
    sqlFailures: 0,
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
