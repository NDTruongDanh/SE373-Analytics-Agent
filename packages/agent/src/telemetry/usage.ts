// LLM usage helper (Phase 3 G1): read real provider token counts off the
// raw AIMessage preserved by `withStructuredOutput(..., { includeRaw: true })`
// and shape-detect the bare-parsed result that fakes and scripted stubs
// return (FakeListChatModel ignores the includeRaw config, so the result
// IS the parsed value with zero usage). Missing or malformed usage never
// throws — the caller falls back to estimateTokens.
import { z } from "zod";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { estimateCostUsd } from "./pricing.js";

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

/**
 * Structured call preserving provider usage. Real path returns the parsed
 * value plus real counts and the raw model id; fake/stub path returns the
 * parsed value with zero counts and undefined model. The model position is
 * anchored to z.ZodType so S infers from the schema argument alone.
 * Schema violations still throw (fail-closed, same as the direct call it
 * replaces). The optional LangSmith callbacks ride the same tracer the
 * graph.invoke site passed (suppression by handler name; duplicates fold
 * to one handler in _configureSync), so model runs stay correlatable.
 */
export async function invokeWithUsage<S extends z.ZodType>(
  model: StructuredModelLike<z.ZodType>,
  schema: S,
  input: string,
  opts?: { name?: string; callbacks?: Callbacks },
): Promise<InvokeUsageResult<z.infer<S>>> {
  const { callbacks, ...structOpts } = opts ?? {};
  const config = callbacks !== undefined ? { callbacks } : undefined;
  const out = await model
    .withStructuredOutput(schema, { ...structOpts, includeRaw: true })
    .invoke(input, config);
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
 * Parse a JSON document out of model text: verbatim first, then a fenced
 * code block, then the outermost {...} span. Throws SyntaxError (never
 * echoing raw output, which may carry sensitive values) so callers keep
 * their existing parse-failure mapping.
 */
function extractJsonDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to fenced/span extraction below.
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Fall through to span extraction below.
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Fall through to the SyntaxError below.
    }
  }
  throw new SyntaxError("Model output is not valid JSON");
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
export interface JsonStreamOptions {
  name?: string;
  callbacks?: Callbacks;
  /** Abort when no chunk (reasoning or content) arrives within this long. */
  idleMs?: number;
  /** Absolute cap for the whole stream; the model client's timeout still applies. */
  totalMs?: number;
}

const DEFAULT_IDLE_MS = 30000;
const DEFAULT_TOTAL_MS = 300000;

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export async function invokeJsonWithUsage<S extends z.ZodType>(
  model: PlainJsonModelLike,
  schema: S,
  input: string,
  opts?: JsonStreamOptions,
): Promise<InvokeUsageResult<z.infer<S>>> {
  const started = Date.now();
  const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
  const totalMs = opts?.totalMs ?? DEFAULT_TOTAL_MS;
  const controller = new AbortController();

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(
        timeoutError(`Model stream stalled: no tokens for ${idleMs}ms`),
      );
    }, idleMs);
  };
  const totalTimer = setTimeout(() => {
    controller.abort(timeoutError(`Model stream exceeded ${totalMs}ms`));
  }, totalMs);

  const abortFailure = new Promise<never>((_resolve, reject) => {
    if (controller.signal.aborted) {
      reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : timeoutError("Model stream aborted"),
      );
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : timeoutError("Model stream aborted"),
        );
      },
      { once: true },
    );
  });
  // Avoid an unhandled rejection when the consumer wins the race below.
  abortFailure.catch(() => {});

  const consume = (async (): Promise<{
    text: string;
    usage: LlmUsage;
    modelId: string | undefined;
    firstTokenMs: number | undefined;
  }> => {
    let text = "";
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    let modelId: string | undefined;
    let firstTokenMs: number | undefined;
    const stream = await model.stream(input, {
      callbacks: opts?.callbacks,
      signal: controller.signal,
      runName: opts?.name,
    });
    armIdle();
    for await (const chunk of stream) {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
      text += messageText(chunk) ?? "";
      const counts = usageFromMessage(chunk);
      if (counts.inputTokens > 0 || counts.outputTokens > 0) usage = counts;
      modelId = modelFromMessage(chunk) ?? modelId;
      armIdle();
    }
    return { text, usage, modelId, firstTokenMs };
  })();

  try {
    const { text, usage, modelId, firstTokenMs } = await Promise.race([
      consume,
      abortFailure,
    ]);
    return {
      // Empty output fails closed through schema validation.
      parsed: schema.parse(text === "" ? undefined : extractJsonDocument(text)),
      ...usage,
      model: modelId,
      firstTokenMs,
    };
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

export { estimateCostUsd };
