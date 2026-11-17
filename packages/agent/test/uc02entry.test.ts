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

  it("fails closed to cannot_answer when metrics present but no chunks retrieved", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          throw new Error("executor must not run without grounding");
        },
      },
    });
    const state = stateWith({
      question: "doanh số ròng tháng 8?",
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: ["doanh số ròng"],
        schemaEntities: ["orders"],
        queryMode: "standard_query",
      },
      semanticChunks: [],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/doanh số ròng/);
    expect(executorCalls).toBe(0);
  });

  it("fails closed to cannot_answer on column-only retrieval for a metric query", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          return {
            status: "ok",
            sql: "SELECT SUM(oi.price_vnd) AS net_revenue_vnd FROM public.order_items oi",
            tablesUsed: ["order_items"],
            columns: ["net_revenue_vnd"],
            rows: [{ net_revenue_vnd: 100 }],
            maskedColumns: [],
            attempts: 1,
          };
        },
      },
    });
    const state = stateWith({
      question: "doanh số ròng tháng 8?",
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: ["doanh số ròng"],
        schemaEntities: ["orders", "order_items"],
        queryMode: "standard_query",
      },
      semanticChunks: [
        {
          chunkId: "column:orders.status",
          text: "orders status column",
          aliasMatched: true,
          denseScore: 0.9,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    // Executor runs (column-grounded) but K7 fails closed: no metric:* citation.
    expect(executorCalls).toBe(1);
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/Citation check failed/);
  });

  it("resolves candidate tables from semantic chunks when schemaEntities is empty", async () => {
    let seenCandidateTables: string[] = [];
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async (input) => {
          seenCandidateTables = [...input.candidateTables];
          return {
            status: "ok",
            sql: "SELECT status, COUNT(*) FROM public.orders GROUP BY status",
            tablesUsed: ["orders"],
            columns: ["status", "count"],
            rows: [{ status: "completed", count: 5 }],
            maskedColumns: [],
            attempts: 1,
          };
        },
      },
    });
    const state = stateWith({
      question: "Đếm số đơn hàng theo trạng thái",
      catalogStatus: "ready",
      catalogTables: [
        { name: "orders", schema: "public" },
        { name: "customers", schema: "public" },
      ],
      intent: {
        metric: null,
        dimensions: ["status"],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: [],
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [
        {
          chunkId: "table:orders",
          docType: "table",
          table: "orders",
          tables: ["orders"],
          text: "orders table storing customer orders",
          score: 0.9,
          aliasMatched: true,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("ok");
    expect(seenCandidateTables).toEqual(["orders"]);
  });

  it("prioritizes catalog > semantic-mapped > semantic-expanded and caps candidateTables at 6", async () => {
    let seenCandidateTables: string[] = [];
    const catalogNames = [
      "orders",
      "order_items",
      "customers",
      "channels",
      "regions",
      "products",
      "promotions",
      "sellers",
    ];
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async (input) => {
          seenCandidateTables = [...input.candidateTables];
          return {
            status: "ok",
            sql: "SELECT 1 AS n",
            tablesUsed: ["orders"],
            columns: ["n"],
            rows: [{ n: 1 }],
            maskedColumns: [],
            attempts: 1,
          };
        },
      },
    });
    const state = stateWith({
      question: "Thống kê doanh thu bán hàng theo khu vực và khuyến mãi",
      catalogStatus: "ready",
      catalogTables: catalogNames.map((name) => ({ name, schema: "public" })),
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        // Two catalog-exact + one Vietnamese entity mapped via semantic chunk + extra semantic chunks
        schemaEntities: ["orders", "order_items", "kênh bán"],
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [
        {
          chunkId: "table:channels",
          docType: "table",
          table: "channels",
          tables: ["channels"],
          text: "Bảng kênh bán hàng (channels)",
          score: 0.95,
          aliasMatched: true,
        },
        {
          chunkId: "table:customers",
          docType: "table",
          table: "customers",
          tables: ["customers"],
          text: "customers table",
          score: 0.9,
        },
        {
          chunkId: "table:regions",
          docType: "table",
          table: "regions",
          tables: ["regions"],
          text: "regions table",
          score: 0.88,
        },
        {
          chunkId: "table:products",
          docType: "table",
          table: "products",
          tables: ["products"],
          text: "products table",
          score: 0.85,
        },
        {
          chunkId: "table:promotions",
          docType: "table",
          table: "promotions",
          tables: ["promotions"],
          text: "promotions table",
          score: 0.8,
        },
        {
          chunkId: "table:sellers",
          docType: "table",
          table: "sellers",
          tables: ["sellers"],
          text: "sellers table",
          score: 0.7,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("ok");
    expect(seenCandidateTables.length).toBe(6);
    expect(seenCandidateTables.slice(0, 3)).toEqual([
      "orders",
      "order_items",
      "channels",
    ]);
  });

  it("fails closed to cannot_answer when proposed entities do not exist in catalog or semantic chunks", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          throw new Error("executor must not run for out-of-schema entities");
        },
      },
    });
    const state = stateWith({
      question: "Lương nhân viên phòng kho là bao nhiêu?",
      catalogStatus: "ready",
      catalogTables: [
        { name: "orders", schema: "public" },
        { name: "customers", schema: "public" },
      ],
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: ["salaries"],
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [
        {
          chunkId: "table:orders",
          docType: "table",
          table: "orders",
          tables: ["orders"],
          text: "Orders placed by customers",
          score: 0.25,
          aliasMatched: false,
          denseScore: 0.25,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(executorCalls).toBe(0);
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/salaries/);
  });
});
