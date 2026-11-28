import { describe, expect, it } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { AnalysisState } from "@shared/contracts";
import { buildRootGraph, createRetrieveSemantic, createAnswerSynthesizer, routeQuestion } from "../src/index.js";
import {
  buildGroundedSearchQuery,
  compactTurnCheckpoint,
  finalizeTurnMemory,
  resolveMultiTurnIntent,
  type MultiTurnProposal,
} from "../src/multiTurn.js";
import type { AgentState } from "../src/state.js";

const prior: AnalysisState = {
  metric: "net_revenue",
  dimensions: [],
  filters: [
    { field: "region", operator: "=", value: "Nam" },
    { field: "channel", operator: "=", value: "Lazada" },
  ],
  timeRange: "2026-09",
  requestedMetrics: ["net_revenue"],
  schemaEntities: ["orders", "order_items"],
  citations: ["metric:net_revenue"],
  lastSqlHash: "a".repeat(64),
};

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    question: "Còn quý trước thì sao?",
    route: "text-to-sql",
    intent: {
      metric: null, dimensions: [], filters: [], timeRange: null,
      requestedMetrics: [], schemaEntities: [], queryMode: "standard_query",
    },
    analysisState: prior,
    analysisTopicChanged: false,
    turnHistory: [],
    clarificationAttempts: 0,
    status: "no_data",
    answerText: "",
    sql: null,
    ...overrides,
  } as AgentState;
}

function proposal(overrides: Partial<MultiTurnProposal> = {}): MultiTurnProposal {
  return {
    metric: null, dimensions: [], filters: [], timeRange: null,
    requestedMetrics: [], schemaEntities: [], queryMode: "standard_query",
    isFollowUp: true, topicChanged: false, ambiguousReference: false,
    clarificationCandidates: [], deltaOps: [],
    ...overrides,
  };
}

describe("multi-turn intent and checkpoint memory", () => {
  it("keeps the metric and region while changing time and adding a channel breakdown", () => {
    const changed = resolveMultiTurnIntent(state(), proposal({
      deltaOps: [{ op: "replace", field: "timeRange", value: "2026-Q2" }],
    }));
    expect(changed.kind).toBe("intent");
    if (changed.kind !== "intent") return;
    expect(changed.intent).toMatchObject({ metric: "net_revenue", timeRange: "2026-Q2" });
    expect(changed.intent.filters).toContainEqual({ field: "region", operator: "=", value: "Nam" });
    const grouped = resolveMultiTurnIntent(state({ analysisState: { ...prior, timeRange: "2026-Q2" } }), proposal({
      schemaEntities: ["channels"],
      deltaOps: [{ op: "add", field: "dimensions", value: ["channel"] }],
    }));
    expect(grouped.kind).toBe("intent");
    if (grouped.kind !== "intent") return;
    expect(grouped.intent.dimensions).toEqual(["channel"]);
    expect(grouped.intent.schemaEntities).toContain("channels");
    expect(buildGroundedSearchQuery("Tách theo kênh", grouped.intent)).toContain("net_revenue");
  });

  it("removes only the named filter and resets cleanly on topic change", () => {
    const removed = resolveMultiTurnIntent(state(), proposal({
      deltaOps: [{ op: "remove", field: "filters", value: "Lazada" }],
    }));
    expect(removed.kind).toBe("intent");
    if (removed.kind !== "intent") return;
    expect(removed.intent.filters).toEqual([{ field: "region", operator: "=", value: "Nam" }]);
    expect(removed.intent.timeRange).toBe("2026-09");
    const reset = resolveMultiTurnIntent(state(), proposal({
      topicChanged: true, isFollowUp: false, metric: "new_customers",
      requestedMetrics: ["new_customers"], schemaEntities: ["customers"],
    }));
    expect(reset).toMatchObject({ kind: "intent", followUp: false, topicChanged: true });
    if (reset.kind !== "intent") return;
    expect(reset.intent.filters).toEqual([]);
    expect(reset.intent.schemaEntities).toEqual(["customers"]);
  });

  it("asks for an ambiguous historical metric instead of selecting one", () => {
    const result = resolveMultiTurnIntent(state(), proposal({
      ambiguousReference: true,
      clarificationCandidates: ["net_revenue", "order_count"],
    }));
    expect(result.kind).toBe("clarification");
    if (result.kind !== "clarification") return;
    expect(result.pendingClarification?.options).toEqual(["net_revenue", "order_count"]);
    expect(resolveMultiTurnIntent(state({ clarificationAttempts: 2 }), proposal({
      ambiguousReference: true, clarificationCandidates: ["net_revenue", "order_count"],
    }))).toMatchObject({ kind: "clarification", pendingClarification: null });
  });

  it("keeps three redacted summaries and updates analysis state only for valid SQL", () => {
    const turnHistory = Array.from({ length: 3 }, (_, i) => ({
      question: `q${i}`, summary: `s${i}`, status: "ok" as const,
    }));
    const current = state({
      question: "Số đơn của 0901234567?",
      status: "ok", answerText: "Có 3 đơn của user@example.vn.",
      intent: { metric: "order_count", dimensions: [], filters: [], timeRange: "2026-Q2",
        requestedMetrics: ["order_count"], schemaEntities: ["orders"], queryMode: "standard_query" },
      sql: "-- @citations: metric:order_count\nSELECT COUNT(*) FROM public.orders",
      turnHistory,
    });
    const finalized = finalizeTurnMemory(current, {});
    expect(finalized.turnHistory).toHaveLength(3);
    expect(JSON.stringify(finalized.turnHistory)).not.toContain("0901234567");
    expect(JSON.stringify(finalized.turnHistory)).not.toContain("user@example.vn");
    expect(finalized.analysisState).toMatchObject({ metric: "order_count", citations: ["metric:order_count"] });
    expect(finalized.analysisState?.lastSqlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(finalizeTurnMemory(state({ status: "restricted" }), {}).analysisState).toBeUndefined();
    expect(finalizeTurnMemory(state({ status: "error", analysisTopicChanged: true }), {}).analysisState).toBeNull();
  });

  it("carries context through five graph turns and compacts each completed checkpoint", async () => {
    const prompts: string[] = [];
    const searches: string[] = [];
    const contexts: unknown[] = [];
    const proposals = [
      proposal({ isFollowUp: false, metric: "net_revenue", requestedMetrics: ["net_revenue"],
        schemaEntities: ["orders", "order_items", "channels"], timeRange: "2026-09",
        filters: [{ field: "region", operator: "=", value: "Nam" },
          { field: "channel", operator: "=", value: "Lazada" }] }),
      proposal({ deltaOps: [{ op: "replace", field: "timeRange", value: "2026-Q2" }] }),
      proposal({ schemaEntities: ["channels"], deltaOps: [{ op: "add", field: "dimensions", value: ["channel"] }] }),
      proposal({ deltaOps: [{ op: "remove", field: "filters", value: "Lazada" }] }),
      proposal({ isFollowUp: false, topicChanged: true, metric: "new_customers",
        requestedMetrics: ["new_customers"], schemaEntities: ["customers"] }),
    ];
    let call = 0;
    const intentModel = { withStructuredOutput: () => ({ invoke: async (prompt: string) => {
      prompts.push(prompt);
      return proposals[Math.min(call++, proposals.length - 1)];
    } }) };
    const chunks = [
      { chunkId: "table:orders", docType: "table", table: "orders", tables: ["orders"],
        metricName: null, content: "Orders", score: 0.9, aliasMatched: true },
      { chunkId: "table:order_items", docType: "table", table: "order_items", tables: ["order_items"],
        metricName: null, content: "Order items", score: 0.9, aliasMatched: true },
      { chunkId: "table:channels", docType: "table", table: "channels", tables: ["channels"],
        metricName: null, content: "Channels", score: 0.9, aliasMatched: true },
      { chunkId: "table:customers", docType: "table", table: "customers", tables: ["customers"],
        metricName: null, content: "Customers", score: 0.9, aliasMatched: true },
      { chunkId: "metric:net_revenue", docType: "metric", table: "orders", tables: ["orders", "order_items"],
        metricName: "net_revenue", content: "Net revenue", score: 0.95, aliasMatched: true },
      { chunkId: "metric:new_customers", docType: "metric", table: "customers", tables: ["customers"],
        metricName: "new_customers", content: "New customers", score: 0.95, aliasMatched: true },
    ] as const;
    const search = async (query: string) => { searches.push(query); return [...chunks] as never; };
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search }),
      synthesize: createAnswerSynthesizer({ model: null }),
      textToSql: {
        listTables: async () => ["orders", "order_items", "channels", "customers"].map((name) => ({ name, schema: "public" })),
        semanticSearch: search,
        intentModel: intentModel as never,
        executor: { run: async (input) => {
          contexts.push(input.analysisContext);
          return {
            status: "ok", sql: "SELECT COUNT(*) AS n FROM public.orders",
            tablesUsed: ["orders"], columns: ["n"], rows: [{ n: 1 }],
            maskedColumns: [], attempts: 1,
          };
        } },
      },
    });
    const questions = [
      "Doanh thu thuần tháng 9 miền Nam kênh Lazada?",
      "Còn quý trước thì sao?",
      "Tách theo kênh giúp tôi",
      "Bỏ kênh Lazada ra",
      "Có bao nhiêu khách hàng mới?",
    ];
    const config = { configurable: {
      thread_id: "multi-turn-128", threadId: "multi-turn-128", runId: "run-multi", userId: "u-128",
      roleScope: "sales_south", mcpUrl: "http://127.0.0.1:1/mcp", token: "tok",
    } };
    for (let i = 0; i < questions.length; i += 1) {
      const input = {
        question: questions[i], runId: `run-${i}`, threadId: "multi-turn-128",
        status: "no_data" as const, answerText: "", sql: null, resultPreview: [],
        semanticChunks: [], semanticQuery: null, semanticRetrieveStatus: "unloaded" as const,
        rowCount: null, resultTruncated: false, analysisTopicChanged: false,
      };
      const out = await graph.invoke(input, config);
      expect(out.status, `turn ${i}: ${out.answerText}`).toBe("ok");
      expect(out.resultPreview).toEqual([{ n: 1 }]);
      expect(out.analysisState?.lastSqlHash).toMatch(/^[a-f0-9]{64}$/);
      await compactTurnCheckpoint(graph, config);
      const stored = await graph.getState(config);
      expect(stored.values.resultPreview).toEqual([]);
      expect(stored.values.semanticChunks).toEqual([]);
      expect(stored.values.turnHistory.length).toBeLessThanOrEqual(3);
    }
    expect(searches).toHaveLength(5);
    expect(searches[1]).toContain("net_revenue");
    expect(searches[1]).toContain("Nam");
    expect(prompts[1]).toContain("<conversation-context>");
    expect(contexts[1]).toMatchObject({ metric: "net_revenue", timeRange: "2026-Q2" });
    expect(contexts[2]).toMatchObject({ dimensions: ["channel"] });
    expect(contexts[3]).toMatchObject({ filters: [{ field: "region", operator: "=", value: "Nam" }] });
    expect(contexts[4]).toMatchObject({ metric: "new_customers", filters: [] });
  });

  it("routes brief cause follow-ups to RCA when prior state exists and resumes ambiguous metric clarification", async () => {
    expect(routeQuestion("Nguyên nhân kênh này thì sao?", prior)).toBe("root-cause-analysis");
    expect(routeQuestion("Tách theo kênh giúp tôi", prior)).toBe("text-to-sql");

    const searches: string[] = [];
    const seenContexts: unknown[] = [];
    const chunks = [
      { chunkId: "table:orders", docType: "table", table: "orders", tables: ["orders"],
        metricName: null, content: "Orders", score: 0.9, aliasMatched: true },
      { chunkId: "metric:net_revenue", docType: "metric", table: "orders", tables: ["orders"],
        metricName: "net_revenue", content: "Net revenue", score: 0.95, aliasMatched: true },
      { chunkId: "metric:order_count", docType: "metric", table: "orders", tables: ["orders"],
        metricName: "order_count", content: "Order count", score: 0.95, aliasMatched: true },
    ] as const;
    const proposals = [
      proposal({ isFollowUp: false, metric: "net_revenue", requestedMetrics: ["net_revenue"],
        schemaEntities: ["orders"], timeRange: "2026-09",
        filters: [{ field: "region", operator: "=", value: "Nam" }] }),
      proposal({ ambiguousReference: true, clarificationCandidates: ["net_revenue", "order_count"] }),
    ];
    let turn = 0;
    const search = async (query: string) => { searches.push(query); return [...chunks] as never; };
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search }),
      synthesize: createAnswerSynthesizer({ model: null }),
      textToSql: {
        listTables: async () => [{ name: "orders", schema: "public" }],
        semanticSearch: search,
        intentModel: { withStructuredOutput: () => ({ invoke: async () => proposals[Math.min(turn++, proposals.length - 1)] }) } as never,
        executor: { run: async (input) => {
          seenContexts.push(input.analysisContext);
          return {
            status: "ok", sql: "SELECT COUNT(*) AS n FROM public.orders",
            tablesUsed: ["orders"], columns: ["n"], rows: [{ n: 5 }],
            maskedColumns: [], attempts: 1,
          };
        } },
      },
    });
    const config = { configurable: {
      thread_id: "clarify-follow-128", threadId: "clarify-follow-128", runId: "run-cf", userId: "u-128",
      roleScope: "sales_south", mcpUrl: "http://127.0.0.1:1/mcp", token: "tok",
    } };
    const t1 = await graph.invoke({ question: "Doanh thu thuần tháng 9 miền Nam?", runId: "run-1", threadId: "clarify-follow-128" }, config);
    expect(t1.status).toBe("ok");
    await compactTurnCheckpoint(graph, config);

    const paused = await graph.invoke({ question: "Cái kia thì sao?", runId: "run-2", threadId: "clarify-follow-128" }, config);
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__?.length).toBeGreaterThan(0);

    const resumed = await graph.invoke(new Command({ resume: "order_count" }), config);
    expect(resumed.status).toBe("ok");
    expect(resumed.analysisState?.metric).toBe("order_count");
    expect(seenContexts[1]).toMatchObject({
      metric: "order_count",
      timeRange: "2026-09",
      filters: [{ field: "region", operator: "=", value: "Nam" }],
    });
    expect(searches.some((query) => query.includes("order_count"))).toBe(true);
  });

  it("keeps prior analysisState after a restricted turn and still re-grounds on subsequent bare invokes", async () => {
    const searches: string[] = [];
    const seenContexts: unknown[] = [];
    const chunks = [
      { chunkId: "table:orders", docType: "table", table: "orders", tables: ["orders"],
        metricName: null, content: "Orders", score: 0.9, aliasMatched: true },
      { chunkId: "metric:net_revenue", docType: "metric", table: "orders", tables: ["orders"],
        metricName: "net_revenue", content: "Net revenue", score: 0.95, aliasMatched: true },
    ] as const;
    const proposals = [
      proposal({ isFollowUp: false, metric: "net_revenue", requestedMetrics: ["net_revenue"],
        schemaEntities: ["orders"], timeRange: "2026-09",
        filters: [{ field: "region", operator: "=", value: "Nam" }] }),
      proposal({ isFollowUp: false, topicChanged: false, metric: null, requestedMetrics: [], schemaEntities: ["orders"] }),
      proposal({ deltaOps: [{ op: "replace", field: "timeRange", value: "2026-Q2" }] }),
    ];
    let turn = 0;
    let exec = 0;
    const search = async (query: string) => { searches.push(query); return [...chunks] as never; };
    const graph = buildRootGraph({
      checkpointer: new MemorySaver(),
      retrieve: createRetrieveSemantic({ search }),
      synthesize: createAnswerSynthesizer({ model: null }),
      textToSql: {
        listTables: async () => [{ name: "orders", schema: "public" }],
        semanticSearch: search,
        intentModel: { withStructuredOutput: () => ({ invoke: async () => proposals[Math.min(turn++, proposals.length - 1)] }) } as never,
        executor: { run: async (input) => {
          exec += 1;
          seenContexts.push(input.analysisContext);
          if (exec === 2) {
            return {
              status: "restricted",
              error: { code: "SENSITIVE_COLUMN_DENIED", message: "Denied", retryable: false, repairable: false },
              sql: null,
              attempts: 1,
            };
          }
          return {
            status: "ok", sql: "SELECT 1 AS n FROM public.orders",
            tablesUsed: ["orders"], columns: ["n"], rows: [{ n: 7 }],
            maskedColumns: [], attempts: 1,
          };
        } },
      },
    });
    const config = { configurable: {
      thread_id: "restricted-carry-128", threadId: "restricted-carry-128", runId: "run-rc", userId: "u-128",
      roleScope: "sales_south", mcpUrl: "http://127.0.0.1:1/mcp", token: "tok",
    } };
    await graph.invoke({ question: "Doanh thu thuần tháng 9 miền Nam?", runId: "r1", threadId: "restricted-carry-128" }, config);
    await compactTurnCheckpoint(graph, config);

    const denied = await graph.invoke({ question: "Cho xem bảng đơn", runId: "r2", threadId: "restricted-carry-128" }, config);
    expect(denied.status).toBe("restricted");
    expect(denied.analysisState?.metric).toBe("net_revenue");
    await compactTurnCheckpoint(graph, config);

    const followUp = await graph.invoke({ question: "Còn quý trước thì sao?", runId: "r3", threadId: "restricted-carry-128" }, config);
    expect(followUp.status).toBe("ok");
    expect(followUp.turnHistory).toHaveLength(3);
    expect(seenContexts[2]).toMatchObject({ metric: "net_revenue", timeRange: "2026-Q2" });
    expect(searches.length).toBeGreaterThanOrEqual(3);
  });
});
