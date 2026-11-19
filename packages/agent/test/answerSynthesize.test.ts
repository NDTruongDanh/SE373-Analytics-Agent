import { describe, expect, it } from "vitest";
import {
  ANSWER_PREVIEW_ROWS,
  createAnswerSynthesizer,
  synthesizeAnswer,
} from "../src/answer/synthesize.js";
import type { AgentState, RootRuntime, SpanEvent } from "../src/state.js";

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    question: "q",
    ucId: "text-to-sql",
    intent: {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
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
    status: "ok",
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
  };
}

describe("synthesizeAnswer & createAnswerSynthesizer", () => {
  it("preserves non-empty upstream answerText while redacting phone/email PII", () => {
    const clean = synthesizeAnswer(baseState({ answerText: "4 status groups, 10 orders" }));
    expect(clean).toEqual({});

    const leaky = synthesizeAnswer(
      baseState({ answerText: "Liên hệ 0901234567 hoặc user@example.vn" }),
    );
    expect(leaky.answerText).toBe("Liên hệ [MASKED_PHONE] hoặc [MASKED_EMAIL]");
  });

  it("synthesizes from verified UC-03 insight claims and caveats when present", () => {
    const out = synthesizeAnswer(
      baseState({
        vizSpec: {
          kind: "insight_report",
          report: {
            insights: [
              { claim: "Website dẫn đầu với 5000000 VND.", evidence: [] },
              { claim: "Liên hệ CSKH: +84 912 345 678", evidence: [] },
            ],
            caveats: ["Giới hạn 50 dòng"],
          },
        },
      }),
    );
    expect(out.answerText).toContain("Website dẫn đầu với 5000000 VND.");
    expect(out.answerText).toContain("[MASKED_PHONE]");
    expect(out.answerText).toContain("(Giới hạn 50 dòng)");
  });

  it("renders single scalar cell concisely and truncates multi-row previews at ANSWER_PREVIEW_ROWS", () => {
    const scalar = synthesizeAnswer(baseState({ resultPreview: [{ total: 123 }] }));
    expect(scalar.answerText).toBe("total: 123");
    expect(synthesizeAnswer(baseState({ resultPreview: [{ total: 12345 }] })).answerText).toBe("total: 12.345");
    expect(synthesizeAnswer(baseState({ status: "no_data" })).answerText).toBe("Không có dữ liệu phù hợp với câu hỏi.");

    const rows = Array.from({ length: ANSWER_PREVIEW_ROWS + 3 }, (_, i) => ({
      id: i + 1,
      phone: "0901234567",
    }));
    const multi = synthesizeAnswer(
      baseState({ resultPreview: rows, tablesUsed: ["customers"] }),
    );
    expect(multi.answerText).toContain(`Returned ${ANSWER_PREVIEW_ROWS + 3} rows from customers`);
    expect(multi.answerText).toContain("; ...");
    expect(multi.answerText).toContain("[MASKED_PHONE]");
    expect(multi.answerText).not.toContain("0901234567");
  });

  it("provides status fallbacks and skips duplicate answer span on default tracer route", async () => {
    expect(
      synthesizeAnswer(baseState({ status: "restricted", answerText: "" })).answerText,
    ).toMatch(/restricted/i);
    expect(
      synthesizeAnswer(baseState({ status: "error", answerText: "" })).answerText,
    ).toMatch(/error/i);

    const emitted: SpanEvent[] = [];
    const rt = {
      emit: (e: SpanEvent) => {
        emitted.push(e);
        return "s-1";
      },
      config: {},
    } as unknown as RootRuntime;
    const synth = createAnswerSynthesizer();

    await synth(baseState({ ucId: "tracer", answerText: "already set" }), rt);
    expect(emitted).toHaveLength(0);

    await synth(baseState({ ucId: "text-to-sql", resultPreview: [{ n: 9 }] }), rt);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ node: "answer", type: "node_done" });
  });
});
