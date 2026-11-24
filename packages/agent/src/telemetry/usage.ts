import { z } from "zod";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { estimateCostUsd } from "./pricing.js";
import type { BudgetState } from "../queryExecutor/budgets.js";
import {
  createAttemptAbort,
  resolveModelRetryConfig,
  retryModelCall,
  type ModelRetryOverrides,
  type RetrySpanEmit,
} from "./retry.js";

export interface StructuredModelLike<S extends z.ZodType> {
  withStructuredOutput(
    schema: S,
    opts?: { name?: string; includeRaw?: boolean },
  ): { invoke(input: string, config?: { callbacks?: Callbacks }): Promise<unknown> };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface InvokeUsageResult<T> extends LlmUsage {
  parsed: T;
  model: string | undefined;
  firstTokenMs?: number;
  attempts?: number;
}

export interface ModelRetryContextOptions {
  node?: string;
  modelName?: string;
  budget?: BudgetState;
  deadlineMs?: number;
  signal?: AbortSignal;
  emit?: RetrySpanEmit;
  outerAttempt?: number;
  retry?: ModelRetryOverrides;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface InvokeWithUsageOptions extends ModelRetryContextOptions {
  name?: string;
  callbacks?: Callbacks;
  totalMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function asCount(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
    ? Math.floor(value)
    : 0;
}

export function usageFromMessage(raw: unknown): LlmUsage {
  const usage = asRecord(asRecord(raw)?.["usage_metadata"]) ?? {};
  return {
    inputTokens: asCount(usage["input_tokens"]),
    outputTokens: asCount(usage["output_tokens"]),
  };
}

export function modelFromMessage(raw: unknown): string | undefined {
  const meta = asRecord(asRecord(raw)?.["response_metadata"]);
  for (const key of ["model", "model_name"] as const) {
    const value = meta?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// Distinguish real { raw, parsed } includeRaw envelopes (where raw carries content) from fake/stub parsed outputs.
function asRawParsed(
  out: unknown,
): { raw: unknown; parsed: unknown } | null {
  const record = asRecord(out);
  if (
    record === null ||
    record === undefined ||
    !Object.hasOwn(record, "raw") ||
    !Object.hasOwn(record, "parsed")
  ) {
    return null;
  }
  if (asRecord(record["raw"])?.["content"] === undefined) return null;
  return { raw: record["raw"], parsed: record["parsed"] };
}

function minPositiveBound(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function retryOptionsFrom(
  opts: ModelRetryContextOptions | undefined,
  defaultNode: string,
) {
  return {
    node: opts?.node ?? defaultNode,
    modelName: opts?.modelName,
    config: opts?.retry
      ? resolveModelRetryConfig(process.env, opts.retry)
      : undefined,
    budget: opts?.budget,
    deadlineMs: opts?.deadlineMs,
    signal: opts?.signal,
    emit: opts?.emit,
    outerAttempt: opts?.outerAttempt,
    now: opts?.now,
    random: opts?.random,
    sleep: opts?.sleep,
  };
}

/** Model parameter is typed to z.ZodType so S infers from schema alone; fails closed on invalid output. */
export async function invokeWithUsage<S extends z.ZodType>(
  model: StructuredModelLike<z.ZodType>,
  schema: S,
  input: string,
  opts?: InvokeWithUsageOptions,
): Promise<InvokeUsageResult<z.infer<S>>> {
  const structOpts = opts?.name !== undefined ? { name: opts.name } : {};
  const retryResult = await retryModelCall(async (ctx) => {
    const effectiveTotalMs = minPositiveBound(opts?.totalMs, ctx.remainingMs);
    const needAbort =
      effectiveTotalMs !== undefined || ctx.signal !== undefined;
    const attempt = needAbort
      ? createAttemptAbort({
          totalMs: effectiveTotalMs,
          signal: ctx.signal,
          totalMessage: `Model structured call exceeded ${effectiveTotalMs ?? 0}ms`,
        })
      : undefined;
    try {
      const invokeConfig =
        opts?.callbacks !== undefined || attempt !== undefined
          ? {
              ...(opts?.callbacks !== undefined
                ? { callbacks: opts.callbacks }
                : {}),
              ...(attempt !== undefined
                ? { signal: attempt.controller.signal }
                : {}),
            }
          : undefined;
      const runnable = model.withStructuredOutput(schema, {
        ...structOpts,
        includeRaw: true,
      });
      const callPromise = (
        runnable.invoke as (
          prompt: string,
          config?: { callbacks?: Callbacks; signal?: AbortSignal },
        ) => Promise<unknown>
      )(input, invokeConfig);
      callPromise.catch(() => {});
      const out = attempt
        ? await Promise.race([callPromise, attempt.abortFailure])
        : await callPromise;
      const rawShape = asRawParsed(out);
      if (rawShape !== null) {
        return {
          parsed: schema.parse(rawShape.parsed),
          ...usageFromMessage(rawShape.raw),
          model: modelFromMessage(rawShape.raw),
        };
      }
      return {
        parsed: schema.parse(out),
        inputTokens: 0,
        outputTokens: 0,
        model: undefined,
      };
    } finally {
      attempt?.cleanup();
    }
  }, retryOptionsFrom(opts, "understand"));

  return {
    ...retryResult.value,
    attempts: retryResult.attempts,
  };
}

export interface PlainJsonModelLike {
  invoke(input: string, config?: { callbacks?: Callbacks }): Promise<unknown>;
  stream(
    input: string,
    config?: { callbacks?: Callbacks; signal?: AbortSignal; runName?: string },
  ): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

function messageText(message: unknown): string | null {
  const content = asRecord(message)?.["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      const text = asRecord(block)?.["text"];
      if (typeof text === "string") parts.push(text);
    }
    if (parts.length > 0) return parts.join("");
  }
  return null;
}

function* balancedObjectSpans(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

/** Throws SyntaxError without echoing raw model text (which may contain sensitive values). */
function extractJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* try fenced JSON next */
  }
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try {
      return JSON.parse(match[1]);
    } catch {
      /* try next fenced block */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* try balanced object spans next */
    }
  }
  for (const candidate of balancedObjectSpans(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* continue scanning */
    }
  }
  throw new SyntaxError("Model output is not valid JSON");
}

/** Extracted SQL still passes SqlProposalSchema, sqlGuard, LocalQuerySafetyGate, explain, and run_query. */
export function extractFencedSqlProposal(
  text: string,
): { sql: string; tablesUsed: string[] } | undefined {
  for (const match of text.matchAll(
    /```(?:sql|postgresql|postgres)\s*([\s\S]*?)```/gi,
  )) {
    const sql = match[1].trim();
    if (sql.length > 0) {
      return { sql, tablesUsed: [] };
    }
  }
  for (const match of text.matchAll(/```\s*([\s\S]*?)```/g)) {
    const sql = match[1].trim();
    if (/^(?:SELECT|WITH)\b/i.test(sql)) {
      return { sql, tablesUsed: [] };
    }
  }
  return undefined;
}

/**
 * Streams without response_format; resets idle timer on any chunk (including reasoning)
 * so slow thinking does not false-timeout.
 */
export interface JsonStreamOptions extends ModelRetryContextOptions {
  name?: string;
  callbacks?: Callbacks;
  idleMs?: number;
  totalMs?: number;
  fallbackParse?: (text: string) => unknown;
}

const DEFAULT_IDLE_MS = 30000;
const DEFAULT_TOTAL_MS = 300000;

export async function invokeJsonWithUsage<S extends z.ZodType>(
  model: PlainJsonModelLike,
  schema: S,
  input: string,
  opts?: JsonStreamOptions,
): Promise<InvokeUsageResult<z.infer<S>>> {
  const requestedIdleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const requestedTotalMs = opts?.totalMs ?? DEFAULT_TOTAL_MS;

  const retryResult = await retryModelCall(async (ctx) => {
    const started = Date.now();
    const effectiveTotalMs =
      minPositiveBound(requestedTotalMs, ctx.remainingMs) ?? requestedTotalMs;
    const effectiveIdleMs = Math.min(requestedIdleMs, effectiveTotalMs);
    const attempt = createAttemptAbort({
      totalMs: effectiveTotalMs,
      idleMs: effectiveIdleMs,
      signal: ctx.signal,
      idleMessage: `Model stream stalled: no tokens for ${effectiveIdleMs}ms`,
      totalMessage: `Model stream exceeded ${effectiveTotalMs}ms`,
    });

    let activeIterator: AsyncIterator<unknown> | undefined;
    const consume = (async (): Promise<{
      text: string;
      usage: LlmUsage;
      modelId: string | undefined;
      firstTokenMs: number | undefined;
    }> => {
      if (typeof model.stream !== "function") {
        const message = await model.invoke(input, {
          callbacks: opts?.callbacks,
        });
        const text = messageText(message) ?? "";
        return {
          text,
          usage: usageFromMessage(message),
          modelId: modelFromMessage(message),
          firstTokenMs: Date.now() - started,
        };
      }
      let text = "";
      let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
      let modelId: string | undefined;
      let firstTokenMs: number | undefined;
      const stream = await model.stream(input, {
        callbacks: opts?.callbacks,
        signal: attempt.controller.signal,
        runName: opts?.name,
      });
      const iterator = stream[Symbol.asyncIterator]();
      activeIterator = iterator;
      attempt.armIdle();
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          activeIterator = undefined;
          break;
        }
        const chunk = next.value;
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
        text += messageText(chunk) ?? "";
        const counts = usageFromMessage(chunk);
        if (counts.inputTokens > 0 || counts.outputTokens > 0) usage = counts;
        modelId = modelFromMessage(chunk) ?? modelId;
        attempt.armIdle();
      }
      return { text, usage, modelId, firstTokenMs };
    })();
    consume.catch(() => {});

    try {
      const { text, usage, modelId, firstTokenMs } = await Promise.race([
        consume,
        attempt.abortFailure,
      ]);
      let rawParsed: unknown;
      if (text === "") {
        rawParsed = undefined;
      } else {
        try {
          rawParsed = extractJsonDocument(text);
        } catch (error) {
          if (error instanceof SyntaxError && opts?.fallbackParse) {
            const fallback = opts.fallbackParse(text);
            if (fallback === undefined) throw error;
            rawParsed = fallback;
          } else {
            throw error;
          }
        }
      }
      return {
        // Empty output fails closed through schema validation.
        parsed: schema.parse(rawParsed),
        ...usage,
        model: modelId,
        firstTokenMs,
      };
    } finally {
      attempt.cleanup();
      if (activeIterator?.return) {
        void activeIterator.return().catch(() => {});
      }
    }
  }, retryOptionsFrom(opts, "propose"));

  return {
    ...retryResult.value,
    attempts: retryResult.attempts,
  };
}

export { estimateCostUsd };
