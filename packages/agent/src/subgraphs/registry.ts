import {
  createChatModel,
  createSemanticCacheContext,
} from "../models/factory.js";
import { estimateCostUsd } from "../telemetry/usage.js";
import {
  callMcpTool,
  parseToolJson,
  type TracerRunConfig,
} from "../mcpClient.js";
import {
  createSpanEmitter,
  type AgentSpanEmitter,
} from "../telemetry/spans.js";
import {
  type AgentState,
  type AgentUpdate,
  type RootRuntime,
  type UcEntryHandler,
} from "../state.js";
import { DEFAULT_ROUTE_ID, RESULT_PREVIEW_MAX } from "../constants.js";
import { TRANSIENT_ROW_BUFFER_MAX } from "../queryExecutor/executor.js";
import { setTransientQueryBuffer } from "../queryExecutor/transientBuffer.js";
import { loadSemanticCatalogIds } from "../semantic/catalog.js";
import {
  deriveCitations,
  repairCitations,
  validateCitations,
} from "../validators/citationValidator.js";

export { DEFAULT_ROUTE_ID } from "../constants.js";

const entries = new Map<string, UcEntryHandler>();

export function registerUC(ucId: string, handler: UcEntryHandler): void {
  if (!ucId) {
    throw new Error("registerUC requires a non-empty UC id");
  }
  entries.set(ucId, handler);
}

export function getUcEntry(ucId: string): UcEntryHandler | undefined {
  return entries.get(ucId);
}

export function isKnownUc(ucId: string): boolean {
  return entries.has(ucId);
}

export function listUcIds(): string[] {
  return [...entries.keys()];
}

/**
 * Prefer explicit count columns because Number(true)/Number(null)/Number("") are finite;
 * numeric-only id columns remain a last resort.
 */
const COUNT_COLUMN_NAME = /^(n|count|total|.*_count|count_.*|num_.*)$/i;

function isCountCell(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return (
    typeof value === "string" &&
    value.length > 0 &&
    /^-?\d+(\.\d+)?$/.test(value)
  );
}

export function previewCountKey(
  columns: readonly string[],
  preview: readonly Record<string, unknown>[],
): string {
  if (columns.includes("n")) return "n";
  const countLike = (column: string): boolean =>
    COUNT_COLUMN_NAME.test(column) &&
    preview.length > 0 &&
    preview.every((row) => isCountCell(row[column]));
  const named = columns.find(countLike);
  if (named !== undefined) return named;
  return (
    columns.find(
      (column) =>
        preview.length > 0 &&
        preview.every((row) => isCountCell(row[column])),
    ) ?? "n"
  );
}

export function previewCountTotal(
  columns: readonly string[],
  preview: readonly Record<string, unknown>[],
): number {
  const key = previewCountKey(columns, preview);
  return preview.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
}

export interface TracerDefaultContext extends Omit<TracerRunConfig, "callbacks"> {
  threadId: string;
  tracesDir: string;
}

/** Lives here beside the default entry so graph.ts does not import telemetry directly. */
export function createTracerRunEmitter(
  ctx: TracerDefaultContext,
): AgentSpanEmitter {
  return createSpanEmitter({
    runId: ctx.runId,
    threadId: ctx.threadId,
    userId: ctx.userId,
    role: ctx.roleScope,
    tracesDir: ctx.tracesDir,
  });
}

interface ListTablesPayload {
  tables: { name: string; schema: string; columns: unknown[] }[];
}

interface RunQueryPayload {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

function readTracerContext(rt: RootRuntime): TracerDefaultContext {
  const cfg = (rt.config.configurable ?? {}) as Record<string, unknown>;
  const pick = (key: string): string =>
    typeof cfg[key] === "string" ? (cfg[key] as string) : "";
  const ctx: TracerDefaultContext = {
    mcpUrl: pick("mcpUrl"),
    token: pick("token"),
    runId: pick("runId"),
    userId: pick("userId"),
    roleScope: pick("roleScope"),
    ...(Object.hasOwn(cfg, "rowScope")
      ? { rowScope: cfg["rowScope"] as TracerRunConfig["rowScope"] }
      : {}),
    threadId: pick("threadId"),
    tracesDir: pick("tracesDir"),
  };
  const requiredKeys = [
    "mcpUrl",
    "token",
    "runId",
    "userId",
    "roleScope",
    "threadId",
    "tracesDir",
  ] as const;
  const missing = requiredKeys.filter((key) => ctx[key].length === 0);
  if (missing.length > 0) {
    // Fail closed: run identity must come completely from the host context, never partial or from prompts.
    throw new Error(
      `tracer default route missing run context: ${missing.join(", ")}`,
    );
  }
  return ctx;
}

export function createTracerDefaultEntry(): UcEntryHandler {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    const ctx = readTracerContext(rt);
    const trace = (
      node: string,
      type: string,
      durationMs: number,
      extra: { payload?: unknown; parentSpanId?: string; attempt?: number } = {},
    ): string =>
      rt.emit({
        node,
        type,
        durationMs,
        payload: extra.payload,
        parentSpanId: extra.parentSpanId,
        attempt: extra.attempt,
      });

    const toolConfig = {
      mcpUrl: ctx.mcpUrl,
      token: ctx.token,
      runId: ctx.runId,
      userId: ctx.userId,
      roleScope: ctx.roleScope,
      callbacks: rt.config.callbacks,
    };

    const started = Date.now();
    const model = createChatModel({
      semanticCacheContext: createSemanticCacheContext({
        analysisState: {
          question: state.question,
          intent: state.intent,
          tablesUsed: state.tablesUsed,
        },
        semanticChunks: state.semanticChunks,
        role: ctx.roleScope,
        rowScope: ctx.rowScope,
      }),
    });
    const out = await model.proposeSqlWithUsage(state.question, {
      callbacks: rt.config.callbacks,
      node: "understand",
      ...(state.budget?.deadlineMs && state.budget.deadlineMs > 0
        ? { deadlineMs: state.budget.deadlineMs }
        : {}),
      emit: (event) =>
        trace(event.node, event.type, event.durationMs, {
          payload: event.payload,
          attempt: event.attempt,
        }),
    });
    const proposal = out.parsed;
    const llmDurationMs = Date.now() - started;
    const { estimatedCostUsd, pricingKnown } = estimateCostUsd(
      out.model,
      out.inputTokens,
      out.outputTokens,
    );
    trace("understand", "llm_call", llmDurationMs, {
      payload: {
        model: out.model ?? "unknown",
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        estimatedCostUsd,
        pricingKnown,
      },
      attempt: 0,
    });
    trace("understand", "node_done", Date.now() - started, {
      payload: { sql: proposal.sql, tablesUsed: proposal.tablesUsed },
      attempt: 0,
    });

    const describeStarted = Date.now();
    const rawTables = await callMcpTool(toolConfig, "list_tables", {});
    const tablesPayload = parseToolJson<ListTablesPayload>(
      rawTables,
      "list_tables",
    );
    const describeSpan = trace("describe", "tool_call", Date.now() - describeStarted, {
      payload: {
        tool: "list_tables",
        tableCount: tablesPayload.tables.length,
        tables: tablesPayload.tables.map((t) => t.name),
      },
      attempt: 0,
    });
    trace("describe", "node_done", 0, { parentSpanId: describeSpan, attempt: 0 });

    const runStarted = Date.now();
    const rawRun = await callMcpTool(toolConfig, "run_query", {
      sql: proposal.sql,
      maxRows: 200,
    });
    const runPayload = parseToolJson<RunQueryPayload>(rawRun, "run_query");
    const runSpan = trace("run", "tool_call", Date.now() - runStarted, {
      payload: {
        tool: "run_query",
        ok: true,
        rowCount: runPayload.rowCount,
        truncated: runPayload.truncated,
      },
      attempt: 0,
    });
    trace("run", "node_done", 0, { parentSpanId: runSpan, attempt: 0 });

    const answerStarted = Date.now();
    const retrievedIds = (state.semanticChunks ?? []).map((chunk) => chunk.chunkId);
    let finalSql = proposal.sql;
    if (retrievedIds.length > 0) {
      const citations = deriveCitations(retrievedIds);
      if (citations.length > 0) {
        const input = {
          citations,
          sql: proposal.sql,
          requestedMetrics: state.intent?.requestedMetrics ?? [],
          retrievedChunkIds: retrievedIds,
          catalogIds: loadSemanticCatalogIds(),
        };
        const checked = validateCitations(input);
        const verified = checked.ok ? checked : repairCitations(input, 2);
        if (!verified.ok || verified.sql === null) {
          trace("answer", "node_done", Date.now() - answerStarted, {
            payload: { status: "cannot_answer", total: 0 },
            attempt: 0,
          });
          return {
            sql: proposal.sql,
            tablesUsed: proposal.tablesUsed,
            columns: runPayload.columns,
            resultPreview: [],
            toolsCalled: [...state.toolsCalled, "list_tables", "run_query"],
            status: "cannot_answer",
            answerText:
              "Citation check failed on default route; cannot answer without verified catalog citations.",
          };
        }
        finalSql = verified.sql;
      }
    }
    const preview = runPayload.rows.slice(0, RESULT_PREVIEW_MAX);
    const bufferRunId = state.runId || ctx.runId;
    if (bufferRunId) {
      setTransientQueryBuffer(bufferRunId, {
        columns: runPayload.columns,
        rows: runPayload.rows.slice(0, TRANSIENT_ROW_BUFFER_MAX),
        truncated: runPayload.truncated,
      });
    }
    const countKey = previewCountKey(runPayload.columns, preview);
    const total = previewCountTotal(runPayload.columns, preview);
    const status = preview.length > 0 ? "ok" : "no_data";
    const answerText =
      status === "ok"
        ? `${preview.length} status groups, ${total} orders: ` +
          preview.map((row) => `${String(row["status"])}=${String(row[countKey])}`).join(", ")
        : "No orders found for the demo question.";
    trace("answer", "node_done", Date.now() - answerStarted, {
      payload: { status, total },
      attempt: 0,
    });

    return {
      sql: finalSql,
      tablesUsed: proposal.tablesUsed,
      columns: runPayload.columns,
      resultPreview: preview,
      resultTruncated: runPayload.truncated,
      toolsCalled: [...state.toolsCalled, "list_tables", "run_query"],
      status,
      answerText,
    };
  };
}

registerUC(DEFAULT_ROUTE_ID, createTracerDefaultEntry());

import { createRcaRuntime, RCA_UC_ID } from "./rootCauseAnalysis.js";
registerUC(RCA_UC_ID, createRcaRuntime().entry);
