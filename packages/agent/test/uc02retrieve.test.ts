// UC-02 retrieveSemantic gate tests: unknown-term short-circuit + definitional pass-through.
import { describe, expect, it } from "vitest";
import {
  buildCannotAnswer,
  buildDefinitionAnswer,
  checkUnknownTerms,
  closestMetrics,
  createRetrieveSemantic,
  isMetricGrounded,
  UNKNOWN_TERM_DENSE_THRESHOLD,
  type GroundingChunk,
} from "../src/semantic/retrieveSemantic.js";
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

  it("passes basic queries with no requested metrics (no search)", async () => {
    let searched = false;
    const retrieve = createRetrieveSemantic({
      search: async () => {
        searched = true;
        return [];
      },
    });
    const out = await retrieve(stateWith({ requestedMetrics: [] }), fakeRuntime());
    expect(out).toEqual({});
    expect(searched).toBe(false);
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
});
