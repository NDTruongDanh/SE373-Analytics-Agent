import { describe, expect, it, vi } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import { dbToolError, type SearchSemanticLayerChunk } from "@shared/contracts";
import {
  buildRootGraph,
  createAnswerSynthesizer,
  createRetrieveSemantic,
} from "../src/index.js";
import { NO_MATCHING_TABLE_OPTION } from "../src/constants.js";
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

describe("out-of-domain entity gate", () => {
  it.each([
    ["NPS", ["NPS"]],
    ["NPS của đơn hàng", ["orders", "NPS"]],
  ])("returns cannot_answer before SQL for %s", async (question, schemaEntities) => {
    let executorCalls = 0;
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async () => [],
        intentModel: makeIntentModel({ requestedMetrics: [], schemaEntities, queryMode: "standard_query" }).model,
        executor: { run: async () => {
          executorCalls += 1;
          throw new Error("executor must not run for unsupported entities");
        } },
      },
    });
    const result = await graph.invoke({ question, route: "text-to-sql" }, runConfig(`t-oood-${schemaEntities.length}`, `r-oood-${schemaEntities.length}`));
    expect(result.status).toBe("cannot_answer");
    expect(result.sql).toBeNull();
    expect(executorCalls).toBe(0);
  });
});

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
  it("returns an error for invalid JSON from the intent model", async () => {
    const run = vi.fn();
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async () => [],
        intentJsonModel: {
          async *stream() {
            yield { content: "{invalid json" };
          },
        },
        executor: { run },
      },
    });
    const out = await graph.invoke(
      { question: "Có bao nhiêu đơn hàng?", route: "text-to-sql" },
      runConfig("t-invalid-intent", "r-invalid-intent"),
    );
    expect(out.status).toBe("error");
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts a Markdown-fenced intent response and reaches the executor", async () => {
    const run = vi.fn(async () => ({
      status: "ok" as const,
      sql: "SELECT COUNT(*) AS n FROM public.orders",
      tablesUsed: ["orders"],
      columns: ["n"],
      rows: [{ n: 2 }],
      maskedColumns: [],
      attempts: 1,
    }));
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async () => [],
        intentJsonModel: {
          async *stream() {
            yield { content: '```json\n{"schemaEntities":["orders"],"requestedMetrics":[],"queryMode":"standard_query"}\n```' };
          },
        },
        executor: { run },
      },
    });
    const out = await graph.invoke(
      { question: "Có bao nhiêu đơn hàng?", route: "text-to-sql" },
      runConfig("t-fenced-intent", "r-fenced-intent"),
    );
    expect(out.status).toBe("ok");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ candidateTables: ["orders"] }));
  });

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
      { question: "Doanh thu thuần theo kênh bán hàng?", route: "text-to-sql" },
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
    expect(out.answerText).toContain("5.000.000");
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
      { question: "Tổng cộng có bao nhiêu đơn?", route: "text-to-sql" },
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
      { question: "Chỉ số NPS quý này?", route: "text-to-sql" },
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
        { question: "Đếm số đơn hàng", route: "text-to-sql" },
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
      { question: "Doanh thu thuần?", route: "text-to-sql" },
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
      { question: "Liệt kê đơn hàng?", route: "text-to-sql" },
      runConfig("t-sem-ent-err", "r-sem-ent-err"),
    );
    expect(entityOut.status).toBe("error");
  });

  it("rounds definition scores so long floats never look like a phone number", async () => {
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => [
      semanticChunk({
        chunkId: "metric:net_revenue",
        docType: "metric",
        metricName: "net_revenue",
        content: "Doanh thu thuần = SUM(price_vnd) trên đơn delivered",
        score: 0.03278688524590164,
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
        executor: { run: vi.fn() },
      },
    });

    const out = await graph.invoke(
      { question: "Doanh thu thuần được tính như thế nào?", route: "text-to-sql" },
      runConfig("t-def-score", "r-def-score"),
    );
    expect(out.status).toBe("ok");
    expect(out.answerText).toContain("(score: 0.03)");
    // The API's completed-answer tripwire (apps/api/src/sse.ts PHONE_LIKE).
    expect(out.answerText).not.toMatch(/0\d{9}/);
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
      { question: "Doanh thu thuần được tính như thế nào?", route: "text-to-sql" },
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
      { question: "Đếm tất cả đơn hàng", route: "text-to-sql" },
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
        route: "text-to-sql",
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

    expect(out.status).toBe("error");
    expect(out.budgetExceeded).toBe(true);
    expect(out.answerText).toMatch(/budget_exceeded/);
    expect(listCalls).toBe(0);
  });

  it("interrupts with pendingClarification when an entity remains unmapped, resumes with user table choice, and re-resolves", async () => {
    const searchQueries: string[] = [];
    const seenTables: string[] = [];
    let execCalls = 0;
    const intent = makeIntentModel({
      requestedMetrics: [],
      schemaEntities: ["orders", "phòng CSKH"],
      queryMode: "standard_query",
    });

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async (q) => {
          searchQueries.push(q);
          return q === "phòng CSKH"
            ? []
            : [
                semanticChunk({
                  chunkId: "table:orders",
                  docType: "table",
                  table: "orders",
                  tables: ["orders"],
                  content: "Customer orders header",
                }),
              ];
        },
        intentModel: intent.model,
        executor: {
          run: async (input) => {
            execCalls += 1;
            seenTables.push(...input.candidateTables);
            return {
              status: "ok",
              sql: "SELECT COUNT(*) AS cnt FROM public.orders o JOIN public.channels c ON c.channel_id = o.channel_id",
              tablesUsed: input.candidateTables,
              columns: ["cnt"],
              rows: [{ cnt: 9 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });

    const cfg = runConfig("t-partial-hitl", "r-partial-hitl");
    const first = (await graph.invoke(
      { question: "Đếm số đơn hàng của phòng CSKH", route: "text-to-sql" },
      cfg,
    )) as Record<string, unknown>;

    expect(execCalls).toBe(0);
    expect(intent.calls).toBe(1);
    expect(searchQueries).toEqual(["Đếm số đơn hàng của phòng CSKH", "phòng CSKH"]);
    const interrupts = first["__interrupt__"] as { value?: { pendingClarification?: { field: string; options: string[]; attempts: number } } }[];
    expect(Array.isArray(interrupts)).toBe(true);
    expect(interrupts).toHaveLength(1);
    const pending = interrupts[0]?.value?.pendingClarification;
    expect(pending?.field).toBe("table");
    expect(pending?.attempts).toBe(0);
    expect(pending?.options).toContain("channels");
    expect(pending?.options).not.toContain("orders");

    const resumed = await graph.invoke(new Command({ resume: "channels" }), cfg);
    expect(execCalls).toBe(1);
    expect(seenTables).toEqual(["orders", "channels"]);
    expect(resumed.status).toBe("ok");
    expect(resumed.clarificationAttempts).toBe(1);
    expect(resumed.intent.schemaEntities).toEqual(["orders", "channels"]);
    expect(resumed.question).toContain("Clarification (table for phòng CSKH): channels");
    expect(resumed.answerText).toBe("cnt: 9");
  });

  it("enforces max 2 clarification rounds and asks user to start a new question once exhausted", async () => {
    let execCalls = 0;
    const expandedCatalog: CatalogTable[] = [
      ...BASE_CATALOG,
      { name: "regions", schema: "public", description: "Geographic regions" },
      { name: "products", schema: "public", description: "Product catalog" },
    ];
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => expandedCatalog,
        semanticSearch: async () => [],
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: ["orders", "thực thể 1", "thực thể 2", "thực thể 3"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            throw new Error("executor must not run when entities stay unresolved");
          },
        },
      },
    });

    const cfg = runConfig("t-limit-hitl", "r-limit-hitl");
    const first = (await graph.invoke(
      { question: "Thống kê 3 phần chưa rõ", route: "text-to-sql" },
      cfg,
    )) as Record<string, unknown>;
    expect(Array.isArray(first["__interrupt__"])).toBe(true);

    const second = (await graph.invoke(
      new Command({ resume: "channels" }),
      cfg,
    )) as Record<string, unknown>;
    expect(Array.isArray(second["__interrupt__"])).toBe(true);

    // Pick a valid option on round 2: remaining entity 3 still keeps resolution incomplete after 2 attempts
    const third = await graph.invoke(new Command({ resume: "regions" }), cfg);
    expect(execCalls).toBe(0);
    expect(third.status).toBe("needs_clarification");
    expect(third.pendingClarification).toBeNull();
    expect(third.clarificationAttempts).toBe(2);
    expect(third.answerText).toMatch(/ask a new question/i);
  });

  it("stops and asks user to narrow the question through buildRootGraph when >6 required tables", async () => {
    let execCalls = 0;
    const sevenTables = [
      "orders",
      "order_items",
      "channels",
      "customers",
      "regions",
      "products",
      "promotions",
    ];
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => sevenTables.map((name) => ({ name, schema: "public" })),
        semanticSearch: async () => [],
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: sevenTables,
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            throw new Error("should not execute when required tables exceed cap");
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "Báo cáo 7 bảng", route: "text-to-sql" },
      runConfig("t-too-many", "r-too-many"),
    );
    expect(execCalls).toBe(0);
    expect(out.status).toBe("needs_clarification");
    expect(out.pendingClarification).toBeNull();
    expect(out.answerText).toMatch(/7 bảng/);
    expect(out.answerText).toMatch(/promotions/);
  });

  it("stops with deadline budget status before second follow-up semantic MCP call when clock expires", async () => {
    const queries: string[] = [];
    let currentNow = 1_700_000_000_000;
    const deadlineMs = currentNow + 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentNow);
    try {
      const graph = buildRootGraph({
        checkpointer: new MemorySaver(),
        retrieve: createRetrieveSemantic({ search: async () => [] }),
        synthesize: createAnswerSynthesizer(),
        textToSql: {
          listTables: async () => BASE_CATALOG,
          semanticSearch: async (q) => {
            queries.push(q);
            if (q === "kênh bán") {
              // Advance simulated clock past deadline during first follow-up call
              currentNow = deadlineMs + 10;
            }
            return [];
          },
          intentModel: makeIntentModel({
            requestedMetrics: [],
            schemaEntities: ["orders", "kênh bán", "khu vực"],
            queryMode: "standard_query",
          }).model,
          executor: {
            run: async () => {
              throw new Error("executor must not run after budget deadline");
            },
          },
        },
      });

      const out = await graph.invoke(
        {
          question: "Số đơn theo kênh bán và khu vực",
          route: "text-to-sql",
          budget: {
            llmCalls: 0,
            tokensUsed: 0,
            maxLlmCalls: 20,
            maxTokens: 60_000,
            deadlineMs,
          },
        },
        runConfig("t-followup-deadline", "r-followup-deadline"),
      );
      expect(queries).toEqual(["Số đơn theo kênh bán và khu vực", "kênh bán"]);
      expect(out.status).toBe("error");
      expect(out.budgetExceeded).toBe(true);
      expect(out.answerText).toMatch(/budget_exceeded/);
      expect(out.answerText).toMatch(/deadline/i);
      expect(out.toolsCalled).toContain("search_semantic_layer");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("recovers missing entity via semantic follow-up and filters irrelevant references from SQL prompt", async () => {
    const searchQueries: string[] = [];
    const seenRefs: string[] = [];
    const seenTables: string[] = [];
    const intent = makeIntentModel({
      requestedMetrics: [],
      schemaEntities: ["orders", "kênh bán"],
      queryMode: "standard_query",
    });

    const searchFn = async (q: string): Promise<SearchSemanticLayerChunk[]> => {
      searchQueries.push(q);
      if (q === "kênh bán") {
        return [
          semanticChunk({
            chunkId: "table:channels",
            docType: "table",
            table: "channels",
            tables: ["channels"],
            content: "Bảng kênh bán hàng (channels) gồm channel_name",
            score: 0.94,
          }),
        ];
      }
      return [
        semanticChunk({
          chunkId: "table:orders",
          docType: "table",
          table: "orders",
          tables: ["orders"],
          content: "Bảng đơn hàng (orders) gồm status và channel_id",
          score: 0.9,
        }),
        semanticChunk({
          chunkId: "table:order_items",
          docType: "table",
          table: "order_items",
          tables: ["order_items"],
          content: "Chi tiết dòng sản phẩm trong đơn",
          score: 0.88,
          aliasMatched: false,
          denseScore: 0.5,
        }),
        semanticChunk({
          chunkId: "example:orders_sample",
          docType: "example",
          tables: ["orders"],
          content: "SELECT * FROM public.orders LIMIT 10",
          score: 0.99,
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
        intentModel: intent.model,
        executor: {
          run: async (input) => {
            seenTables.push(...input.candidateTables);
            seenRefs.push(...(input.references ?? []));
            return {
              status: "ok",
              sql: "SELECT c.channel_name, COUNT(*) AS cnt FROM public.orders o JOIN public.channels c ON c.channel_id = o.channel_id GROUP BY c.channel_name",
              tablesUsed: ["orders", "channels"],
              columns: ["channel_name", "cnt"],
              rows: [{ channel_name: "Website", cnt: 7 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "Số đơn hàng theo kênh bán", route: "text-to-sql" },
      runConfig("t-followup-ok", "r-followup-ok"),
    );

    expect(out.status).toBe("ok");
    expect(intent.calls).toBe(1);
    expect(searchQueries).toEqual(["Số đơn hàng theo kênh bán", "kênh bán"]);
    expect(seenTables).toEqual(["orders", "channels"]);
    expect(seenRefs.some((r) => r.includes("table:channels"))).toBe(true);
    expect(seenRefs.some((r) => r.includes("table:orders"))).toBe(true);
    expect(seenRefs.some((r) => r.includes("table:order_items"))).toBe(false);
    expect(seenRefs.some((r) => r.includes("example:orders_sample"))).toBe(false);
  });

  it("surfaces SCOPE_DENIED on follow-up semantic search as restricted instead of needs_clarification", async () => {
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async (q) => {
          if (q === "kênh bán") {
            throw dbToolError("SCOPE_DENIED", "semantic access denied");
          }
          return [
            semanticChunk({
              chunkId: "table:orders",
              docType: "table",
              table: "orders",
              tables: ["orders"],
              content: "Orders header",
            }),
          ];
        },
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: ["orders", "kênh bán"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            throw new Error("should not execute on restricted follow-up");
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "Số đơn hàng theo kênh bán", route: "text-to-sql" },
      runConfig("t-followup-denied", "r-followup-denied"),
    );

    expect(out.status).toBe("restricted");
  });

  it("stops cleanly and asks to rephrase when user selects NO_MATCHING_TABLE_OPTION on resume", async () => {
    let execCalls = 0;
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async () => [],
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: ["orders", "bộ phận CSKH"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            throw new Error("executor must not run when user rejects suggested tables");
          },
        },
      },
    });

    const cfg = runConfig("t-abort-rephrase", "r-abort-rephrase");
    const first = (await graph.invoke(
      { question: "Đếm số đơn hàng của bộ phận CSKH", route: "text-to-sql" },
      cfg,
    )) as Record<string, unknown>;
    const interrupts = first["__interrupt__"] as {
      value?: { pendingClarification?: { options: string[] } };
    }[];
    const options = interrupts[0]?.value?.pendingClarification?.options ?? [];
    expect(options).toContain(NO_MATCHING_TABLE_OPTION);

    const resumed = await graph.invoke(
      new Command({ resume: NO_MATCHING_TABLE_OPTION }),
      cfg,
    );
    expect(execCalls).toBe(0);
    expect(resumed.status).toBe("needs_clarification");
    expect(resumed.pendingClarification).toBeNull();
    expect(resumed.clarificationAttempts).toBe(1);
    expect(resumed.answerText).toMatch(/ask a new question/i);
  });

  it("accepts a valid catalog table supplied on resume even when outside the top 3 suggested options", async () => {
    const seenTables: string[] = [];
    const largerCatalog: CatalogTable[] = [
      ...BASE_CATALOG,
      { name: "customers", schema: "public", description: "Buyers" },
      { name: "regions", schema: "public", description: "Regions" },
      { name: "products", schema: "public", description: "Products" },
      { name: "sellers", schema: "public", description: "Merchants" },
    ];

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: async () => [] }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => largerCatalog,
        semanticSearch: async () => [],
        intentModel: makeIntentModel({
          requestedMetrics: [],
          schemaEntities: ["orders", "gian hàng"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async (input) => {
            seenTables.push(...input.candidateTables);
            return {
              status: "ok",
              sql: "SELECT COUNT(*) AS cnt FROM public.orders",
              tablesUsed: input.candidateTables,
              columns: ["cnt"],
              rows: [{ cnt: 5 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });

    const cfg = runConfig("t-custom-catalog-resume", "r-custom-catalog-resume");
    const first = (await graph.invoke(
      { question: "Đếm số đơn hàng theo gian hàng", route: "text-to-sql" },
      cfg,
    )) as Record<string, unknown>;
    const interrupts = first["__interrupt__"] as {
      value?: { pendingClarification?: { options: string[] } };
    }[];
    const options = interrupts[0]?.value?.pendingClarification?.options ?? [];
    expect(options).toHaveLength(4);
    expect(options).not.toContain("sellers");
    expect(options[3]).toBe(NO_MATCHING_TABLE_OPTION);

    const resumed = await graph.invoke(new Command({ resume: "sellers" }), cfg);
    expect(resumed.status).toBe("ok");
    expect(seenTables).toEqual(["orders", "sellers", "order_items"]);
  });

  it("includes metric-required tables in requiredTables cap check and rejects when 6 entities + metric add a 7th table", async () => {
    let execCalls = 0;
    const sixEntities = [
      "orders",
      "channels",
      "customers",
      "regions",
      "products",
      "promotions",
    ];
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => [
      semanticChunk({
        chunkId: "metric:net_revenue",
        docType: "metric",
        tables: ["orders", "order_items"],
        metricName: "net_revenue",
        content: "Doanh thu thuần (net_revenue) = SUM(order_items.price_vnd)",
        score: 0.96,
        aliasMatched: true,
      }),
    ];

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () =>
          [...sixEntities, "order_items"].map((name) => ({ name, schema: "public" })),
        semanticSearch: searchFn,
        intentModel: makeIntentModel({
          requestedMetrics: ["doanh thu thuần"],
          schemaEntities: sixEntities,
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            throw new Error("should stop when entity + metric tables exceed 6");
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "Doanh thu thuần across 6 entities", route: "text-to-sql" },
      runConfig("t-metric-cap", "r-metric-cap"),
    );
    expect(execCalls).toBe(0);
    expect(out.status).toBe("needs_clarification");
    expect(out.pendingClarification).toBeNull();
    expect(out.answerText).toMatch(/7 bảng/);
    expect(out.answerText).toMatch(/order_items/);
  });

  it("clarifies rather than returning cannot_answer when a metric grounds partialTables alongside an unmapped entity", async () => {
    let execCalls = 0;
    const searchFn = async (): Promise<SearchSemanticLayerChunk[]> => [
      semanticChunk({
        chunkId: "metric:order_count",
        docType: "metric",
        tables: ["orders"],
        metricName: "order_count",
        content: "Số đơn hàng (order_count) = COUNT(orders.id)",
        score: 0.95,
        aliasMatched: true,
      }),
    ];

    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search: searchFn }),
      synthesize: createAnswerSynthesizer(),
      textToSql: {
        listTables: async () => BASE_CATALOG,
        semanticSearch: async (q) => (q === "tổ phụ trách" ? [] : searchFn()),
        intentModel: makeIntentModel({
          requestedMetrics: ["order_count"],
          schemaEntities: ["tổ phụ trách"],
          queryMode: "standard_query",
        }).model,
        executor: {
          run: async () => {
            execCalls += 1;
            return {
              status: "ok",
              sql: "SELECT COUNT(*) AS n FROM public.orders",
              tablesUsed: ["orders"],
              columns: ["n"],
              rows: [{ n: 10 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });

    const out = (await graph.invoke(
      { question: "Số đơn hàng theo tổ phụ trách", route: "text-to-sql" },
      runConfig("t-partial-clarify", "r-partial-clarify"),
    )) as Record<string, unknown>;
    expect(execCalls).toBe(0);
    expect(out["status"]).not.toBe("cannot_answer");
    expect(Array.isArray(out["__interrupt__"])).toBe(true);
  });
});
