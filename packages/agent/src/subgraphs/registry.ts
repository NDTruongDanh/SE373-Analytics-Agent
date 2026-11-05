import { createChatModel } from "../models/factory.js";
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

export { DEFAULT_ROUTE_ID } from "../constants.js";

// UC seam (01-10): the SOLE file the frozen root builder (graph.ts) reads
// for UC wiring. UC owners register handlers here — or in sibling files
// beside this one that call registerUC() — and NEVER edit graph.ts.
// The default route preserves the exact 01-01 tracer chain
// (understand -> describe -> run -> answer, 8 trace events incl. llm_call) so the 27/10
// course-checkpoint demo keeps passing while real UC subgraphs land.

// Default route id. Unknown ucIds fall through to this entry (see constants.ts).

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

/** Transport context the tracer default route reads from RunnableConfig. */
export interface TracerDefaultContext extends TracerRunConfig {
  threadId: string;
  tracesDir: string;
}

/**
 * Per-run emitter for the default route (Phase 3 G3). The frozen root
 * builder (graph.ts) cannot import telemetry directly (UC-01 seam-only
 * import boundary), so the factory lives here beside the entry that
 * consumes it. Identity comes from the host context: the emitter stamps
 * the real run principal on every event. Noted for UC-01 owner
 * (nguyenhun11): registry entry events now flow through rt.emit instead
 * of writing directly, so per-run totals accumulate; the on-disk event
 * set is unchanged.
 */
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
    threadId: pick("threadId"),
    tracesDir: pick("tracesDir"),
  };
  const missing = (Object.keys(ctx) as (keyof TracerDefaultContext)[]).filter(
    (key) => ctx[key].length === 0,
  );
  if (missing.length > 0) {
    // Fail closed: the 01-14 host populates every field; never run with
    // partial identity (T-01-10-04: identity comes from the host, not prompts).
    throw new Error(
      `tracer default route missing run context: ${missing.join(", ")}`,
    );
  }
  return ctx;
}

/**
 * The tracer-compatible default entry, registered under DEFAULT_ROUTE_ID.
 * Runs the unchanged 01-01 chain — propose SQL, list_tables, run_query
 * (capped), deterministic answer — writing 8 trace events (incl. llm_call), so the
 * 27/10 demo path survives the skeleton expansion. Transport identity comes
 * from RunnableConfig.configurable (populated by the 01-14 host per D-11),
 * never from prompt text. No edits outside this file may change it.
 */
export function createTracerDefaultEntry(): UcEntryHandler {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    const ctx = readTracerContext(rt);
    // All default-route events flow through the run emitter: identical
    // on-disk shape to the former direct writes, but the real principal
    // comes from the emitter context and every event feeds the G3 roll-up.
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
    };

    const started = Date.now();
    const model = createChatModel();
    const out = await model.proposeSqlWithUsage(state.question, {
      callbacks: rt.config.callbacks,
    });
    const proposal = out.parsed;
    const llmDurationMs = Date.now() - started;
    // G1: the demo route reports the same llm_call shape as the UC-01 path,
    // so run_done totals carry real provider tokens; fakes record zeros.
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
        rowCount: runPayload.rowCount,
        truncated: runPayload.truncated,
      },
      attempt: 0,
    });
    trace("run", "node_done", 0, { parentSpanId: runSpan, attempt: 0 });

    const answerStarted = Date.now();
    const preview = runPayload.rows.slice(0, RESULT_PREVIEW_MAX);
    // A live model picks its own alias (e.g. COUNT(*) AS order_count), so
    // read the canned "n" when present, else the first numeric column.
    const countKey =
      runPayload.columns.find((column) => column === "n") ??
      runPayload.columns.find(
        (column) =>
          column !== "status" &&
          preview.length > 0 &&
          preview.every((row) => Number.isFinite(Number(row[column]))),
      ) ??
      "n";
    const total = preview.reduce(
      (sum, row) => sum + Number(row[countKey] ?? 0),
      0,
    );
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
      sql: proposal.sql,
      tablesUsed: proposal.tablesUsed,
      columns: runPayload.columns,
      resultPreview: preview,
      toolsCalled: [...state.toolsCalled, "list_tables", "run_query"],
      status,
      answerText,
    };
  };
}

// The default route is always registered; runTracerGraph (graph.ts) and the
// root builder resolve it through this table, never by direct import.
registerUC(DEFAULT_ROUTE_ID, createTracerDefaultEntry());
