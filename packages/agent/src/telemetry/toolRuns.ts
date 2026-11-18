// LangSmith `tool` child runs for MCP calls (#97).
//
// MCP tools are called over the SDK client, not as LangChain tools, so
// LangSmith never saw them: only `traces/*.jsonl` had describe_table /
// run_query. This wraps one MCP call in LangChain tool callbacks so the
// run's PiiSafeLangChainTracer records it as a child of the current graph
// node. The JSONL sink stays authoritative; this is display only.
//
// Privacy: a tool run is opened ONLY when our anonymizing tracer is among
// the handlers (never a bare env auto-tracer). Inputs are the tool args the
// gateway already receives (no identity fields); outputs are a summary of
// counts and column names, never rows or chunk text. Both still pass
// through the tracer's piiSafeProcessor before upload. Errors are reported
// by contract code only.

import {
  CallbackManager,
  type Callbacks,
} from "@langchain/core/callbacks/manager";
import { PiiSafeLangChainTracer } from "./langsmith.js";

/** Identity fields that travel in headers; never shown as tool input. */
const IDENTITY_ARG_KEYS = new Set(["runId", "userId", "roleScope", "token"]);

function handlersOf(callbacks: Callbacks | undefined): unknown[] {
  if (callbacks === undefined) return [];
  if (Array.isArray(callbacks)) return callbacks;
  return callbacks.handlers;
}

/** True when our anonymizing tracer will receive the tool run. */
export function hasPiiSafeTracer(callbacks: Callbacks | undefined): boolean {
  return handlersOf(callbacks).some(
    (handler) => handler instanceof PiiSafeLangChainTracer,
  );
}

function toolInput(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!IDENTITY_ARG_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Counts and names only. Rows, chunk content, and sample values are never
 * copied; an unparsable payload reports just its length.
 */
export function summarizeMcpResult(
  text: string,
  isError: boolean,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: !isError, unparsed: true, length: text.length };
  }
  const record = asRecord(parsed);
  if (record === null) return { ok: !isError };
  if (isError) {
    return {
      ok: false,
      ...(typeof record["code"] === "string" ? { code: record["code"] } : {}),
    };
  }
  const summary: Record<string, unknown> = { ok: true };
  for (const key of ["rowCount", "truncated", "durationMs", "estimatedCost", "estimatedRows"]) {
    const value = record[key];
    if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
  }
  for (const key of ["columns", "maskedColumns"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      // run_query lists names; describe_table lists {name, type, ...} objects.
      summary[key] = value
        .map((item) =>
          typeof item === "string" ? item : asRecord(item)?.["name"],
        )
        .filter((name): name is string => typeof name === "string");
    }
  }
  if (typeof record["table"] === "string") summary["table"] = record["table"];
  for (const key of ["chunks", "tables", "rows"]) {
    const value = record[key];
    if (Array.isArray(value)) summary[`${key}Count`] = value.length;
  }
  return summary;
}

/**
 * Run `fn` (one MCP call) inside a LangSmith tool run named after the tool.
 * Without our tracer in `callbacks` it is a plain passthrough. Callback
 * failures never fail the MCP call.
 */
export async function withMcpToolRun<T extends { text: string; isError?: boolean }>(
  callbacks: Callbacks | undefined,
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!hasPiiSafeTracer(callbacks)) return fn();
  let runManager: Awaited<ReturnType<CallbackManager["handleToolStart"]>> | undefined;
  try {
    const manager = CallbackManager.configure(callbacks);
    runManager = await manager?.handleToolStart(
      { lc: 1, type: "not_implemented", id: ["mcp", tool] },
      JSON.stringify(toolInput(args)),
      undefined,
      undefined,
      ["mcp"],
      { mcpTool: tool },
      tool,
    );
  } catch {
    runManager = undefined;
  }
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    const code =
      asRecord(error) !== null && typeof asRecord(error)?.["code"] === "string"
        ? (asRecord(error)?.["code"] as string)
        : "INTERNAL_ERROR";
    await runManager
      ?.handleToolError(new Error(`MCP tool ${tool} failed (${code})`))
      .catch(() => undefined);
    throw error;
  }
  await runManager
    ?.handleToolEnd(summarizeMcpResult(result.text, result.isError === true))
    .catch(() => undefined);
  return result;
}
