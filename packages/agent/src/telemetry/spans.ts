// Hierarchical span emitter (AGENT-07, 01-12): stamps spanId via randomUUID
// (D-13) plus optional parentSpanId and attempt, and delegates every write
// to the 01-09 redacted TraceWriter — redaction-before-write is inherited,
// never a local copy. Payloads carry counts and column names only, never
// cell values. The base callable satisfies both the 01-10 SpanEmitter and
// the 01-11 SpanSink (incoming spanId values are ignored: the writer mints).

import { appendTraceEvent } from "../traces/writer.js";
import type { SpanEmitter, SpanEvent } from "../state.js";
import type { ExecutorSpan, SpanSink } from "../queryExecutor/executor.js";

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
    opts?: { model?: string; parentSpanId?: string; attempt?: number },
  ): string;
  emitToolCall(
    node: string,
    tool: string,
    opts?: {
      rowCount?: number;
      columns?: string[];
      parentSpanId?: string;
      attempt?: number;
    },
  ): string;
}

export function createSpanEmitter(ctx: SpanContext): AgentSpanEmitter {
  const tracesDir = ctx.tracesDir ?? "traces";

  const base = (event: IncomingSpan): string =>
    appendTraceEvent(
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

  emitter.emitLlmCall = (
    node: string,
    opts: { model?: string; parentSpanId?: string; attempt?: number } = {},
  ): string =>
    base({
      node,
      type: "llm_call",
      durationMs: 0,
      payload: opts.model ? { model: opts.model } : {},
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });

  emitter.emitToolCall = (
    node: string,
    tool: string,
    opts: {
      rowCount?: number;
      columns?: string[];
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
      },
      parentSpanId: opts.parentSpanId,
      attempt: opts.attempt,
    });

  return emitter;
}
