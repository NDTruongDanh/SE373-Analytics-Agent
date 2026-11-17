import { describe, expect, it } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import { dbToolError, type SearchSemanticLayerChunk } from "@shared/contracts";
import {
  buildRootGraph,
  createAnswerSynthesizer,
  createRetrieveSemantic,
} from "../src/index.js";
import {
  type ChatModelLike,
  type McpToolCaller,
  ValidatedQueryExecutor,
} from "../src/queryExecutor/executor.js";
import type { CatalogTable } from "../src/state.js";

const BASE_CATALOG: CatalogTable[] = [
  { name: "orders", schema: "public", description: "Orders placed by customers" },
  { name: "order_items", schema: "public", description: "Order line items" },
  { name: "channels", schema: "public", description: "Sales channels" },
];

function semanticChunk(
  overrides: Partial<SearchSemanticLayerChunk> & { chunkId: string },
): SearchSemanticLayerChunk {
  return {
    docType: "table",
    table: "orders",
    tables: ["orders"],
    metricName: null,
    content: "orders content",
    score: 0.9,
    aliasMatched: true,
    ...overrides,
  } as SearchSemanticLayerChunk;
}

function runConfig(threadId = "t-flow", runId = "r-flow") {
  return {
    configurable: {
      thread_id: threadId,
      threadId,
      runId,
      userId: "u-flow",
      roleScope: "sales_south",
      mcpUrl: "http://127.0.0.1:1/mcp",
      token: "tok",
    },
  };
}

function makeIntentModel(
  response: {
    metric?: string | null;
    dimensions?: string[];
    filters?: { field: string; operator: string; value: unknown }[];
    timeRange?: string | null;
    requestedMetrics: string[];
    schemaEntities: string[];
    queryMode: "standard_query" | "definition_lookup";
  },
  capturedPrompts?: string[],
) {
  let calls = 0;
  const payload = {
    metric: response.metric ?? null,
    dimensions: response.dimensions ?? [],
    filters: response.filters ?? [],
    timeRange: response.timeRange ?? null,
    requestedMetrics: response.requestedMetrics,
    schemaEntities: response.schemaEntities,
    queryMode: response.queryMode,
  };
  return {
    get calls() {
      return calls;
    },
    model: {
      invoke: async (prompt: string) => {
        calls += 1;
        capturedPrompts?.push(prompt);
        return { content: JSON.stringify(payload) };
      },
      async *stream(prompt: string) {
        calls += 1;
        capturedPrompts?.push(prompt);
        yield { content: JSON.stringify(payload) };
      },
      withStructuredOutput: () => ({
        invoke: async (prompt: string) => {
          calls += 1;
          capturedPrompts?.push(prompt);
          return payload;
        },
      }),
    },
  };
}

function makeSqlModel(sql: string, tablesUsed: string[], capturedPrompts?: string[]): ChatModelLike {
  const payload = { sql, tablesUsed };
  return {
    invoke: async (prompt: string) => {
      capturedPrompts?.push(prompt);
      return { content: JSON.stringify(payload) };
    },
    async *stream(prompt: string) {
      capturedPrompts?.push(prompt);
      yield { content: JSON.stringify(payload) };
    },
    withStructuredOutput: () => ({
      invoke: async (prompt: string) => {
        capturedPrompts?.push(prompt);
        return payload;
      },
    }),
  };
}

describe("end-to-end UC-01 flow through buildRootGraph", () => {
  it("runs catalog discovery -> single semantic search -> SQL proposal -> synthesis", async () => {
    const intentPrompts: string[] = [];
    const sqlPrompts: string[] = [];
    let searchCalls = 0;
    const describedTables: string[] = [];

    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => {
      searchCalls += 1;
      return [
        semanticChunk({
          chunkId: "metric:net_revenue",
          docType: "metric",
          tables: ["orders", "order_items"],
          metricName: "net_revenue",
          content: "Metric net_revenue (Doanh thu thuần) sums order_items.price_vnd * quantity on completed orders",
          score: 0.96,
        }),
        semanticChunk({
          chunkId: "table:channels",
          docType: "table",
          table: "channels",
          tables: ["channels"],
          content: "Bảng kênh bán hàng (channels) chứa channel_name",
          score: 0.91,
        }),
        semanticChunk({
          chunkId: "join_rule:orders_channels",
          docType: "join_rule",
          tables: ["orders", "channels"],
          content: "JOIN public.channels c ON c.channel_id = o.channel_id",
          score: 0.85,
        }),
      ];
    };

    const mcp: McpToolCaller = {
      call: async (tool, args) => {
        if (tool === "describe_table") {
          const table = String(args["table"]);
          describedTables.push(table);
          if (table === "orders") {
            return {
              table: "orders",
              columns: [
                { name: "order_id", type: "bigint", nullable: false, sensitive: false },
                { name: "channel_id", type: "int", nullable: false, sensitive: false },
                { name: "status", type: "text", nullable: false, sensitive: false },
              ],
              primaryKey: ["order_id"],
              foreignKeys: [
                { column: "channel_id", referencesTable: "channels", referencesColumn: "channel_id" },
              ],
            };
          }
          if (table === "order_items") {
            return {
              table: "order_items",
              columns: [
                { name: "order_id", type: "bigint", nullable: false, sensitive: false },
                { name: "price_vnd", type: "numeric", nullable: false, sensitive: false },
              ],
              primaryKey: ["order_id"],
              foreignKeys: [
                { column: "order_id", referencesTable: "orders", referencesColumn: "order_id" },
              ],
            };
          }
          if (table === "channels") {
            return {
              table: "channels",
              columns: [
                { name: "channel_id", type: "int", nullable: false, sensitive: false },
                { name: "channel_name", type: "text", nullable: false, sensitive: false },
              ],
              primaryKey: ["channel_id"],
              foreignKeys: [],
            };
          }
        }
        if (tool === "explain_query") return { estimatedCost: 18, estimatedRows: 2 };
        if (tool === "run_query") {
          return {
            columns: ["channel_name", "net_revenue_vnd"],
            rows: [
              { channel_name: "Website", net_revenue_vnd: 5000000 },
              { channel_name: "Shopee", net_revenue_vnd: 3000000 },
            ],
            rowCount: 2,
            truncated: false,
            maskedColumns: [],
            durationMs: 5,
          };
        }
        throw new Error(`unexpected MCP tool: ${tool}`);
      },
    };

    const executor = new ValidatedQueryExecutor({
      model: makeSqlModel(
        "SELECT c.channel_name, SUM(oi.price_vnd) AS net_revenue_vnd FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.order_id JOIN public.channels c ON c.channel_id = o.channel_id WHERE o.status = 'completed' GROUP BY c.channel_name",
        ["orders", "order_items", "channels"],
        sqlPrompts,
      ),
      mcp,
    });

    const intent = makeIntentModel(
      {
        requestedMetrics: ["net_revenue"],
        schemaEntities: ["orders", "order_items", "kênh bán hàng"],
        queryMode: "standard_query",
      },
      intentPrompts,
    );

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchFn,
        intentModel: intent.model,
        executor,
      },
    });

    const out = await graph.invoke(
      { question: "Doanh thu thuần theo kênh bán hàng?", ucId: "text-to-sql" },
      runConfig("t-rev", "r-rev"),
    );

    expect(out.status).toBe("ok");
    expect(searchCalls).toBe(1);
    expect(intentPrompts[0]).toContain("<allowed-tables>");
    expect(intentPrompts[0]).toContain("- channels: Sales channels");
    expect(intentPrompts[0]).toContain("<semantic-references>");
    expect(describedTables).toEqual(["orders", "order_items", "channels"]);
    expect(sqlPrompts[0]).toContain("channel_id -> public.channels.channel_id");
    expect(sqlPrompts[0]).toContain("Metric net_revenue");
    expect(out.sql).toMatch(/^-- @citations: /);
    expect(out.answerText).toContain("Website");
    expect(out.answerText).toContain("5000000");
  });

  it("reaches executor when intent schemaEntities is empty but semantic chunks identify the table", async () => {
    const described: string[] = [];
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => [
      semanticChunk({
        chunkId: "table:orders",
        docType: "table",
        table: "orders",
        tables: ["orders"],
        content: "Customer orders header table",
        score: 0.9,
      }),
    ];
    const mcp: McpToolCaller = {
      call: async (tool, args) => {
        if (tool === "describe_table") {
          described.push(String(args["table"]));
          return {
            table: "orders",
            columns: [{ name: "status", type: "text", nullable: false, sensitive: false }],
            primaryKey: [],
            foreignKeys: [],
          };
        }
        if (tool === "explain_query") return { estimatedCost: 5, estimatedRows: 1 };
        if (tool === "run_query") {
          return {
            columns: ["total_orders"],
            rows: [{ total_orders: 42 }],
            rowCount: 1,
            truncated: false,
            maskedColumns: [],
            durationMs: 5,
          };
        }
        throw new Error(`unexpected tool: ${tool}`);
      },
    };

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchFn,
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: [],
          queryMode: "standard_query",
        }).model,
        executor: new ValidatedQueryExecutor({
          model: makeSqlModel("SELECT COUNT(*) AS total_orders FROM public.orders", ["orders"]),
          mcp,
        }),
      },
    });

    const out = await graph.invoke(
      { question: "Tổng cộng có bao nhiêu đơn?", ucId: "text-to-sql" },
      runConfig("t-empty-ent", "r-empty-ent"),
    );

    expect(out.status).toBe("ok");
    expect(described).toEqual(["orders"]);
    expect(out.answerText).toBe("total_orders: 42");
  });

  it("reuses pre-retrieved chunks in retrieve and blocks unknown NPS metric without duplicate search", async () => {
    let searchCalls = 0;
    let execCalls = 0;
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => {
      searchCalls += 1;
      return [
        semanticChunk({
          chunkId: "metric:net_revenue",
          docType: "metric",
          metricName: "net_revenue",
          content: "Net revenue in VND",
          score: 0.2,
          aliasMatched: false,
          denseScore: 0.2,
        }),
      ];
    };

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchFn,
        intentModel: makeIntentModel({
          requestedMetrics: ["NPS"],
          schemaEntities: ["orders"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            throw new Error("executor must not run for NPS");
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "Chỉ số NPS quý này?", ucId: "text-to-sql" },
      runConfig("t-nps", "r-nps"),
    );

    expect(searchCalls).toBe(1);
    expect(execCalls).toBe(0);
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/NPS/);
  });

  it("maps list_tables failures and empty catalogs to restricted/error without invoking intentModel or executor", async () => {
    const runWithListTables = async (
      listTables: () => Promise<CatalogTable[]>,
      threadId: string,
    ) => {
      let intentCalls = 0;
      let execCalls = 0;
      const intent = makeIntentModel({
        requestedMetrics: [],
        schemaEntities: ["orders"],
        queryMode: "standard_query",
      });
      const wrappedIntent: ChatModelLike = {
        ...intent.model,
        invoke: async (p) => {
          intentCalls += 1;
          return intent.model.invoke(p);
        },
        withStructuredOutput: () => ({
          invoke: async (p) => {
            intentCalls += 1;
            return intent.model.withStructuredOutput(undefined as never).invoke(p);
          },
        }),
      };
      const graph = buildRootGraph({
        checkpointer: new MemorySaver(),
        retrieve: createRetrieveSemantic({ search: async () => [] }),
        synthesize: createAnswerSynthesizer(),
        textToSql: {
          listTables,
          semanticSearch: async () => [],
          intentModel: wrappedIntent as never,
          executor: {
            run: async () => {
              execCalls += 1;
              throw new Error("should not execute");
            },
          },
        },
      });
      const out = await graph.invoke(
        { question: "Đếm số đơn hàng", ucId: "text-to-sql" },
        runConfig(threadId, threadId),
      );
      return { out, intentCalls, execCalls };
    };

    const scopeDenied = await runWithListTables(async () => {
      throw dbToolError("SCOPE_DENIED", "caller has no allowed tables");
    }, "t-cat-denied");
    expect(scopeDenied.out.status).toBe("restricted");
    expect(scopeDenied.intentCalls).toBe(0);
    expect(scopeDenied.execCalls).toBe(0);

    const internalErr = await runWithListTables(async () => {
      throw new Error("gateway unreachable");
    }, "t-cat-err");
    expect(internalErr.out.status).toBe("error");
    expect(internalErr.intentCalls).toBe(0);
    expect(internalErr.execCalls).toBe(0);

    const emptyCatalog = await runWithListTables(async () => [], "t-cat-empty");
    expect(emptyCatalog.out.status).toBe("error");
    expect(emptyCatalog.out.catalogStatus).toBe("empty");
    expect(emptyCatalog.intentCalls).toBe(0);
    expect(emptyCatalog.execCalls).toBe(0);
  });

  it("never mislabels search_semantic_layer errors as out-of-schema cannot_answer", async () => {
    const searchError = async () => {
      throw dbToolError("INTERNAL_ERROR", "semantic service unavailable");
    };
    const metricGraph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchError }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchError,
        intentModel: makeIntentModel({
          requestedMetrics: ["doanh thu thuần"],
          schemaEntities: ["orders"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            throw new Error("should not run");
          },
        },
      },
    });
    const metricOut = await metricGraph.invoke(
      { question: "Doanh thu thuần?", ucId: "text-to-sql" },
      runConfig("t-sem-metric-err", "r-sem-metric-err"),
    );
    expect(metricOut.status).toBe("error");

    const entityGraph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchError }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchError,
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: ["đơn hàng"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            throw new Error("should not run");
          },
        },
      },
    });
    const entityOut = await entityGraph.invoke(
      { question: "Liệt kê đơn hàng?", ucId: "text-to-sql" },
      runConfig("t-sem-ent-err", "r-sem-ent-err"),
    );
    expect(entityOut.status).toBe("error");
  });

  it("serves definition_lookup directly with citations and 0 executor calls", async () => {
    let execCalls = 0;
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => [
      semanticChunk({
        chunkId: "metric:net_revenue",
        docType: "metric",
        metricName: "net_revenue",
        content: "Doanh thu thuần = SUM(price_vnd * quantity) trên đơn completed",
        score: 0.94,
      }),
    ];
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchFn,
        intentModel: makeIntentModel({
          requestedMetrics: ["doanh thu thuần"],
          schemaEntities: [],
          queryMode: "definition_lookup",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            throw new Error("definition lookup should not query DB");
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "Doanh thu thuần được tính như thế nào?", ucId: "text-to-sql" },
      runConfig("t-def", "r-def"),
    );
    expect(out.status).toBe("ok");
    expect(execCalls).toBe(0);
    expect(out.answerText).toContain("metric:net_revenue");
  });

  it("handles HITL time-range clarification interrupt and resumes to completion", async () => {
    const checkpointer = new MemorySaver();
    let seenTimeRange: string | null | undefined;
    let execCount = 0;
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => [
      semanticChunk({
        chunkId: "table:orders",
        docType: "table",
        table: "orders",
        content: "Orders header",
      }),
    ];

    const graph = buildRootGraph({
      checkpointer,
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: searchFn,
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: ["orders"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async (input) => {
            execCount += 1;
            seenTimeRange = input.timeRange;
            if (!input.timeRange) {
              return {
                status: "needs_clarification",
                reason: "Unbounded full-table scan on orders",
                table: "orders",
                sql: "SELECT COUNT(*) FROM public.orders",
                attempts: 1,
              };
            }
            return {
              status: "ok",
              sql: "SELECT COUNT(*) AS cnt FROM public.orders",
              tablesUsed: ["orders"],
              columns: ["cnt"],
              rows: [{ cnt: 12 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
          timeRangeOptions: async () => [
            "2025-07-01/2025-10-01",
            "2025-04-01/2025-07-01",
          ],
        },
      },
    });

    const cfg = runConfig("t-hitl", "r-hitl");
    const first = (await graph.invoke(
      { question: "Đếm tất cả đơn hàng", ucId: "text-to-sql" },
      cfg,
    )) as Record<string, unknown>;
    expect(Array.isArray(first["__interrupt__"])).toBe(true);
    expect(execCount).toBe(1);

    const resumed = await graph.invoke(
      new Command({ resume: "2025-07-01/2025-10-01" }),
      cfg,
    );
    expect(resumed.status).toBe("ok");
    expect(seenTimeRange).toBe("2025-07-01/2025-10-01");
    expect(resumed.answerText).toBe("cnt: 12");
  });

  it("short-circuits in budgetGuard when maxLlmCalls is already exhausted", async () => {
    let listCalls = 0;
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => {
          listCalls += 1;
          return BASE_CATALOG;
        },
      },
    });

    const out = await graph.invoke(
      {
        question: "Đếm số đơn hàng",
        ucId: "text-to-sql",
        budget: {
          llmCalls: 20,
          tokensUsed: 0,
          maxLlmCalls: 20,
          maxTokens: 60_000,
          deadlineMs: 0,
        },
      },
      runConfig("t-budget", "r-budget"),
    );

    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/Run budget exceeded/);
    expect(listCalls).toBe(0);
  });
});
