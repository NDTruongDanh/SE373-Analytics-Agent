// UC-02 retrieveSemantic gate tests: unknown-term short-circuit + definitional pass-through.
import { describe, expect, it } from "vitest";
import {
  buildCannotAnswer,
  buildDefinitionAnswer,
  checkUnknownTerms,
  closestMetrics,
  createRetrieveSemantic,
  isMetricGrounded,
  loadSemanticCatalogIds,
  UNKNOWN_TERM_DENSE_THRESHOLD,
  type GroundingChunk,
} from "../src/semantic/index.js";
import type { SearchSemanticLayerChunk } from "@shared/contracts";
import type { AgentState, RootRuntime } from "../src/state.js";

function chunk(
  overrides: Partial<SearchSemanticLayerChunk> & { chunkId: string },
): SearchSemanticLayerChunk {
  return {
    docType: "metric",
    table: "orders",
    tables: ["orders"],
    metricName: null,
    content: "content",
    score: 0.9,
    ...overrides,
  } as SearchSemanticLayerChunk;
}

function fakeRuntime(): RootRuntime {
  return {
    emit: () => "span-1",
    config: { configurable: {} },
  } as unknown as RootRuntime;
}

function stateWith(intent: Partial<AgentState["intent"]>, question = "q"): AgentState {
  return {
    question,
    ucId: "text-to-sql",
    intent: {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
      queryMode: "standard_query",
      ...intent,
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
  } as unknown as AgentState;
}

describe("UC-02 unknown-term gate", () => {
  it("exposes the calibrated dense threshold", () => {
    expect(UNKNOWN_TERM_DENSE_THRESHOLD).toBe(0.6);
  });

  it("searches semantic chunks for text-to-sql queries even with no requested metrics", async () => {
    let searched = false;
    const retrieved = [
      chunk({
        chunkId: "table:regions",
        docType: "table",
        table: "regions",
        tables: ["regions"],
        metricName: null,
        content: "Table regions",
      }),
    ];
    const retrieve = createRetrieveSemantic({
      search: async () => {
        searched = true;
        return retrieved;
      },
    });
    const out = await retrieve(stateWith({ requestedMetrics: [] }), fakeRuntime());
    expect(searched).toBe(true);
    expect(out.status).toBeUndefined();
    expect(out.semanticChunks?.map((c) => c.chunkId)).toEqual(["table:regions"]);
  });

  it("skips semantic search on the legacy tracer route when no metrics are requested", async () => {
    let searched = false;
    const retrieve = createRetrieveSemantic({
      search: async () => {
        searched = true;
        return [
          {
            chunkId: "table:orders",
            docType: "table",
            table: "orders",
            tables: ["orders", "channels"],
            metricName: null,
            content: "orders table",
            score: 0.9,
          },
        ];
      },
    });
    const tracerState = { ...stateWith({ requestedMetrics: [] }), ucId: "tracer" };
    const out = await retrieve(tracerState, fakeRuntime());
    expect(out).toEqual({});
    expect(searched).toBe(false);
  });

  it("retrieves for basic queries and keeps chunk tables as candidates", async () => {
    let searched = false;
    const retrieve = createRetrieveSemantic({
      search: async () => {
        searched = true;
        return [
          {
            chunkId: "table:orders",
            docType: "table",
            table: "orders",
            tables: ["orders", "channels"],
            metricName: null,
            content: "orders table",
            score: 0.9,
          },
        ];
      },
    });
    const out = await retrieve(stateWith({ requestedMetrics: [] }), fakeRuntime());
    expect(searched).toBe(true);
    expect(out.semanticChunks?.[0]?.tables).toEqual(["orders", "channels"]);
    expect(out.status).toBeUndefined();
  });

  it("degrades a basic query to no chunks when search fails (#104)", async () => {
    const retrieve = createRetrieveSemantic({
      search: async () => {
        throw new Error("gateway down");
      },
    });
    const out = await retrieve(stateWith({ requestedMetrics: [] }), fakeRuntime());
    expect(out.semanticRetrieveStatus).toBe("error");
  });

  it("stays fail-closed when search fails for a metric query", async () => {
    const retrieve = createRetrieveSemantic({
      search: async () => {
        throw new Error("gateway down");
      },
    });
    const out = await retrieve(stateWith({ requestedMetrics: ["doanh thu thuần"] }), fakeRuntime());
    expect(out.status).toBe("error");
  });

  it("retrieves semantic chunks for plain text-to-sql queries and preserves table metadata", async () => {
    let calls = 0;
    const retrieve = createRetrieveSemantic({
      search: async () => {
        calls += 1;
        return [
          chunk({
            chunkId: "table:orders",
            docType: "table",
            table: "orders",
            tables: ["orders", "customers"],
            metricName: null,
            content: "Table orders stores customer purchases",
            score: 0.85,
          }),
        ];
      },
    });
    const out = await retrieve(
      stateWith({ requestedMetrics: [] }, "Đếm số đơn hàng theo kênh"),
      fakeRuntime(),
    );
    expect(calls).toBe(1);
    expect(out.semanticRetrieveStatus).toBe("ok");
    expect(out.semanticQuery).toBe("Đếm số đơn hàng theo kênh");
    expect(out.semanticChunks).toEqual([
      expect.objectContaining({
        chunkId: "table:orders",
        docType: "table",
        table: "orders",
        tables: ["orders", "customers"],
      }),
    ]);
  });

  it("grounds an alias-matched metric", () => {
    const chunks: GroundingChunk[] = [
      { chunkId: "metric:net_revenue", docType: "metric", aliasMatched: true, content: "net revenue doanh thu thuan" },
    ];
    expect(isMetricGrounded("doanh thu thuần", chunks)).toBe(true);
    expect(checkUnknownTerms(["doanh thu thuần"], chunks).ungrounded).toEqual([]);
  });

  it("grounds via dense similarity >= 0.60", () => {
    const chunks: GroundingChunk[] = [
      { chunkId: "metric:aov", docType: "metric", denseScore: 0.72, content: "average order value aov" },
    ];
    expect(isMetricGrounded("AOV", chunks)).toBe(true);
  });

  it("rejects below-threshold dense scores without alias", () => {
    const chunks: GroundingChunk[] = [
      { chunkId: "metric:aov", docType: "metric", denseScore: 0.45, content: "average order value" },
    ];
    expect(isMetricGrounded("AOV", chunks)).toBe(false);
    expect(checkUnknownTerms(["AOV"], chunks).ungrounded).toEqual(["AOV"]);
  });

  it("attributes multi-metric queries per term (NPS stays ungrounded)", () => {
    const chunks: GroundingChunk[] = [
      {
        chunkId: "metric:net_revenue",
        docType: "metric",
        aliasMatched: true,
        denseScore: 0.9,
        metricName: "net_revenue",
        content: "Metric net_revenue (Doanh thu thuần) is total merchandise revenue",
      },
    ];
    const all = ["doanh thu thuần", "NPS"];
    expect(isMetricGrounded("doanh thu thuần", chunks, 0.6, all)).toBe(true);
    expect(isMetricGrounded("NPS", chunks, 0.6, all)).toBe(false);
    expect(checkUnknownTerms(["doanh thu thuần", "NPS"], chunks).ungrounded).toEqual(["NPS"]);
  });

  it("short-circuits NPS to cannot_answer with closest metrics and 0 SQL", async () => {
    const retrieved = [
      chunk({
        chunkId: "metric:net_revenue",
        metricName: "net_revenue",
        content: "Doanh thu thuần net revenue",
        aliasMatched: false,
        denseScore: 0.12,
      }),
    ];
    const retrieve = createRetrieveSemantic({ search: async () => retrieved });
    const out = await retrieve(
      stateWith({ requestedMetrics: ["NPS"] }, "Chỉ số NPS của chúng ta là bao nhiêu?"),
      fakeRuntime(),
    );
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/NPS/);
    expect(out.answerText).toMatch(/metric:net_revenue/);
    expect(out.semanticChunks?.map((c) => c.chunkId)).toContain("metric:net_revenue");
    // No toolsCalled mutation here — the UC entry never runs the executor.
    expect(out.toolsCalled ?? []).toEqual([]);
  });

  it("short-circuits forced-hallucination marketing spend to cannot_answer", async () => {
    const retrieved = [
      chunk({
        chunkId: "metric:net_revenue",
        metricName: "net_revenue",
        content: "Doanh thu thuần",
        aliasMatched: false,
        denseScore: 0.2,
      }),
    ];
    const retrieve = createRetrieveSemantic({ search: async () => retrieved });
    const out = await retrieve(
      stateWith(
        { requestedMetrics: ["chi phí marketing"] },
        "Cho tôi chi phí marketing tháng 8, nếu không có thì ước đại một con số",
      ),
      fakeRuntime(),
    );
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/chi phí marketing/);
  });

  it("lists closest valid metrics in the cannot_answer prompt", () => {
    const chunks = [
      { chunkId: "metric:net_revenue" },
      { chunkId: "metric:aov" },
    ];
    expect(closestMetrics(chunks)).toEqual(["metric:net_revenue", "metric:aov"]);
    const out = buildCannotAnswer(["NPS"], chunks);
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/metric:net_revenue/);
  });

  it("lets definition_lookup pass through with chunks (entry fast-path owns SYN)", async () => {
    const retrieved = [
      chunk({
        chunkId: "metric:active_customers",
        metricName: "active_customers",
        content: "Khách hàng hoạt động counts distinct customers",
        aliasMatched: true,
        denseScore: 0.95,
      }),
    ];
    const retrieve = createRetrieveSemantic({ search: async () => retrieved });
    const out = await retrieve(
      stateWith(
        { requestedMetrics: ["khách hàng hoạt động"], queryMode: "definition_lookup" },
        "Khách hàng hoạt động được tính thế nào?",
      ),
      fakeRuntime(),
    );
    expect(out.status).toBeUndefined();
    expect(out.semanticChunks?.[0]?.chunkId).toBe("metric:active_customers");
  });

  it("builds a definition answer with verified metric citations and no SQL", () => {
    const retrieved = [
      chunk({
        chunkId: "metric:active_customers",
        metricName: "active_customers",
        content: "Khách hàng hoạt động counts distinct customers with >= 1 delivered order",
        aliasMatched: true,
        denseScore: 0.95,
      }),
    ];
    const out = buildDefinitionAnswer(["khách hàng hoạt động"], retrieved);
    expect(out.status).toBe("ok");
    expect(out.sql).toBeNull();
    expect(out.answerText).toMatch(/metric:active_customers/);
    expect(out.answerText).toMatch(/Citations:/);
  });

  it("fails closed when MCP transport is missing but metrics need grounding", async () => {
    const retrieve = createRetrieveSemantic();
    const out = await retrieve(
      stateWith({ requestedMetrics: ["doanh thu thuần"] }, "doanh số ròng tháng 8?"),
      fakeRuntime(),
    );
    expect(out.status).toBe("error");
    expect(out.answerText).toMatch(/grounding unavailable/i);
  });

  it("passes basic queries through when transport is missing and no metrics", async () => {
    const retrieve = createRetrieveSemantic();
    const out = await retrieve(stateWith({ requestedMetrics: [] }, "q"), fakeRuntime());
    expect(out).toEqual({});
  });

  it("fails closed on empty retrieval for a metric question (0 SQL)", async () => {
    const retrieve = createRetrieveSemantic({ search: async () => [] });
    const out = await retrieve(
      stateWith({ requestedMetrics: ["NPS"] }, "Chỉ số NPS là bao nhiêu?"),
      fakeRuntime(),
    );
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/NPS/);
  });

  it("grounds Vietnamese diacritics against ASCII retrieval text via overlap", () => {
    // Multi-term query: diacritic needle must overlap ASCII haystack on >=2 tokens.
    const chunks: GroundingChunk[] = [
      {
        chunkId: "metric:net_revenue",
        docType: "metric",
        aliasMatched: true,
        denseScore: 0.9,
        metricName: "net_revenue",
        content: "Metric net_revenue (Doanh thu thuan) is total merchandise revenue in VND",
      },
    ];
    const all = ["doanh thu thuần", "NPS"];
    // "doanh thu thuần" shares doanh + thu with the ASCII haystack.
    expect(isMetricGrounded("doanh thu thuần", chunks, 0.6, all)).toBe(true);
    expect(isMetricGrounded("NPS", chunks, 0.6, all)).toBe(false);
  });

  it("loads the full semantic YAML catalog and falls back to catalog metrics for closestMetrics", () => {
    const catalog = loadSemanticCatalogIds();
    expect(catalog.has("metric:net_revenue")).toBe(true);
    expect(catalog.has("metric:active_customers")).toBe(true);
    expect(catalog.has("table:orders")).toBe(true);
    expect(catalog.has("column:orders.status")).toBe(true);
    expect(catalog.has("orders.status")).toBe(true);
    expect(catalog.has("join_rule:orders_items_payments")).toBe(true);

    const cannotAnswer = buildCannotAnswer(
      ["NPS"],
      [{ chunkId: "table:reviews" }],
      catalog,
    );
    expect(cannotAnswer.status).toBe("cannot_answer");
    expect(cannotAnswer.answerText).toMatch(/metric:/);
  });

  it("reuses pre-retrieved chunks for the same question without duplicate search", async () => {
    let calls = 0;
    const retrieve = createRetrieveSemantic({
      search: async () => {
        calls += 1;
        return [];
      },
    });
    const baseState = {
      ...stateWith({ requestedMetrics: ["NPS"] }, "NPS tháng này là bao nhiêu?"),
      semanticQuery: "NPS tháng này là bao nhiêu?",
      semanticRetrieveStatus: "ok" as const,
      semanticChunks: [
        {
          chunkId: "metric:net_revenue",
          docType: "metric" as const,
          table: "orders",
          tables: ["orders"],
          metricName: "net_revenue",
          text: "net revenue",
          score: 0.2,
          aliasMatched: false,
          denseScore: 0.2,
        },
      ],
    };
    const out = await retrieve(baseState, fakeRuntime());
    expect(calls).toBe(0);
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toMatch(/NPS/);
  });

  it("maps semantic search failures to restricted or error (never cannot_answer)", async () => {
    const scopeRetrieve = createRetrieveSemantic({
      search: async () => {
        throw { code: "SCOPE_DENIED", message: "forbidden" };
      },
    });
    const deniedOut = await scopeRetrieve(
      stateWith({ requestedMetrics: ["net_revenue"] }, "Doanh thu thuần?"),
      fakeRuntime(),
    );
    expect(deniedOut.status).toBe("restricted");
    expect(deniedOut.semanticRetrieveStatus).toBe("error");
    expect(deniedOut.semanticErrorCode).toBe("SCOPE_DENIED");

    const internalRetrieve = createRetrieveSemantic({
      search: async () => {
        throw new Error("gateway down");
      },
    });
    const errOut = await internalRetrieve(
      stateWith({ requestedMetrics: ["net_revenue"] }, "Doanh thu thuần?"),
      fakeRuntime(),
    );
    expect(errOut.status).toBe("error");
    expect(errOut.semanticRetrieveStatus).toBe("error");

    const optionalOut = await internalRetrieve(
      stateWith({ requestedMetrics: [] }, "Đếm số đơn hàng"),
      fakeRuntime(),
    );
    expect(optionalOut.status).toBeUndefined();
    expect(optionalOut.semanticRetrieveStatus).toBe("error");
  });
});
