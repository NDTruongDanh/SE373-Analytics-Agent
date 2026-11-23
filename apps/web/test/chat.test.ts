import { describe, expect, it } from "vitest";
import { chatReducer, clarificationFrom, extractVizPayload, initialChat } from "../src/chat.js";
import type { SseProgressEvent } from "@shared/contracts";

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
});
