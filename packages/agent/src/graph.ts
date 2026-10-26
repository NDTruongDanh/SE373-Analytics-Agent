import * as z from "zod";
import {
  END,
  MemorySaver,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { createChatModel } from "./models/factory.js";
import {
  callMcpTool,
  parseToolJson,
  type TracerRunConfig,
} from "./mcpClient.js";
import { writeTraceEvent } from "./traces/writer.js";

// TRACER thin graph (AGENT-01/02/09 slice): understand -> describe -> run ->
// answer, compiled with MemorySaver. The registry seam (01-10), the shared
// ValidatedQueryExecutor with repair and budgets (01-11), and PostgresSaver
// injection (01-13/01-14) replace this slice. No other file may import this
// graph yet.

const RESULT_PREVIEW_MAX = 50;

const TracerState = new StateSchema({
  question: z.string().default(""),
  sql: z.string().default(""),
  tablesUsed: z.array(z.string()).default([]),
  columns: z.array(z.string()).default([]),
  rows: z.array(z.record(z.string(), z.unknown())).default([]),
  toolsCalled: z.array(z.string()).default([]),
  status: z.string().default(""),
  answerText: z.string().default(""),
});

type TracerStateType = typeof TracerState.State;
type TracerUpdate = typeof TracerState.Update;

export interface TracerGraphContext extends TracerRunConfig {
  threadId: string;
  tracesDir: string;
}

export interface TracerRunResult {
  status: "ok" | "no_data";
  answerText: string;
  toolsCalled: string[];
  sql: string;
  tracePath: string;
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

export async function runTracerGraph(
  question: string,
  ctx: TracerGraphContext,
): Promise<TracerRunResult> {
  const model = createChatModel();
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

  async function understandNode(state: TracerStateType): Promise<TracerUpdate> {
    const started = Date.now();
    const proposal = await model.proposeSql(state.question);
    trace("understand", "node_done", Date.now() - started, {
      payload: { sql: proposal.sql, tablesUsed: proposal.tablesUsed },
      attempt: 0,
    });
    return { sql: proposal.sql, tablesUsed: proposal.tablesUsed };
  }

  async function describeNode(state: TracerStateType): Promise<TracerUpdate> {
    const started = Date.now();
    const raw = await callMcpTool(ctx, "list_tables", {});
    const payload = parseToolJson<ListTablesPayload>(raw, "list_tables");
    const spanId = trace("describe", "tool_call", Date.now() - started, {
      payload: {
        tool: "list_tables",
        tableCount: payload.tables.length,
        tables: payload.tables.map((t) => t.name),
      },
      attempt: 0,
    });
    trace("describe", "node_done", 0, { parentSpanId: spanId, attempt: 0 });
    return { toolsCalled: [...state.toolsCalled, "list_tables"] };
  }

  async function runNode(state: TracerStateType): Promise<TracerUpdate> {
    const started = Date.now();
    const raw = await callMcpTool(ctx, "run_query", { sql: state.sql, maxRows: 200 });
    const payload = parseToolJson<RunQueryPayload>(raw, "run_query");
    const spanId = trace("run", "tool_call", Date.now() - started, {
      payload: {
        tool: "run_query",
        rowCount: payload.rowCount,
        truncated: payload.truncated,
      },
      attempt: 0,
    });
    trace("run", "node_done", 0, { parentSpanId: spanId, attempt: 0 });
    return {
      columns: payload.columns,
      rows: payload.rows.slice(0, RESULT_PREVIEW_MAX),
      toolsCalled: [...state.toolsCalled, "run_query"],
    };
  }

  async function answerNode(state: TracerStateType): Promise<TracerUpdate> {
    const started = Date.now();
    // Deterministic synthesis: counts per status, never LLM-generated.
    const total = state.rows.reduce(
      (sum, row) => sum + Number(row["n"] ?? 0),
      0,
    );
    const status = state.rows.length > 0 ? "ok" : "no_data";
    const answerText =
      status === "ok"
        ? `${state.rows.length} status groups, ${total} orders: ` +
          state.rows.map((row) => `${String(row["status"])}=${String(row["n"])}`).join(", ")
        : "No orders found for the demo question.";
    trace("answer", "node_done", Date.now() - started, {
      payload: { status, total },
      attempt: 0,
    });
    return { status, answerText };
  }

  const graph = new StateGraph(TracerState)
    .addNode("understand", understandNode)
    .addNode("describe", describeNode)
    .addNode("run", runNode)
    .addNode("answer", answerNode)
    .addEdge(START, "understand")
    .addEdge("understand", "describe")
    .addEdge("describe", "run")
    .addEdge("run", "answer")
    .addEdge("answer", END)
    .compile({ checkpointer: new MemorySaver() });

  const out = (await graph.invoke(
    { question },
    { configurable: { thread_id: ctx.threadId } },
  )) as TracerStateType;

  trace("answer", "run_done", 0, { attempt: 0 });

  return {
    status: out.status === "ok" ? "ok" : "no_data",
    answerText: out.answerText,
    toolsCalled: out.toolsCalled,
    sql: out.sql,
    tracePath: `${ctx.tracesDir}/${ctx.runId}.jsonl`,
  };
}
