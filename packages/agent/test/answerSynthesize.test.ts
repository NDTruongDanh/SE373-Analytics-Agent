// Generic answer seam (#104): never the tracer orders-by-status text for a
// non-status result; prefers UC-03 verified insights; keeps handler answers.
import { describe, expect, it } from "vitest";
import { ANSWER_PREVIEW_ROWS, synthesizeAnswer } from "../src/answer/synthesize.js";
import type { AgentState } from "../src/state.js";

function stateWith(overrides: Partial<AgentState>): AgentState {
  return {
    answerText: "",
    status: "ok",
    resultPreview: [],
    columns: [],
    vizSpec: null,
    ...overrides,
  } as unknown as AgentState;
}

const revenueRows = [
  { channel_name: "Shopee", net_revenue_vnd: 1250000.5 },
  { channel_name: "Lazada", net_revenue_vnd: "980000" },
];

describe("synthesizeAnswer", () => {
  it("formats the masked preview with real column names", () => {
    const out = synthesizeAnswer(
      stateWith({ resultPreview: revenueRows, columns: ["channel_name", "net_revenue_vnd"] }),
    );
    expect(out.status).toBe("ok");
    expect(out.answerText).toContain("Kết quả (2 dòng):");
    expect(out.answerText).toContain("- channel_name: Shopee, net_revenue_vnd: 1.250.000,5");
    expect(out.answerText).toContain("- channel_name: Lazada, net_revenue_vnd: 980.000");
    expect(out.answerText).not.toContain("status groups");
    expect(out.answerText).not.toContain("undefined");
  });

  it("caps the echoed rows", () => {
    const rows = Array.from({ length: ANSWER_PREVIEW_ROWS + 3 }, (_, i) => ({ n: i }));
    const out = synthesizeAnswer(stateWith({ resultPreview: rows, columns: ["n"] }));
    expect(out.answerText).toContain(`Kết quả (${ANSWER_PREVIEW_ROWS}/${rows.length} dòng đầu):`);
    expect(out.answerText?.match(/^- /gm)).toHaveLength(ANSWER_PREVIEW_ROWS);
  });

  it("prefers UC-03 verified insights over the raw preview", () => {
    const out = synthesizeAnswer(
      stateWith({
        resultPreview: revenueRows,
        columns: ["channel_name", "net_revenue_vnd"],
        vizSpec: {
          kind: "insight_report",
          report: { insights: [{ claim: "Shopee dẫn đầu doanh thu thuần.", evidence: [] }] },
        },
      }),
    );
    expect(out.answerText).toBe("- Shopee dẫn đầu doanh thu thuần.");
  });

  it("reports no_data on an empty preview", () => {
    const out = synthesizeAnswer(stateWith({ status: "ok", resultPreview: [] }));
    expect(out.status).toBe("no_data");
  });

  it("keeps handler-written answers and non-data statuses untouched", () => {
    expect(synthesizeAnswer(stateWith({ answerText: "already" }))).toEqual({});
    expect(synthesizeAnswer(stateWith({ status: "restricted" }))).toEqual({});
  });

  it("redacts PII-shaped values in the answer", () => {
    const out = synthesizeAnswer(
      stateWith({ resultPreview: [{ email: "lan.pham@example.com" }], columns: ["email"] }),
    );
    expect(out.answerText).not.toContain("lan.pham@example.com");
  });
});
