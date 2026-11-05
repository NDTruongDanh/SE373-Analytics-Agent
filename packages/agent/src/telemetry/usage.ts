// LLM usage helper (Phase 3 G1): read real provider token counts off the
// raw AIMessage preserved by `withStructuredOutput(..., { includeRaw: true })`
// and shape-detect the bare-parsed result that fakes and scripted stubs
// return (FakeListChatModel ignores the includeRaw config, so the result
// IS the parsed value with zero usage). Missing or malformed usage never
// throws — the caller falls back to estimateTokens.
import * as z from "zod";
import { estimateCostUsd } from "./pricing.js";

/** Minimal structured-output surface; satisfied by ChatModelLike and AnyChatModel. */
export interface StructuredModelLike<S extends z.ZodType> {
  withStructuredOutput(
    schema: S,
    opts?: { name?: string; includeRaw?: boolean },
  ): { invoke(input: string): Promise<unknown> };
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface InvokeUsageResult<T> extends LlmUsage {
  parsed: T;
  model: string | undefined;
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
 * replaces).
 */
export async function invokeWithUsage<S extends z.ZodType>(
  model: StructuredModelLike<z.ZodType>,
  schema: S,
  input: string,
  opts?: { name?: string },
): Promise<InvokeUsageResult<z.infer<S>>> {
  const out = await model
    .withStructuredOutput(schema, { ...opts, includeRaw: true })
    .invoke(input);
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

export { estimateCostUsd };
