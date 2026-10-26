import { describe, expect, it } from "vitest";
import { SQLAnswerSchema } from "../src/answers.js";
import { BenchmarkRowSchema } from "../src/benchmark.js";
import { RunQueryOutputSchema } from "../src/tools.js";
import { TraceEventSchema } from "../src/trace.js";

const validAttempt = {
  attemptNo: 1,
  sql: "SELECT 1",
  schemaRefs: ["orders"],
  validation: "ok",
  durationMs: 12,
};

const validTelemetry = {
  promptTokens: 100,
  completionTokens: 50,
  estimatedCostUsd: 0.001,
  latencyMs: 200,
};

function validAnswer() {
  return {
    intent: {
      metric: "net_revenue",
      dimensions: [],
      filters: [],
      timeRange: null,
    },
    sql: "SELECT 1",
    tablesUsed: ["orders"],
    attempts: [validAttempt],
    resultPreview: [],
    answerText: "Revenue is 100.",
    status: "ok",
    telemetry: validTelemetry,
  };
}

describe("contract surface", () => {
  it("SQLAnswer rejects a fourth attempt", () => {
    expect(() =>
      SQLAnswerSchema.parse({
        ...validAnswer(),
        attempts: [validAttempt, validAttempt, validAttempt, validAttempt],
      }),
    ).toThrow();
  });

  it("SQLAnswer rejects a 51-row preview", () => {
    expect(() =>
      SQLAnswerSchema.parse({
        ...validAnswer(),
        resultPreview: Array.from({ length: 51 }, () => ({ a: 1 })),
      }),
    ).toThrow();
  });

  it("RunQueryOutput requires maskedColumns to be present-or-defaulted", () => {
    const parsed = RunQueryOutputSchema.parse({
      columns: ["a"],
      rows: [{ a: 1 }],
      rowCount: 1,
      truncated: false,
      durationMs: 5,
    });
    expect(parsed.maskedColumns).toEqual([]);
  });

  it("TraceEvent rejects an empty runId", () => {
    expect(() =>
      TraceEventSchema.parse({
        runId: "",
        threadId: "t1",
        userId: "u1",
        role: "sales_lead",
        node: "generate",
        type: "tool_call",
        ts: "2026-10-25T12:00:00Z",
        durationMs: 3,
      }),
    ).toThrow();
  });

  it("BenchmarkRow rejects an unknown difficulty", () => {
    expect(() =>
      BenchmarkRowSchema.parse({
        id: "q01",
        question: "Revenue?",
        difficulty: "expert",
        gold_sql: "SELECT 1",
        gold_result_path: "results/q01.json",
      }),
    ).toThrow();
  });
});
