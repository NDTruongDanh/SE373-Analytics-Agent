// FROZEN root builder: extend via registry.ts (registerUC) and RootGraphDeps seams, never by editing topology here.
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
  createTracerRunEmitter,
  getUcEntry,
  listUcIds,
  type TracerDefaultContext,
} from "./subgraphs/registry.js";
import {
  createTextToSqlRuntime,
  guardTextToSqlBudget,
  type TextToSqlRuntimeDeps,
} from "./subgraphs/textToSql.js";
import { DEFAULT_ROUTE_ID, TEXT_TO_SQL_UC_ID } from "./constants.js";
import { routeQuestionToUc } from "./router.js";

export interface RootGraphDeps {
  checkpointer?: BaseCheckpointSaver | boolean;
  retrieve?: RetrieveFn;
  ucHandlers?: Record<string, UcEntryHandler>;
  viz?: VizFn;
  synthesize?: SynthesizeFn;
  emitSpan?: SpanEmitter;
  textToSql?: TextToSqlRuntimeDeps;
}

const noopEmit: SpanEmitter = () => "";
const noopUpdate = async (): Promise<AgentUpdate> => ({});

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

export function buildRootGraph(deps: RootGraphDeps = {}) {
  const emit: SpanEmitter = deps.emitSpan ?? noopEmit;
  const retrieve: RetrieveFn = deps.retrieve ?? noopUpdate;
  const viz: VizFn = deps.viz ?? noopUpdate;
  const synthesize: SynthesizeFn = deps.synthesize ?? defaultSynthesize;
  const textToSql = createTextToSqlRuntime(deps.textToSql);

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
  // Always prefer the per-graph runtime over the import-time registry entry:
  // production transport and trace dependencies are only available at run time.
  overlay.set(TEXT_TO_SQL_UC_ID, textToSql.entry);
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
    // Keep the frozen root off queryExecutor: text-to-SQL delegates budget init/check
    // (pure, no I/O); other UCs use an inline counter/deadline check.
    .addNode("budgetGuard", async (state: AgentState): Promise<AgentUpdate> => {
      if (state.ucId === TEXT_TO_SQL_UC_ID) return guardTextToSqlBudget(state);
      const reason =
        state.budget.llmCalls >= state.budget.maxLlmCalls
          ? "llm-calls"
          : state.budget.tokensUsed >= state.budget.maxTokens
            ? "tokens"
            : state.budget.deadlineMs > 0 &&
                Date.now() >= state.budget.deadlineMs
              ? "deadline"
              : null;
      if (reason) {
        return {
          status: "cannot_answer",
          answerText: `Run budget exceeded (${reason}); no model or query was called.`,
        };
      }
      return {};
    })
    // budgetGuard runs first and short-circuits trips straight to answer, so
    // skill-contract loading inside understand never runs after a budget trip.
    .addNode("understand", runWithRuntime((state, rt) => {
      if (state.ucId === TEXT_TO_SQL_UC_ID) return textToSql.understand(state, rt);
      return Promise.resolve({
        intent: {
          metric: null,
          dimensions: [],
          filters: [],
          timeRange: null,
          requestedMetrics: [],
          schemaEntities: [],
          queryMode: "standard_query",
        },
        runId: state.runId,
        threadId: state.threadId,
      });
    }))
    .addNode("retrieve", runWithRuntime((state, rt) => retrieve(state, rt)))
    .addNode(
      "router",
      runWithRuntime(async (state) => {
        if (state.ucId && overlay.has(state.ucId)) return {};
        const routed = routeQuestionToUc(state.question, state.ucId);
        return overlay.has(routed) ? { ucId: routed } : {};
      }),
    )
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
    .addEdge(START, "budgetGuard")
    .addConditionalEdges("budgetGuard", (state: AgentState) =>
      state.status === "cannot_answer" ? "answer" : "understand",
    )
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

export interface TracerRunResult {
  status: "ok" | "no_data";
  answerText: string;
  toolsCalled: string[];
  sql: string;
  tracePath: string;
}

export async function runTracerGraph(
  question: string,
  ctx: TracerGraphContext,
): Promise<TracerRunResult> {
  // Share one emitter per run so all node events feed the run_done roll-up.
  const emit = createTracerRunEmitter(ctx);
  const graph = buildRootGraph({ checkpointer: new MemorySaver(), emitSpan: emit });
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

  const status = out.status === "ok" ? "ok" : "no_data";
  emit.emitRunDone(status);

  return {
    status,
    answerText: out.answerText,
    toolsCalled: out.toolsCalled,
    sql: out.sql ?? "",
    tracePath: `${ctx.tracesDir}/${ctx.runId}.jsonl`,
  };
}
