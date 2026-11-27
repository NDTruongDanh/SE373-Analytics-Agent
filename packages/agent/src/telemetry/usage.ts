import { z } from "zod";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { estimateCostUsd } from "./pricing.js";
import {
  checkBudget,
  type BudgetState,
} from "../queryExecutor/budgets.js";
import {
  createAttemptAbort,
  classifyModelReaskFailure,
  resolveModelRetryConfig,
  retryModelCall,
  timeoutError,
  type ModelRetryOverrides,
  type RetryAttemptContext,
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
  preAccountedUsage?: LlmUsage;
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
  formatReaskLimit?: number;
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
    deadlineMs: minPositiveBound(opts?.deadlineMs, opts?.budget?.deadlineMs),
    signal: opts?.signal,
    emit: opts?.emit,
    outerAttempt: opts?.outerAttempt,
    now: opts?.now,
    random: opts?.random,
    sleep: opts?.sleep,
  };
}

function addUsage(target: LlmUsage, usage: LlmUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
}

async function retryWithFormatReask<T>(
  input: string,
  opts: ModelRetryContextOptions & { formatReaskLimit?: number } | undefined,
  defaultNode: string,
  invoke: (prompt: string, ctx: RetryAttemptContext) => Promise<T>,
  failureInfo: () => { usage: LlmUsage; model?: string },
): Promise<{ value: T; attempts: number }> {
  const limit = Number.isFinite(opts?.formatReaskLimit)
    ? Math.max(0, Math.min(1, Math.floor(opts?.formatReaskLimit ?? 1)))
    : 1;
  const now = opts?.now ?? Date.now;
  const deadlineMs = minPositiveBound(opts?.deadlineMs, opts?.budget?.deadlineMs);
  let prompt = input;
  let reasks = 0;
  let totalAttempts = 0;

  for (;;) {
    let callsThisCycle = 0;
    let lastCallStarted = now();
    try {
      const result = await retryModelCall((ctx) => {
        callsThisCycle += 1;
        lastCallStarted = now();
        return invoke(prompt, ctx);
      }, retryOptionsFrom(opts, defaultNode));
      totalAttempts += result.attempts;
      return { value: result.value, attempts: totalAttempts };
    } catch (error) {
      totalAttempts += callsThisCycle;
      const failure = classifyModelReaskFailure(error);
      if (!failure || reasks >= limit) throw error;

      if (opts?.budget) {
        const check = checkBudget(opts.budget, now());
        if (check.tripped) {
          throw new Error(`Run budget exceeded (${check.reason})`);
        }
      }
      if (deadlineMs !== undefined && now() >= deadlineMs) {
        throw timeoutError("Model call exceeded run deadline before format re-ask");
      }

      const failed = failureInfo();
      const cost = estimateCostUsd(failed.model ?? opts?.modelName, failed.usage.inputTokens, failed.usage.outputTokens);
      const node = opts?.node ?? defaultNode;
      const attempt = opts?.outerAttempt ?? totalAttempts;
      if (callsThisCycle > 0) {
        opts?.emit?.({
          node,
          type: "llm_call",
          durationMs: Math.max(0, now() - lastCallStarted),
          attempt,
          payload: {
            ok: false,
            model: failed.model ?? opts?.modelName ?? "unknown",
            code: failure.code,
            ...(failure.code === "provider_5xx" ? { status: failure.status } : {}),
            inputTokens: failed.usage.inputTokens,
            outputTokens: failed.usage.outputTokens,
            estimatedCostUsd: cost.estimatedCostUsd,
            pricingKnown: cost.pricingKnown,
          },
        });
      }
      opts?.emit?.({
        node,
        type: "retry",
        durationMs: 0,
        attempt,
        payload: {
          target: failure.formatFailure ? "llm_format" : "llm_provider",
          code: failure.code,
          ...(failure.code === "provider_5xx" ? { status: failure.status } : {}),
          reask: reasks + 1,
          nextAttempt: reasks + 2,
        },
      });

      reasks += 1;
      prompt = failure.formatFailure
        ? `${input}\n\nThe previous response did not match the required output format. Return exactly one valid JSON object matching the supplied schema. Do not include prose or code fences.`
        : input;
    }
  }
}

export function unaccountedUsage(usage: InvokeUsageResult<unknown>): LlmUsage {
  return {
    inputTokens: Math.max(0, usage.inputTokens - (usage.preAccountedUsage?.inputTokens ?? 0)),
    outputTokens: Math.max(0, usage.outputTokens - (usage.preAccountedUsage?.outputTokens ?? 0)),
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
  const preAccountedUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let lastFailureUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let lastFailureModel: string | undefined;
  const invoke = async (prompt: string, ctx: RetryAttemptContext) => {
    lastFailureUsage = { inputTokens: 0, outputTokens: 0 };
    lastFailureModel = undefined;
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
      )(prompt, invokeConfig);
      callPromise.catch(() => {});
      const out = attempt
        ? await Promise.race([callPromise, attempt.abortFailure])
        : await callPromise;
      const rawShape = asRawParsed(out);
      const usage =
        rawShape !== null
          ? usageFromMessage(rawShape.raw)
          : { inputTokens: 0, outputTokens: 0 };
      const modelId = rawShape !== null ? modelFromMessage(rawShape.raw) : undefined;
      const rawParsed = rawShape !== null ? rawShape.parsed : out;
      let parsed: z.infer<S>;
      try {
        parsed = schema.parse(rawParsed);
      } catch (error) {
        if (classifyModelReaskFailure(error)?.formatFailure) {
          lastFailureUsage = usage;
          lastFailureModel = modelId;
          addUsage(preAccountedUsage, usage);
          if (opts?.budget) {
            opts.budget.tokensUsed += usage.inputTokens + usage.outputTokens;
          }
        }
        throw error;
      }
      return {
        parsed,
        ...usage,
        model: modelId,
      };
    } finally {
      attempt?.cleanup();
    }
  };
  const retryResult = await retryWithFormatReask(
    input,
    opts,
    "understand",
    invoke,
    () => ({ usage: lastFailureUsage, model: lastFailureModel }),
  );

  return {
    ...retryResult.value,
    inputTokens: retryResult.value.inputTokens + preAccountedUsage.inputTokens,
    outputTokens: retryResult.value.outputTokens + preAccountedUsage.outputTokens,
    preAccountedUsage,
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
  formatReaskLimit?: number;
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
  const preAccountedUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let lastFailureUsage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let lastFailureModel: string | undefined;
  const invoke = async (prompt: string, ctx: RetryAttemptContext) => {
    lastFailureUsage = { inputTokens: 0, outputTokens: 0 };
    lastFailureModel = undefined;
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
        const message = await model.invoke(prompt, {
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
      const stream = await model.stream(prompt, {
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
      try {
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
          parsed: schema.parse(rawParsed),
          ...usage,
          model: modelId,
          firstTokenMs,
        };
      } catch (error) {
        if (classifyModelReaskFailure(error)?.formatFailure) {
          lastFailureUsage = usage;
          lastFailureModel = modelId;
          addUsage(preAccountedUsage, usage);
          if (opts?.budget) {
            opts.budget.tokensUsed += usage.inputTokens + usage.outputTokens;
          }
        }
        throw error;
      }
    } finally {
      attempt.cleanup();
      if (activeIterator?.return) {
        void activeIterator.return().catch(() => {});
      }
    }
  };

  const retryResult = await retryWithFormatReask(
    input,
    opts,
    "propose",
    invoke,
    () => ({ usage: lastFailureUsage, model: lastFailureModel }),
  );

  return {
    ...retryResult.value,
    inputTokens: retryResult.value.inputTokens + preAccountedUsage.inputTokens,
    outputTokens: retryResult.value.outputTokens + preAccountedUsage.outputTokens,
    preAccountedUsage,
    attempts: retryResult.attempts,
  };
}

export { estimateCostUsd };
