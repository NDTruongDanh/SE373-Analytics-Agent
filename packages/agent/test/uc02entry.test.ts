// UC-02 entry integration: unknown-term 0-SQL short-circuit + citation header.
import { describe, expect, it, vi } from "vitest";
import { NO_MATCHING_TABLE_OPTION } from "../src/constants.js";
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
    catalogTables: [],
    catalogStatus: "unloaded",
    semanticQuery: null,
    semanticRetrieveStatus: "unloaded",
    semanticErrorCode: null,
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
    clarificationAttempts: 0,
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

  it("enforces full semantic catalog membership on the live text-to-SQL citation path", async () => {
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => ({
          status: "ok",
          sql: "SELECT COUNT(*) AS n FROM public.orders",
          tablesUsed: ["orders"],
          columns: ["n"],
          rows: [{ n: 10 }],
          maskedColumns: [],
          attempts: 1,
        }),
      },
    });
    const state = stateWith({
      question: "How many orders?",
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: ["orders"],
        queryMode: "standard_query",
      },
      semanticChunks: [
        {
          chunkId: "metric:fabricated_not_in_catalog",
          text: "bogus chunk",
          aliasMatched: false,
          denseScore: 0.1,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
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
      question:
        "Thống kê doanh thu bán hàng theo khách hàng, khu vực, sản phẩm, khuyến mãi và người bán",
      catalogStatus: "ready",
      catalogTables: catalogNames.map((name) => ({ name, schema: "public" })),
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        // Two catalog-exact + one Vietnamese entity mapped via semantic chunk + extra question-grounded chunks
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
          text: "Bảng khách hàng (customers)",
          score: 0.9,
        },
        {
          chunkId: "table:regions",
          docType: "table",
          table: "regions",
          tables: ["regions"],
          text: "Bảng khu vực (regions)",
          score: 0.88,
        },
        {
          chunkId: "table:products",
          docType: "table",
          table: "products",
          tables: ["products"],
          text: "Bảng sản phẩm (products)",
          score: 0.85,
        },
        {
          chunkId: "table:promotions",
          docType: "table",
          table: "promotions",
          tables: ["promotions"],
          text: "Bảng khuyến mãi (promotions)",
          score: 0.8,
        },
        {
          chunkId: "table:sellers",
          docType: "table",
          table: "sellers",
          tables: ["sellers"],
          text: "Bảng người bán (sellers)",
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

  it("requests clarification with available tables instead of cannot_answer when no table candidates resolve", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          throw new Error("executor must not run when tables are unidentified");
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
    expect(out.status).toBe("needs_clarification");
    expect(out.pendingClarification).toMatchObject({
      field: "table",
      options: ["orders", "customers", NO_MATCHING_TABLE_OPTION],
    });
    expect(out.answerText).toMatch(/salaries/);
    expect(out.answerText).toMatch(/orders, customers/);
    expect(out.answerText).toMatch(/ask a new question/i);
  });

  it("refuses to silently drop an unresolved partial entity and asks user to clarify or ask a new question", async () => {
    let executorCalls = 0;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          throw new Error("executor must not run with partial unresolved entities");
        },
      },
    });
    const state = stateWith({
      question: "Doanh thu đơn hàng theo kênh bán",
      catalogStatus: "ready",
      catalogTables: [
        { name: "orders", schema: "public" },
        { name: "channels", schema: "public" },
      ],
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: ["orders", "kênh bán"],
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [
        {
          chunkId: "table:orders",
          docType: "table",
          table: "orders",
          tables: ["orders"],
          text: "Bảng đơn hàng (orders)",
          score: 0.9,
          aliasMatched: true,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(executorCalls).toBe(0);
    expect(out.status).toBe("needs_clarification");
    expect(out.pendingClarification).toMatchObject({
      field: "table",
      options: ["channels", NO_MATCHING_TABLE_OPTION],
    });
    expect(out.answerText).toMatch(/orders/);
    expect(out.answerText).toMatch(/kênh bán/);
    expect(out.answerText).toMatch(/ask a new question/i);
  });

  it("runs targeted semantic follow-up for a missing partial entity and succeeds when resolved", async () => {
    const queries: string[] = [];
    let seenTables: string[] = [];
    const { entry } = createTextToSqlRuntime({
      semanticSearch: async (query) => {
        queries.push(query);
        if (query === "kênh bán") {
          return [
            {
              chunkId: "table:channels",
              docType: "table",
              table: "channels",
              tables: ["channels"],
              metricName: null,
              content: "Bảng kênh bán hàng (channels)",
              score: 0.93,
              aliasMatched: true,
            },
          ];
        }
        return [];
      },
      executor: {
        run: async (input) => {
          seenTables = [...input.candidateTables];
          return {
            status: "ok",
            sql: "SELECT 1 AS n",
            tablesUsed: seenTables,
            columns: ["n"],
            rows: [{ n: 1 }],
            maskedColumns: [],
            attempts: 1,
          };
        },
      },
    });
    const state = stateWith({
      question: "Số đơn hàng theo kênh bán",
      catalogStatus: "ready",
      catalogTables: [
        { name: "orders", schema: "public" },
        { name: "channels", schema: "public" },
      ],
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: ["orders", "kênh bán"],
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [
        {
          chunkId: "table:orders",
          docType: "table",
          table: "orders",
          tables: ["orders"],
          text: "Bảng đơn hàng (orders)",
          score: 0.9,
          aliasMatched: true,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(queries).toEqual(["kênh bán"]);
    expect(out.status).toBe("ok");
    expect(seenTables).toEqual(["orders", "channels"]);
  });

  it("allows metric-covered concepts in schemaEntities to proceed normally with metric tables", async () => {
    let seenTables: string[] = [];
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async (input) => {
          seenTables = [...input.candidateTables];
          return {
            status: "ok",
            sql: "SELECT SUM(oi.price_vnd) AS rev FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.order_id",
            tablesUsed: seenTables,
            columns: ["rev"],
            rows: [{ rev: 500 }],
            maskedColumns: [],
            attempts: 1,
          };
        },
      },
    });
    const state = stateWith({
      question: "Doanh thu thuần của đơn hàng tháng 8",
      catalogStatus: "ready",
      catalogTables: [
        { name: "orders", schema: "public" },
        { name: "order_items", schema: "public" },
      ],
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: ["doanh thu thuần"],
        schemaEntities: ["orders", "doanh thu thuần"],
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [
        {
          chunkId: "metric:net_revenue",
          docType: "metric",
          tables: ["orders", "order_items"],
          text: "Doanh thu thuần (net_revenue) = SUM(order_items.price_vnd)",
          score: 0.95,
          aliasMatched: true,
        },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).toBe("ok");
    expect(seenTables).toEqual(["orders", "order_items"]);
  });

  it("stops and asks user to narrow the question when directly-mapped required tables exceed 6", async () => {
    let executorCalls = 0;
    const required = [
      "orders",
      "order_items",
      "customers",
      "channels",
      "regions",
      "products",
      "promotions",
    ];
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async () => {
          executorCalls += 1;
          throw new Error("executor must not silently drop required tables");
        },
      },
    });
    const state = stateWith({
      question: "Báo cáo tổng hợp 7 bảng cùng lúc",
      catalogStatus: "ready",
      catalogTables: required.map((name) => ({ name, schema: "public" })),
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: required,
        queryMode: "standard_query",
      },
      semanticRetrieveStatus: "ok",
      semanticChunks: [],
    });
    const out = await entry(state, fakeRuntime());
    expect(executorCalls).toBe(0);
    expect(out.status).toBe("needs_clarification");
    expect(out.pendingClarification).toBeNull();
    expect(out.answerText).toMatch(/7 bảng/);
    expect(out.answerText).toMatch(/promotions/);
  });

  it("checks deadline before each semantic follow-up search and stops with budget status without extra MCP calls", async () => {
    let searchCalls = 0;
    const { entry } = createTextToSqlRuntime({
      semanticSearch: async () => {
        searchCalls += 1;
        return [];
      },
      executor: {
        run: async () => {
          throw new Error("executor must not run after budget deadline");
        },
      },
    });

    const expiredFirst = await entry(
      stateWith({
        question: "Số đơn theo kênh bán và khu vực",
        catalogStatus: "ready",
        catalogTables: [
          { name: "orders", schema: "public" },
          { name: "channels", schema: "public" },
          { name: "regions", schema: "public" },
        ],
        intent: {
          metric: null,
          dimensions: [],
          filters: [],
          timeRange: null,
          requestedMetrics: [],
          schemaEntities: ["orders", "kênh bán", "khu vực"],
          queryMode: "standard_query",
        },
        semanticRetrieveStatus: "ok",
        semanticChunks: [],
        budget: {
          llmCalls: 0,
          tokensUsed: 0,
          maxLlmCalls: 20,
          maxTokens: 60000,
          deadlineMs: Date.now() - 10,
        },
      }),
      fakeRuntime(),
    );
    expect(searchCalls).toBe(0);
    expect(expiredFirst.status).toBe("error");
    expect(expiredFirst.budgetExceeded).toBe(true);
    expect(expiredFirst.answerText).toMatch(/budget_exceeded.*deadline/i);

    let stepCalls = 0;
    let fakeNow = 1_700_000_000_000;
    const midDeadline = fakeNow + 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      const { entry: entry2 } = createTextToSqlRuntime({
        semanticSearch: async () => {
          stepCalls += 1;
          // Advance simulated clock past deadline during first follow-up call
          fakeNow = midDeadline + 10;
          return [];
        },
        executor: {
          run: async () => {
            throw new Error("executor must not run after budget deadline");
          },
        },
      });
      const expiredSecond = await entry2(
        stateWith({
          question: "Số đơn theo kênh bán và khu vực",
          catalogStatus: "ready",
          catalogTables: [
            { name: "orders", schema: "public" },
            { name: "channels", schema: "public" },
            { name: "regions", schema: "public" },
          ],
          intent: {
            metric: null,
            dimensions: [],
            filters: [],
            timeRange: null,
            requestedMetrics: [],
            schemaEntities: ["orders", "kênh bán", "khu vực"],
            queryMode: "standard_query",
          },
          semanticRetrieveStatus: "ok",
          semanticChunks: [],
          budget: {
            llmCalls: 0,
            tokensUsed: 0,
            maxLlmCalls: 20,
            maxTokens: 60000,
            deadlineMs: midDeadline,
          },
        }),
        fakeRuntime(),
      );
      expect(stepCalls).toBe(1);
      expect(expiredSecond.status).toBe("error");
      expect(expiredSecond.budgetExceeded).toBe(true);
      expect(expiredSecond.answerText).toMatch(/budget_exceeded.*deadline/i);
      expect(expiredSecond.toolsCalled).toContain("search_semantic_layer");
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("text-to-SQL candidate tables (#104)", () => {
  it("uses retrieved chunk tables when the intent names none", async () => {
    let seen: string[] | null = null;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async (input: { candidateTables: string[] }) => {
          seen = input.candidateTables;
          return { status: "ok", sql: "SELECT 1", tablesUsed: [], columns: [], rows: [], maskedColumns: [], attempts: 1 } as never;
        },
      } as never,
    });
    const state = stateWith({
      question: "Doanh thu thuần theo kênh bán trong tháng 09/2026?",
      intent: {
        metric: null,
        dimensions: [],
        filters: [],
        timeRange: null,
        requestedMetrics: [],
        schemaEntities: [],
        queryMode: "standard_query",
      } as never,
      catalogStatus: "ready",
      catalogTables: ["orders", "order_items", "channels"].map((name) => ({ name, schema: "public" })),
      semanticChunks: [
        { chunkId: "table:channels", docType: "table", score: 0.4, aliasMatched: true, text: "doanh thu theo kênh bán", tables: ["channels"] },
        { chunkId: "table:orders", docType: "table", score: 0.9, aliasMatched: true, text: "doanh thu theo kênh bán", tables: ["public.orders", "order_items"] },
      ],
    });
    const out = await entry(state, fakeRuntime());
    expect(out.status).not.toBe("cannot_answer");
    // Score order, schema prefix stripped, deduped.
    expect(seen).toEqual(["orders", "order_items", "channels"]);
  });

  it("retains an intent table without adding unrelated semantic tables", async () => {
    let seen: string[] | null = null;
    const { entry } = createTextToSqlRuntime({
      executor: {
        run: async (input: { candidateTables: string[] }) => {
          seen = input.candidateTables;
          return { status: "ok", sql: "SELECT 1", tablesUsed: [], columns: [], rows: [], maskedColumns: [], attempts: 1 } as never;
        },
      } as never,
    });
    const tables = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const state = stateWith({
      semanticChunks: [{ chunkId: "table:many", score: 1, tables }],
    });
    await entry(state, fakeRuntime());
    expect(seen?.[0]).toBe("orders");
    expect(seen).toEqual(["orders"]);
  });
});
