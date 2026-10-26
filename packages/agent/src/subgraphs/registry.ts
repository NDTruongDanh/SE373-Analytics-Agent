import { createChatModel } from "../models/factory.js";
import {
  callMcpTool,
  parseToolJson,
  type TracerRunConfig,
} from "../mcpClient.js";
import { writeTraceEvent } from "../traces/writer.js";
import {
  RESULT_PREVIEW_MAX,
  type AgentState,
  type AgentUpdate,
  type RootRuntime,
  type UcEntryHandler,
} from "../state.js";

// UC seam (01-10): the SOLE file the frozen root builder (graph.ts) reads
// for UC wiring. UC owners register handlers here — or in sibling files
// beside this one that call registerUC() — and NEVER edit graph.ts.
// The default route preserves the exact 01-01 tracer chain
// (understand -> describe -> run -> answer, 7 trace events) so the 27/10
// course-checkpoint demo keeps passing while real UC subgraphs land.

// Default route id. Unknown ucIds fall through to this entry.
export const DEFAULT_ROUTE_ID = "tracer";

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
 * (capped), deterministic answer — writing the same 7 trace events, so the
 * 27/10 demo path survives the skeleton expansion. Transport identity comes
 * from RunnableConfig.configurable (populated by the 01-14 host per D-11),
 * never from prompt text. No edits outside this file may change it.
 */
export function createTracerDefaultEntry(): UcEntryHandler {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    const ctx = readTracerContext(rt);
    const trace = (
      node: string,
      type: string,
      durationMs: number,
      extra: { payload?: unknown; parentSpanId?: string; attempt?: number } = {},
    ): string =>
      writeTraceEvent(
        {
          runId: ctx.runId,
          threadId: ctx.threadId,
          userId: ctx.userId,
          role: "sales_south",
          node,
          type,
          durationMs,
          ...extra,
        },
        ctx.tracesDir,
      );

    const toolConfig = {
      mcpUrl: ctx.mcpUrl,
      token: ctx.token,
      runId: ctx.runId,
      userId: ctx.userId,
      roleScope: ctx.roleScope,
    };

    const started = Date.now();
    const model = createChatModel();
    const proposal = await model.proposeSql(state.question);
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
    const total = preview.reduce(
      (sum, row) => sum + Number(row["n"] ?? 0),
      0,
    );
    const status = preview.length > 0 ? "ok" : "no_data";
    const answerText =
      status === "ok"
        ? `${preview.length} status groups, ${total} orders: ` +
          preview.map((row) => `${String(row["status"])}=${String(row["n"])}`).join(", ")
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
