import {
  END,
  MemorySaver,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import {
  AgentStateSchema,
  type AgentState,
  type AgentUpdate,
  type RetrieveFn,
  type RootRuntime,
  type SpanEmitter,
  type SynthesizeFn,
  type UcEntryHandler,
  type VizFn,
} from "./state.js";
import {
  DEFAULT_ROUTE_ID,
  getUcEntry,
  listUcIds,
  type TracerDefaultContext,
} from "./subgraphs/registry.js";
import { writeTraceEvent } from "./traces/writer.js";

// FROZEN root builder (AGENT-01, 01-10). UC owners MUST NOT edit this file:
// register handlers through subgraphs/registry.ts (registerUC) and land
// executor/model/span/HITL/persistence behavior through RootGraphDeps.
// Sibling injection points: 01-11 ValidatedQueryExecutor drives the retrieve
// and UC-entry hooks; 01-12 model factory plus skills plus spans plus HITL
// satisfy RetrieveFn/SynthesizeFn/SpanEmitter; 01-13/01-14 inject the
// PostgresSaver checkpointer and host the resume endpoint. The default
// tracer route keeps the 01-01 demo chain working until 01-14 replaces it.

export interface RootGraphDeps {
  /** Defaults to MemorySaver; 01-13/01-14 inject PostgresSaver. Never falls back silently. */
  checkpointer?: BaseCheckpointSaver | boolean;
  /** Defaults to a no-op (returns {}); 01-11 injects the executor describe path. */
  retrieve?: RetrieveFn;
  /** Merged OVER the registry table at build time; never edits graph.ts. */
  ucHandlers?: Record<string, UcEntryHandler>;
  /** Defaults to a no-op; the VIZ seam owner injects the renderer. */
  viz?: VizFn;
  /** Defaults to keep-or-derive synthesis; 01-12 injects the zero-tools writer. */
  synthesize?: SynthesizeFn;
  /** Defaults to a no-op sink; runTracerGraph wires the redacted writer. */
  emitSpan?: SpanEmitter;
}

const noopEmit: SpanEmitter = () => "";
const noopUpdate = async (): Promise<AgentUpdate> => ({});

/** Default synthesis: keep a handler-written answer, else derive one. */
async function defaultSynthesize(state: AgentState): Promise<AgentUpdate> {
  if (state.answerText.length > 0) {
    return {};
  }
  const preview = state.resultPreview;
  if (preview.length === 0) {
    return { status: "no_data", answerText: "No orders found for the demo question." };
  }
  const total = preview.reduce((sum, row) => sum + Number(row["n"] ?? 0), 0);
  return {
    status: "ok",
    answerText:
      `${preview.length} status groups, ${total} orders: ` +
      preview.map((row) => `${String(row["status"])}=${String(row["n"])}`).join(", "),
  };
}

/**
 * Compile the frozen AGENT-01 root graph:
 * understand -> retrieve -> router -> (ucEntry | defaultEntry) ->
 * statusCheck -> (vizSeam | answer) -> END.
 * Router dispatches ONLY to registry entries (allowlist); unknown ucIds
 * fall through to the tracer default route. Status ok/no_data continues to
 * the VIZ seam; clarification-gate (needs_clarification), policy-restricted
 * (restricted), and error outcomes synthesize with partial findings.
 */
export function buildRootGraph(deps: RootGraphDeps = {}) {
  const emit: SpanEmitter = deps.emitSpan ?? noopEmit;
  const retrieve: RetrieveFn = deps.retrieve ?? noopUpdate;
  const viz: VizFn = deps.viz ?? noopUpdate;
  const synthesize: SynthesizeFn = deps.synthesize ?? defaultSynthesize;

  const overlay = new Map<string, UcEntryHandler>();
  for (const id of listUcIds()) {
    const handler = getUcEntry(id);
    if (handler) {
      overlay.set(id, handler);
    }
  }
  for (const [id, handler] of Object.entries(deps.ucHandlers ?? {})) {
    overlay.set(id, handler);
  }
  if (!overlay.has(DEFAULT_ROUTE_ID)) {
    throw new Error(
      `root graph requires a '${DEFAULT_ROUTE_ID}' default route (registry or deps.ucHandlers)`,
    );
  }

  const runWithRuntime = (
    fn: (state: AgentState, rt: RootRuntime) => Promise<AgentUpdate>,
  ) => {
    return async (
      state: AgentState,
      config: RootRuntime["config"],
    ): Promise<AgentUpdate> => fn(state, { emit, config });
  };

  const graph = new StateGraph(AgentStateSchema)
    .addNode("understand", async (state: AgentState): Promise<AgentUpdate> => ({
      intent: { metric: null, dimensions: [], filters: [], timeRange: null },
      runId: state.runId,
      threadId: state.threadId,
    }))
    .addNode("retrieve", runWithRuntime((state, rt) => retrieve(state, rt)))
    .addNode("router", noopUpdate)
    .addNode(
      "ucEntry",
      runWithRuntime((state, rt) => {
        const handler = overlay.get(state.ucId);
        if (!handler) {
          // Unreachable: the router edge allowlists before reaching here.
          throw new Error(`no UC entry registered for '${state.ucId}'`);
        }
        return handler(state, rt);
      }),
    )
    .addNode(
      "defaultEntry",
      runWithRuntime((state, rt) => {
        const handler = overlay.get(DEFAULT_ROUTE_ID);
        if (!handler) {
          // Unreachable: the build-time guard requires the default route.
          throw new Error(`no default UC entry registered`);
        }
        return handler(state, rt);
      }),
    )
    .addNode("statusCheck", noopUpdate)
    .addNode("vizSeam", runWithRuntime((state, rt) => viz(state, rt)))
    .addNode("answer", runWithRuntime((state, rt) => synthesize(state, rt)))
    .addEdge(START, "understand")
    .addEdge("understand", "retrieve")
    .addEdge("retrieve", "router")
    .addConditionalEdges("router", (state: AgentState) =>
      overlay.has(state.ucId) ? "ucEntry" : "defaultEntry",
    )
    .addEdge("ucEntry", "statusCheck")
    .addEdge("defaultEntry", "statusCheck")
    .addConditionalEdges("statusCheck", (state: AgentState) =>
      state.status === "ok" || state.status === "no_data" ? "vizSeam" : "answer",
    )
    .addEdge("vizSeam", "answer")
    .addEdge("answer", END)
    .compile({ checkpointer: deps.checkpointer ?? new MemorySaver() });

  return graph;
}

export type TracerGraphContext = TracerDefaultContext;
// runTracerGraph input: MCP transport plus trace identity. The 01-14 host
// populates the same fields into RunnableConfig.configurable per D-11.

export interface TracerRunResult {
  status: "ok" | "no_data";
  answerText: string;
  toolsCalled: string[];
  sql: string;
  tracePath: string;
}

/**
 * 01-01 demo path, preserved through the registered default route: builds
 * the frozen root with the tracer entry and invokes it on the demo question.
 * Per-call run identity headers still flow from this ctx on every MCP call
 * (the 01-12 per-call hook owns that path going forward).
 */
export async function runTracerGraph(
  question: string,
  ctx: TracerGraphContext,
): Promise<TracerRunResult> {
  const graph = buildRootGraph({ checkpointer: new MemorySaver() });
  const out = (await graph.invoke(
    {
      question,
      ucId: DEFAULT_ROUTE_ID,
      runId: ctx.runId,
      threadId: ctx.threadId,
    },
    {
      configurable: {
        thread_id: ctx.threadId,
        mcpUrl: ctx.mcpUrl,
        token: ctx.token,
        runId: ctx.runId,
        userId: ctx.userId,
        roleScope: ctx.roleScope,
        threadId: ctx.threadId,
        tracesDir: ctx.tracesDir,
      },
    },
  )) as AgentState;

  writeTraceEvent(
    {
      runId: ctx.runId,
      threadId: ctx.threadId,
      userId: ctx.userId,
      role: "sales_south",
      node: "answer",
      type: "run_done",
      durationMs: 0,
      attempt: 0,
    },
    ctx.tracesDir,
  );

  return {
    status: out.status === "ok" ? "ok" : "no_data",
    answerText: out.answerText,
    toolsCalled: out.toolsCalled,
    sql: out.sql ?? "",
    tracePath: `${ctx.tracesDir}/${ctx.runId}.jsonl`,
  };
}
