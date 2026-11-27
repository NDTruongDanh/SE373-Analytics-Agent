import { describe, expect, it } from "vitest";
import {
  chatReducer,
  clarificationFrom,
  extractRootCausePayload,
  extractVizPayload,
  initialChat,
  planReviewFrom,
} from "../src/chat.js";
import type { AnalysisPlan, RootCauseAnswer, SseProgressEvent } from "@shared/contracts";

const event = (name: SseProgressEvent["event"], data: unknown, runId = "run-1", threadId = "thread-1"): SseProgressEvent =>
  ({ event: name, runId, threadId, data });

describe("chat state", () => {
  it("supports legacy and structured clarification payloads", () => {
    expect(clarificationFrom({ pendingClarification: ["A", "B"] })?.options).toEqual(["A", "B"]);
    expect(clarificationFrom({ pendingClarification: { question: "Chọn?", options: ["A", "B"] } })?.question).toBe("Chọn?");
    expect(clarificationFrom({ pendingClarification: ["A"] })).toBeNull();
    expect(clarificationFrom({ pendingClarification: ["A", "B", "C", "D", "E"] })).toBeNull();
  });

  it("keeps run and thread over clarification and resume", () => {
    let state = chatReducer(initialChat, { type: "start" });
    state = chatReducer(state, { type: "event", event: event("interrupt_waiting", { pendingClarification: ["A", "B"] }) });
    expect(state.phase).toBe("waiting");
    state = chatReducer(state, { type: "resume" });
    state = chatReducer(state, { type: "event", event: event("completed", { answerText: "Done" }) });
    expect(state).toMatchObject({ runId: "run-1", threadId: "thread-1", phase: "completed", answer: "Done" });
  });

  it("fails closed on mismatched identity and malformed options", () => {
    let state = chatReducer(initialChat, { type: "event", event: event("intent_parsed", {}) });
    state = chatReducer(state, { type: "event", event: event("completed", {}, "another") });
    expect(state.phase).toBe("failed");
    expect(chatReducer(initialChat, { type: "event", event: event("interrupt_waiting", {}) }).phase).toBe("failed");
  });

  it("accepts result detail only when it validates as SQLAnswer", () => {
    const answer = { intent: { metric: null, dimensions: [], filters: [], timeRange: null }, sql: "SELECT 1", tablesUsed: [], citations: [], attempts: [], resultPreview: [], answerText: "Done", status: "ok", telemetry: { promptTokens: 0, completionTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0, latencyMs: 0 } };
    expect(chatReducer(initialChat, { type: "event", event: event("completed", { answer }) }).answerDetail?.sql).toBe("SELECT 1");
    expect(chatReducer(initialChat, { type: "event", event: event("completed", { answer: { ...answer, resultPreview: new Array(51).fill({}) } }) }).answerDetail).toBeNull();
  });

  it("captures streaming viz payloads and preserves them through completion", () => {
    const report = {
      chartType: "bar" as const,
      chartSpec: {
        chart: "BarChart" as const,
        labels: ["Nam", "Bac"],
        series: [{ category: "revenue", values: [5200, 2800] }],
      },
      chartReason: "Comparing two regions.",
      insights: [
        {
          claim: "Nam dẫn đầu với 5,200.",
          evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
        },
      ],
      caveats: [],
    };
    const lang = [
      "root = Card([title, chart])",
      'title = TextContent("Doanh thu", "large-heavy")',
      'chart = BarChart(labels, [s1], "grouped")',
      'labels = ["Nam","Bac"]',
      's1 = Series("revenue", [5200,2800])',
    ].join("\n");
    const answer = {
      intent: { metric: "revenue", dimensions: ["region"], filters: [], timeRange: null },
      sql: "SELECT region, revenue FROM t",
      tablesUsed: ["orders"],
      citations: ["metric:net_revenue"],
      attempts: [],
      resultPreview: [
        { region: "Nam", revenue: 5200 },
        { region: "Bac", revenue: 2800 },
      ],
      answerText: "Doanh thu miền Nam đạt 5,200.",
      status: "ok" as const,
      telemetry: { promptTokens: 1, completionTokens: 1, embeddingTokens: 0, estimatedCostUsd: 0, latencyMs: 10 },
    };

    let state = chatReducer(initialChat, { type: "start" });
    state = chatReducer(state, {
      type: "event",
      event: event("viz", { title: "Doanh thu", report, openuiLang: lang, truncated: true }),
    });
    expect(state.phase).toBe("streaming");
    expect(state.viz?.openuiLang).toBe(lang);
    expect(state.viz?.truncated).toBe(true);

    state = chatReducer(state, {
      type: "event",
      event: event("completed", { answer }),
    });
    expect(state.phase).toBe("completed");
    expect(state.viz?.report.chartType).toBe("bar");
    expect(state.viz?.resultPreview).toEqual(answer.resultPreview);

    expect(extractVizPayload({ kind: "insight_report", data: report, openuiLang: lang })?.report.chartType).toBe("bar");
    expect(extractVizPayload({ answerText: "plain" })).toBeNull();
  });

  it("extracts UC-05 review_analysis_plan interrupts, handles 409 conflicts, and extracts RootCauseAnswer on completion", () => {
    const plan: AnalysisPlan = {
      question: "Vì sao doanh thu tháng 9/2026 giảm so với tháng 8/2026?",
      metricName: "net_revenue",
      metricType: "additive",
      direction: "decrease",
      currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
      baselineVal: 2_500_000_000,
      currentVal: 2_040_000_000,
      absDelta: -460_000_000,
      pctDelta: -18.4,
      isValidBaseline: true,
      steps: [
        {
          stepId: "step_region_central",
          axis: "dimension",
          dimensionOrFactor: "region",
          dimensionValue: "Miền Trung",
          dimensionPath: ["Miền Trung"],
          parentId: null,
          depth: 0,
          status: "todo",
          delta: 0,
          contributionPct: 0,
          sql: null,
          retryCount: 0,
        },
      ],
      totalQueriesCount: 2,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      unexploredBranches: [],
      residualOtherAbs: 0,
    };

    const review = planReviewFrom({
      action: "review_analysis_plan",
      currentPlan: plan,
      asOf: "2026-10-01T07:00:00Z",
      checkpointId: "ckpt-123",
    });
    expect(review?.plan.metricName).toBe("net_revenue");
    expect(review?.asOf).toBe("2026-10-01T07:00:00Z");
    expect(review?.checkpointId).toBe("ckpt-123");
    expect(planReviewFrom({ action: "clarify_then_query", plan })).toBeNull();

    let state = chatReducer(initialChat, { type: "start" });
    state = chatReducer(state, {
      type: "event",
      event: {
        ...event("interrupt_waiting", {
          action: "review_analysis_plan",
          currentPlan: plan,
          asOf: "2026-10-01T07:00:00Z",
        }),
        checkpointId: "ckpt-123",
      },
    });
    expect(state.phase).toBe("waiting");
    expect(state.checkpointId).toBe("ckpt-123");
    expect(state.planReview?.checkpointId).toBe("ckpt-123");

    state = chatReducer(state, { type: "resume" });
    state = chatReducer(state, {
      type: "conflict",
      message: "Checkpoint đã cũ (409 Conflict).",
    });
    expect(state.phase).toBe("waiting");
    expect(state.conflictError).toContain("409");
    expect(state.planReview?.plan.steps).toHaveLength(1);

    const rootCauseAnswer: RootCauseAnswer = {
      question: plan.question,
      metricName: "net_revenue",
      metricType: "additive",
      currentPeriod: plan.currentPeriod,
      baselinePeriod: plan.baselinePeriod,
      baselineVal: 2_500_000_000,
      currentVal: 2_040_000_000,
      absDelta: -460_000_000,
      pctDelta: -18.4,
      mathVerified: true,
      mathDiffRatio: 0.012,
      primaryCauses: [
        {
          stepId: "step_cat_gia_dung",
          axis: "dimension",
          dimensionOrFactor: "category",
          dimensionValue: "Đồ gia dụng",
          dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
          delta: -395_000_000,
          contributionPct: 85.87,
          sql: "SELECT SUM(i.price_vnd) FROM orders o JOIN order_items i USING (order_id)",
        },
      ],
      residualOtherAbs: 65_000_000,
      unexploredBranches: [],
      totalQueriesCount: 8,
      finalReportMarkdown: "## 1. Hiện tượng\nDoanh thu giảm 18.4%.",
    };

    state = chatReducer(state, { type: "resume" });
    state = chatReducer(state, {
      type: "event",
      event: event("completed", {
        status: "ok",
        rootCauseAnswer,
        analysisPlan: { ...plan, steps: [{ ...plan.steps[0]!, status: "done", delta: -395_000_000, contributionPct: 85.87 }] },
      }),
    });
    expect(state.phase).toBe("completed");
    expect(state.planReview).toBeNull();
    expect(state.rootCause?.answer?.mathVerified).toBe(true);
    expect(state.rootCause?.steps[0]?.status).toBe("done");

    const falsePremiseState = extractRootCausePayload({
      status: "false_premise",
      answerText: "Tiền đề không chính xác: doanh thu thực tế tăng 12%.",
      baselineVal: 2_000_000_000,
      currentVal: 2_240_000_000,
      absDelta: 240_000_000,
      pctDelta: 12.0,
    });
    expect(falsePremiseState?.falsePremise).toBe(true);
    expect(falsePremiseState?.status).toBe("false_premise");
  });
});
