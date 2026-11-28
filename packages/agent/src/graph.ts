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
  createTextToSqlRuntime,
  guardTextToSqlBudget,
  type TextToSqlRuntimeDeps,
} from "./subgraphs/textToSql.js";
import { createRcaRuntime } from "./subgraphs/rootCauseAnalysis.js";
import { createAnswerSynthesizer } from "./answer/synthesize.js";
import { RCA_ROUTE, TEXT_TO_SQL_ROUTE, type Route } from "./constants.js";
import { routeQuestion } from "./router.js";
import { formatBudgetTripTemplate, type BudgetTripReason } from "./budgetTemplate.js";
import { finalizeTurnMemory } from "./multiTurn.js";

export interface RootGraphDeps {
  checkpointer?: BaseCheckpointSaver | boolean;
  retrieve?: RetrieveFn;
  /** Replaces a route's entry handler; hosts and tests inject fakes here. */
  routes?: Partial<Record<Route, UcEntryHandler>>;
  viz?: VizFn;
  synthesize?: SynthesizeFn;
  emitSpan?: SpanEmitter;
  textToSql?: TextToSqlRuntimeDeps;
}

const noopEmit: SpanEmitter = () => "";
const noopUpdate = async (): Promise<AgentUpdate> => ({});

export function buildRootGraph(deps: RootGraphDeps = {}) {
  const emit: SpanEmitter = deps.emitSpan ?? noopEmit;
  const retrieve: RetrieveFn = deps.retrieve ?? noopUpdate;
  const viz: VizFn = deps.viz ?? noopUpdate;
  const synthesize: SynthesizeFn = deps.synthesize ?? createAnswerSynthesizer();
  const textToSql = createTextToSqlRuntime(deps.textToSql);
  const entries: Record<Route, UcEntryHandler> = {
    [TEXT_TO_SQL_ROUTE]: deps.routes?.[TEXT_TO_SQL_ROUTE] ?? textToSql.entry,
    [RCA_ROUTE]: deps.routes?.[RCA_ROUTE] ?? createRcaRuntime().entry,
  };

  const runWithRuntime = (
    fn: (state: AgentState, rt: RootRuntime) => Promise<AgentUpdate>,
  ) => {
    return async (
      state: AgentState,
      config: RootRuntime["config"],
    ): Promise<AgentUpdate> => fn(state, { emit, config });
  };

  const graph = new StateGraph(AgentStateSchema)
    .addNode("budgetGuard", async (state: AgentState): Promise<AgentUpdate> => {
      if (state.route === TEXT_TO_SQL_ROUTE) {
        const update = guardTextToSqlBudget(state);
        if (update.budgetExceeded) {
          const tripReason =
            state.budget.llmCalls >= state.budget.maxLlmCalls
              ? "llm-calls"
              : state.budget.tokensUsed >= state.budget.maxTokens
                ? "tokens"
                : "deadline";
          emit({
            node: "budget_guard",
            type: "node_done",
            durationMs: 0,
            payload: { budgetExceeded: true, tripReason, caveat: "budget_exceeded" },
          });
        }
        return update;
      }
      const reason: BudgetTripReason | null =
        state.budget.llmCalls >= state.budget.maxLlmCalls
          ? "llm-calls"
          : state.budget.tokensUsed >= state.budget.maxTokens
            ? "tokens"
            : state.budget.deadlineMs > 0 &&
                Date.now() >= state.budget.deadlineMs
              ? "deadline"
              : null;
      if (reason) {
        const answerText = formatBudgetTripTemplate({
          reason,
          budget: state.budget,
          completed: [
            ...state.tablesUsed.map((table) => `Queried table ${table}`),
            ...(state.rowCount !== null ? [`Verified query returned ${state.rowCount} rows`] : []),
          ],
          verifiedSql:
            state.status === "ok" || state.status === "no_data" ? state.sql : null,
          rowCount: state.rowCount ?? undefined,
          remaining: ["Finish the remaining analysis and verify its results"],
        });
        emit({
          node: "budget_guard",
          type: "node_done",
          durationMs: 0,
          payload: { budgetExceeded: true, tripReason: reason, caveat: "budget_exceeded" },
        });
        return {
          status: "error",
          budgetExceeded: true,
          answerText,
        };
      }
      return { budgetExceeded: false };
    })
    // The route is decided once, before the budget guard and understand, because
    // both branch on it; a caller-supplied route in the input is always overwritten.
    .addNode(
      "router",
      runWithRuntime(async (state, rt) => {
        const route = routeQuestion(state.question, state.analysisState);
        rt.emit({ node: "router", type: "node_done", durationMs: 0, payload: { route } });
        if (state.turnHistory.length === 0) return { route };
        return {
          route,
          status: "no_data",
          errorCode: null,
          answerText: "",
          sql: null,
          tablesUsed: [],
          semanticChunks: [],
          semanticQuery: null,
          semanticRetrieveStatus: "unloaded",
          semanticErrorCode: null,
          resultPreview: [],
          resultTruncated: false,
          rowCount: null,
          columns: [],
          toolsCalled: [],
          vizSpec: null,
          pendingClarification: null,
          clarificationAttempts: 0,
          analysisTopicChanged: false,
          analysisPlan: null,
          rootCauseAnswer: null,
          budgetExceeded: false,
          caveats: [],
          governed: undefined,
        };
      }),
    )
    .addNode("understand", runWithRuntime((state, rt) => {
      if (state.route === TEXT_TO_SQL_ROUTE) return textToSql.understand(state, rt);
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
      "textToSqlEntry",
      runWithRuntime((state, rt) => entries[TEXT_TO_SQL_ROUTE](state, rt)),
    )
    .addNode("rcaEntry", runWithRuntime((state, rt) => entries[RCA_ROUTE](state, rt)))
    .addNode("statusCheck", noopUpdate)
    .addNode("vizSeam", runWithRuntime((state, rt) => viz(state, rt)))
    .addNode("answer", runWithRuntime(async (state, rt) => {
      const update = await synthesize(state, rt);
      return update.turnHistory ? update : finalizeTurnMemory(state, update);
    }))
    .addEdge(START, "router")
    .addEdge("router", "budgetGuard")
    .addConditionalEdges("budgetGuard", (state: AgentState) =>
      state.budgetExceeded || state.status === "cannot_answer" ? "answer" : "understand",
    )
    .addEdge("understand", "retrieve")
    .addConditionalEdges("retrieve", (state: AgentState) =>
      state.route === RCA_ROUTE ? "rcaEntry" : "textToSqlEntry",
    )
    .addEdge("textToSqlEntry", "statusCheck")
    .addEdge("rcaEntry", "statusCheck")
    .addConditionalEdges("statusCheck", (state: AgentState) =>
      state.status === "ok" || state.status === "no_data" ? "vizSeam" : "answer",
    )
    .addEdge("vizSeam", "answer")
    .addEdge("answer", END)
    .compile({ checkpointer: deps.checkpointer ?? new MemorySaver() });

  return graph;
}
