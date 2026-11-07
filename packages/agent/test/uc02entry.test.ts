// UC-02 entry integration: unknown-term 0-SQL short-circuit + citation header.
import { describe, expect, it } from "vitest";
import { createTextToSqlRuntime } from "../src/subgraphs/textToSql.js";
import { validateCitations } from "../src/validators/citationValidator.js";
import type { AgentState, RootRuntime } from "../src/state.js";

function fakeRuntime(): RootRuntime {
  return {
    emit: () => "span-1",
    config: {
      configurable: {
        runId: "r",
        userId: "u",
        roleScope: "sales_south",
        mcpUrl: "http://127.0.0.1:1/mcp",
        token: "t",
      },
    },
  } as unknown as RootRuntime;
}

function stateWith(overrides: Partial<AgentState>): AgentState {
  return {
    question: "q",
    ucId: "text-to-sql",
    intent: {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: ["orders"],
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
    budget: { llmCalls: 0, tokensUsed: 0, maxLlmCalls: 20, maxTokens: 60000, deadlineMs: 0 },
    telemetry: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    runId: "r",
    threadId: "t",
    vizSpec: null,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
    ...overrides,
  } as unknown as AgentState;
}

describe("UC-02 text-to-SQL entry", () => {
  it("short-circuits NPS to cannot_answer with 0 executor calls", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      intentModel: {
        withStructuredOutput: () => ({
          invoke: async () => ({
            metric: null,
            dimensions: [],
            filters: [],
            timeRange: null,
            requestedMetrics: ["NPS"],
            schemaEntities: [],
            queryMode: "standard_query" as const,
          }),
        }),
      },
      executor: {
        run: async () => {
          executorCalls += 1;
          return { status: "ok", sql: "SELECT 1", tablesUsed: [], columns: [], rows: [], maskedColumns: [], attempts: 1 } as never;
        },
      },
    });
    const state = stateWith({
      question: "Chỉ số NPS của chúng ta là bao nhiêu?",
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: ["NPS"],
        schemaEntities: [],
        queryMode: "standard_query",
      },
      semanticChunks: [
        { chunkId: "metric:net_revenue", text: "Doanh thu thuần", aliasMatched: false, denseScore: 0.1 },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/NPS/);
    expect(executorCalls).toBe(0);
  });

  it("answers definition_lookup with no executor calls and metric citations", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          throw new Error("executor must not run for definition_lookup");
        },
      },
    });
    const state = stateWith({
      question: "Khách hàng hoạt động được tính thế nào?",
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: ["khách hàng hoạt động"],
        schemaEntities: [],
        queryMode: "definition_lookup",
      },
      semanticChunks: [
        {
          chunkId: "metric:active_customers",
          text: "Khách hàng hoạt động counts distinct customers",
          aliasMatched: true,
          denseScore: 0.95,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("ok");
    expect(out.sql).toBeNull();
    expect(out.answerText).toMatch(/metric:active_customers/);
    expect(executorCalls).toBe(0);
  });

  it("prepends -- @citations: to executor SQL and passes the validator", async () => {
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => ({
          status: "ok",
          sql: "SELECT SUM(oi.price_vnd) AS net_revenue_vnd FROM public.order_items oi",
          tablesUsed: ["order_items"],
          columns: ["net_revenue_vnd"],
          rows: [{ net_revenue_vnd: 100 }],
          maskedColumns: [],
          attempts: 1,
        }),
      },
    });
    const state = stateWith({
      question: "doanh số ròng tháng 8?",
      intent: {
        metric: "net_revenue",
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: ["doanh số ròng"],
        schemaEntities: ["orders", "order_items"],
        queryMode: "standard_query",
      },
      semanticChunks: [
        {
          chunkId: "metric:net_revenue",
          text: "Metric net_revenue (Doanh thu thuần) doanh số ròng",
          aliasMatched: true,
          denseScore: 0.95,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("ok");
    expect(typeof out.sql).toBe("string");
    expect(out.sql as string).toMatch(/^-- @citations: /);
    const headerIds = (out.sql as string)
      .split("\n")[0]
      .replace("-- @citations:", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const checked = validateCitations({
      citations: headerIds,
      sql: out.sql as string,
      requestedMetrics: ["doanh số ròng"],
      retrievedChunkIds: ["metric:net_revenue"],
      catalogIds: ["metric:net_revenue"],
    });
    expect(checked.ok).toBe(true);
  });
});
