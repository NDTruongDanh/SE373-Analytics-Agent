// FROZEN root builder (AGENT-01). UC owners MUST NOT edit topology; extend via registry.ts (registerUC) and RootGraphDeps seams (retrieve/ucHandlers/viz/synthesize/emitSpan/textToSql). Budget guard here is generic run governance, not UC logic. Keep topology generic.
import {
  END,
  interrupt,
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
  /** Text-to-SQL model/executor seams; production uses defaults, tests inject fakes. */
  textToSql?: TextToSqlRuntimeDeps;
}

const noopEmit: SpanEmitter = () => "";
const noopUpdate = async (): Promise<AgentUpdate> => ({});

/** Apply exactly one selected clarification without re-running understand. */
function applyClarification(
  state: AgentState,
  value: unknown,
): AgentUpdate {
  const pending = state.pendingClarification;
  if (!pending) {
    return {
      status: "needs_clarification",
      answerText: "No clarification request is pending for this run.",
    };
  }
  if (typeof value !== "string" || !pending.options.includes(value)) {
    const nextAttempts = pending.attempts + 1;
    if (nextAttempts >= 2) {
      return {
        status: "needs_clarification",
        pendingClarification: null,
        answerText: "The clarification could not be resolved after two responses.",
      };
    }
    return {
      status: "needs_clarification",
      pendingClarification: { ...pending, attempts: nextAttempts },
      answerText: `Choose one of: ${pending.options.join(", ")}.`,
    };
  }

  const intent = { ...state.intent };
  if (pending.field === "metric") {
    intent.metric = value;
    intent.requestedMetrics = [value];
  } else if (pending.field === "timeRange") {
    intent.timeRange = value;
  } else if (pending.field === "scope") {
    intent.filters = [...intent.filters, { field: "scope", operator: "=", value }];
  } else {
    intent.filters = [...intent.filters, { field: "filterValue", operator: "=", value }];
  }
  return {
    intent,
    // The SQL model consumes question text, so retain the original question
    // and append the selected metadata without invoking understand again.
    question: `${state.question}\nClarification (${pending.field}): ${value}`,
    pendingClarification: null,
    clarificationAttempts: state.clarificationAttempts + 1,
    status: "no_data",
    answerText: "",
  };
}

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
    // Generic run governance (not UC logic): guardTextToSqlBudget only reads
    // budget counters/deadline and seeds the absolute deadline (no model or
    // I/O), so it is safe to reuse for the text-to-SQL path. Other UCs get an
    // inline budget-only trip check (no executor import: the frozen root stays
    // off the queryExecutor seam) returning cannot_answer on trip, {} otherwise.
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
    // BGT runs before UND and a tripped status short-circuits straight to
    // answer below, so the skill-contract load inside textToSql.understand
    // never runs after a trip (arch START->BGT->SKL->UND collapsed into
    // BGT->UND with SKL inside UND: no I/O after the trip).
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
    .addNode("router", noopUpdate)
    .addNode("clarification", async (state: AgentState): Promise<AgentUpdate> => {
      const pending = state.pendingClarification;
      if (!pending) {
        return {
          status: "needs_clarification",
          answerText: "No clarification request is pending for this run.",
        };
      }
      const value = interrupt({
        action: "clarify_then_query",
        pendingClarification: pending,
      });
      return applyClarification(state, value);
    })
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
    // Generic trip bypass: any budgetGuard cannot_answer skips understand
    // (and its skill/model I/O) straight to answer.
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
    .addConditionalEdges("statusCheck", (state: AgentState) => {
      if (state.status === "needs_clarification" && state.pendingClarification) {
        return "clarification";
      }
      return state.status === "ok" || state.status === "no_data" ? "vizSeam" : "answer";
    })
    .addConditionalEdges("clarification", (state: AgentState) => {
      if (state.pendingClarification) return "clarification";
      return state.status === "needs_clarification" ? "statusCheck" : "ucEntry";
    })
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
  // One emitter per run (G3): the default-route entry writes through it,
  // so every event feeds the roll-up read back at run_done below. No
  // topology change — buildRootGraph wiring only. Noted for UC-01 owner
  // (nguyenhun11): this runTracerGraph touch plus the role fix.
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
