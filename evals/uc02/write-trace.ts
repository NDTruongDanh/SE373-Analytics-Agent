// UC-02 sample trace writer: drives retrieveSemantic (alias gate pass) +
// text-to-SQL entry (citation header) + CitationValidator over the uc02-01
// fixture and records spans through the real redacted emitter into
// traces/uc02/. Run once via:
//   pnpm exec tsx evals/uc02/write-trace.ts
// The committed jsonl is the UC-02 Definition-of-Done trace (retrieve ->
// gate pass -> SQL with -- @citations: -> verified answer). Fixture data is
// fake vi_VN retail data; the writer redacts before disk write regardless.
import path from "node:path";
import { createSpanEmitter } from "../../packages/agent/src/telemetry/spans.js";
import { createRetrieveSemantic } from "../../packages/agent/src/semantic/retrieveSemantic.js";
import { createTextToSqlRuntime } from "../../packages/agent/src/subgraphs/textToSql.js";
import { validateCitations } from "../../packages/agent/src/validators/citationValidator.js";
import type { AgentState, RootRuntime } from "../../packages/agent/src/state.js";
import type { SearchSemanticLayerChunk } from "@shared/contracts";

const RUN_ID = "d02a5f1e-7b2d-4c8e-9f0a-1b2c3d4e5f60";
const THREAD_ID = `chat:eval:${RUN_ID}`;
const TRACES_DIR = path.join("traces", "uc02");

const QUESTION = "doanh số ròng tháng 8/2026 là bao nhiêu?";

const RETRIEVED: SearchSemanticLayerChunk[] = [
  {
    chunkId: "metric:net_revenue",
    docType: "metric",
    table: "order_items",
    tables: ["orders", "order_items"],
    metricName: "net_revenue",
    content:
      "Metric net_revenue (Doanh thu thuần) is total merchandise revenue in VND: SUM(oi.price_vnd) over order_items joined to orders with o.status = 'delivered'.",
    score: 0.92,
    aliasMatched: true,
    denseScore: 0.88,
  },
  {
    chunkId: "join_rule:orders_order_items",
    docType: "join_rule",
    table: "orders",
    tables: ["orders", "order_items"],
    metricName: null,
    content: "Join rule for orders to order_items: COUNT(DISTINCT o.order_id) after the fan-out join.",
    score: 0.41,
    aliasMatched: false,
    denseScore: 0.38,
  },
];

async function main(): Promise<void> {
  const emit = createSpanEmitter({
    runId: RUN_ID,
    threadId: THREAD_ID,
    userId: "eval",
    role: "sales_south",
    tracesDir: TRACES_DIR,
  });
  const rt = {
    emit: (event: { node: string; type: string; durationMs: number; payload?: unknown }) =>
      emit(event),
    config: {
      configurable: {
        runId: RUN_ID,
        userId: "eval",
        roleScope: "sales_south",
        threadId: THREAD_ID,
        mcpUrl: "http://127.0.0.1:1/mcp",
        token: "eval-token",
      },
    },
  } as unknown as RootRuntime;

  const baseState = {
    question: QUESTION,
    ucId: "text-to-sql",
    intent: {
      metric: "net_revenue",
      dimensions: [],
      filters: [],
      timeRange: "2026-08",
      requestedMetrics: ["doanh số ròng"],
      schemaEntities: ["orders", "order_items"],
      queryMode: "standard_query",
    },
    semanticChunks: [],
    resultPreview: [],
    columns: [],
    sql: null,
    tablesUsed: [],
    toolsCalled: [],
    status: "no_data",
    answerText: "",
    budget: { llmCalls: 1, tokensUsed: 100, maxLlmCalls: 20, maxTokens: 60000, deadlineMs: 0 },
    telemetry: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    runId: RUN_ID,
    threadId: THREAD_ID,
    vizSpec: null,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
  } as unknown as AgentState;

  // 1. retrieveSemantic with a scripted search (alias-matched net_revenue).
  const retrieve = createRetrieveSemantic({ search: async () => RETRIEVED });
  const retrieved = await retrieve(baseState, rt);
  const gated = { ...baseState, ...retrieved };

  // 2. text-to-SQL entry with a scripted executor (no DB): the harness
  // prepends the dual citation header deterministically.
  const { entry } = createTextToSqlRuntime({
    executor: {
      run: async () => ({
        status: "ok",
        sql: "SELECT SUM(oi.price_vnd) AS net_revenue_vnd FROM public.order_items oi JOIN public.orders o USING (order_id) WHERE o.status = 'delivered'",
        tablesUsed: ["orders", "order_items"],
        columns: ["net_revenue_vnd"],
        rows: [{ net_revenue_vnd: 5200 }],
        maskedColumns: [],
        attempts: 1,
      }),
    },
  });
  const out = await entry(gated, rt);

  // 3. K7 check: 100% of header citations validate against the turn context.
  const sql = typeof out.sql === "string" ? out.sql : "";
  const headerIds = sql
    .split("\n")[0]
    ?.replace("-- @citations:", "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0) ?? [];
  const checked = validateCitations({
    citations: headerIds,
    sql,
    requestedMetrics: ["doanh số ròng"],
    retrievedChunkIds: RETRIEVED.map((chunk) => chunk.chunkId),
    catalogIds: RETRIEVED.map((chunk) => chunk.chunkId),
  });
  emit({
    node: "answer",
    type: "node_done",
    durationMs: 0,
    payload: {
      status: out.status,
      citationsValid: checked.ok,
      sqlBytes: sql.length,
    },
  });
  emit.emitRunDone(out.status === "ok" ? "ok" : "error");
  console.log(
    `trace ${TRACES_DIR}/${RUN_ID}.jsonl status=${out.status} citationsValid=${checked.ok} sqlHeader=${sql.split("\n")[0]}`,
  );
}

await main();
