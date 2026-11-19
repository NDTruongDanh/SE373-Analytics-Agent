// LLM usage helper (Phase 3 G1): read real provider token counts off the
// raw AIMessage preserved by `withStructuredOutput(..., { includeRaw: true })`
// and shape-detect the bare-parsed result that fakes and scripted stubs
// return (FakeListChatModel ignores the includeRaw config, so the result
// IS the parsed value with zero usage). Missing or malformed usage never
// throws — the caller falls back to estimateTokens.
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

/** Minimal structured-output surface; satisfied by ChatModelLike and AnyChatModel. */
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
  /** Ms from call start to the first streamed chunk (reasoning or content). */
  firstTokenMs?: number;
  /** Total provider attempts made (1 + rate-limit retries). */
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

/**
 * Read provider token counts off a raw message. Accepts the AIMessage
 * itself or any object carrying `usage_metadata` ({ input_tokens,
 * output_tokens }); anything else yields zeros, never throws.
 */
export function usageFromMessage(raw: unknown): LlmUsage {
  const usage = asRecord(asRecord(raw)?.["usage_metadata"]) ?? {};
  return {
    inputTokens: asCount(usage["input_tokens"]),
    outputTokens: asCount(usage["output_tokens"]),
  };
}

/**
 * Read the model id off a raw message's response_metadata (`model`, then
 * `model_name`); absent or non-string yields undefined so pricing resolves
 * to unknown instead of throwing.
 */
export function modelFromMessage(raw: unknown): string | undefined {
  const meta = asRecord(asRecord(raw)?.["response_metadata"]);
  for (const key of ["model", "model_name"] as const) {
    const value = meta?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// Real includeRaw result: own `{ raw, parsed }` keys with an
// AIMessage-like raw (always carries `content`). Anything else — the fake
// and scripted-stub shape — is already-parsed output with zero usage.
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

/**
 * Structured call preserving provider usage. Real path returns the parsed
 * value plus real counts and the raw model id; fake/stub path returns the
 * parsed value with zero counts and undefined model. The model position is
 * anchored to z.ZodType so S infers from the schema argument alone.
 * Schema violations still throw (fail-closed, same as the direct call it
 * replaces). Rate-limit/overload errors (429/503) retry through the shared
 * retry helper honoring backoff+jitter, Retry-After, budget, and deadline.
 */
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

/** Minimal streaming JSON surface; satisfied by every chat model and FakeListChatModel. */
export interface PlainJsonModelLike {
  invoke(input: string, config?: { callbacks?: Callbacks }): Promise<unknown>;
  stream(
    input: string,
    config?: { callbacks?: Callbacks; signal?: AbortSignal; runName?: string },
  ): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

/** Read the text out of an AIMessage-like (string or content-block array). */
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

/**
 * Scan balanced `{...}` spans outside JSON string literals so prose around
 * a JSON object (even prose containing stray braces) does not defeat extraction.
 */
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

/**
 * Parse a JSON document out of model text: verbatim first, then any fenced
 * code block, then the outermost `{...}` span or balanced `{...}` spans.
 * Throws SyntaxError (never echoing raw output, which may carry sensitive
 * values) so callers keep their existing parse-failure mapping.
 */
function extractJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to fenced/span extraction below.
  }
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Try next fenced block before falling through to span extraction.
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Fall through to balanced-span scan below.
    }
  }
  for (const candidate of balancedObjectSpans(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning remaining balanced spans.
    }
  }
  throw new SyntaxError("Model output is not valid JSON");
}

/**
 * Fallback parser for SQL proposal models that ignore JSON-only instructions
 * and answer in markdown prose with a fenced SQL block. Every extracted query
 * still passes SqlProposalSchema, sqlGuard, LocalQuerySafetyGate, explain_query,
 * and run_query before touching any data; tablesUsed is populated downstream by
 * sqlGuard from the parsed AST.
 */
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
 * Plain-JSON call preserving provider usage: streams the model WITHOUT
 * `withStructuredOutput` (no `response_format` on the wire) and parses the
 * assembled text against the schema. Reasoning models emit long
 * chain-of-thought before the first answer token (measured 16.5k reasoning
 * chars / 42s to first content on the tracer SQL proposal), so progress is
 * counted per streamed chunk — reasoning or content — and only silence
 * trips the idle budget; an absolute total cap still bounds runaways.
 * Streaming callbacks also let LangChain record first_token_time from the
 * first reasoning chunk instead of the first content token.
 * Schema violations still throw (fail-closed). Usage and model id come off
 * the streamed chunks exactly like the structured variant; fakes degrade to
 * zero-usage instead of throwing.
 */
export interface JsonStreamOptions extends ModelRetryContextOptions {
  name?: string;
  callbacks?: Callbacks;
  /** Abort when no chunk (reasoning or content) arrives within this long. */
  idleMs?: number;
  /** Absolute cap for the whole stream; the model client's timeout still applies. */
  totalMs?: number;
  /** Optional fallback extractor when the model answers in prose without JSON. */
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
