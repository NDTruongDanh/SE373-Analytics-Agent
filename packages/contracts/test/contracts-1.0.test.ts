import { describe, expect, it } from "vitest";
import {
  AgentResponseSchema,
  BenchmarkRowSchema,
  CONTRACTS_VERSION,
  DbToolErrorSchema,
  ErrorCodes,
  REPAIRABLE_CODES,
  RETRYABLE_CODES,
  RenderChartInputSchema,
  SchemaCatalogSchema,
  SearchSemanticLayerInputSchema,
  SearchSemanticLayerOutputSchema,
  SemanticChunkMetadataSchema,
  SendAlertInputSchema,
  SQLAnswerSchema,
  SQLAnswerStatusSchema,
  SseProgressEventSchema,
  SSE_EVENT_NAMES,
  dbToolError,
} from "../src/index.js";

// Contracts 1.0.0 acceptance matrix (CONT-01..09): every code with both
// flags computed, camelCase-only shapes, the AgentResponse discriminator
// with all five variants, and the per-event SSE schemas.

const RETRYABLE_EXPECTED = ["TIMEOUT", "RATE_LIMITED", "INTERNAL_ERROR"];
const REPAIRABLE_EXPECTED = ["INVALID_SQL", "UNKNOWN_TABLE", "SQL_EXECUTION_ERROR"];

function validAnswer(status = "ok") {
  return {
    intent: {
      metric: "net_revenue",
      dimensions: [],
      filters: [],
      timeRange: null,
    },
    sql: "SELECT 1",
    tablesUsed: ["orders"],
    attempts: [
      {
        attemptNo: 1,
        sql: "SELECT 1",
        schemaRefs: ["orders"],
        validation: "ok",
        durationMs: 12,
      },
    ],
    resultPreview: [],
    answerText: "Revenue is 100.",
    status,
    telemetry: {
      promptTokens: 100,
      completionTokens: 50,
      estimatedCostUsd: 0.001,
      latencyMs: 200,
    },
  };
}

describe("contracts 1.0.0", () => {
  it("freezes CONTRACTS_VERSION at 1.0.0 with 12 codes", () => {
    expect(CONTRACTS_VERSION).toBe("1.0.0");
    expect(ErrorCodes).toHaveLength(12);
    expect(ErrorCodes).toContain("SQL_EXECUTION_ERROR");
  });

  it("computes retryable and repairable for every code", () => {
    expect([...RETRYABLE_CODES].sort()).toEqual([...RETRYABLE_EXPECTED].sort());
    expect([...REPAIRABLE_CODES].sort()).toEqual([...REPAIRABLE_EXPECTED].sort());
    for (const code of ErrorCodes) {
      const err = dbToolError(code, "probe");
      expect(err.retryable).toBe(RETRYABLE_EXPECTED.includes(code));
      expect(err.repairable).toBe(REPAIRABLE_EXPECTED.includes(code));
      expect(DbToolErrorSchema.parse(err)).toEqual(err);
    }
  });

  it("treats SQL_EXECUTION_ERROR as repairable but not retryable", () => {
    const err = dbToolError("SQL_EXECUTION_ERROR", "division by zero");
    expect(err).toMatchObject({ retryable: false, repairable: true });
  });

  it("rejects unknown codes and malformed errors", () => {
    expect(() =>
      DbToolErrorSchema.parse({ code: "NOPE", message: "x", retryable: false, repairable: false }),
    ).toThrow();
    expect(() =>
      DbToolErrorSchema.parse({ code: "TIMEOUT", message: "x", retryable: true }),
    ).toThrow();
    expect(() =>
      DbToolErrorSchema.parse({ code: "TIMEOUT", message: "x".repeat(501), retryable: true, repairable: false }),
    ).toThrow();
  });

  it("keeps cursorPosition optional and non-negative-integer", () => {
    expect(dbToolError("INVALID_SQL", "bad", 7).cursorPosition).toBe(7);
    expect(dbToolError("INVALID_SQL", "bad").cursorPosition).toBeUndefined();
    expect(() =>
      DbToolErrorSchema.parse({ code: "INVALID_SQL", message: "bad", retryable: false, repairable: true, cursorPosition: -1 }),
    ).toThrow();
    expect(() =>
      DbToolErrorSchema.parse({ code: "INVALID_SQL", message: "bad", retryable: false, repairable: true, cursorPosition: 1.5 }),
    ).toThrow();
  });

  it("accepts camelCase semantic metadata and rejects legacy keys", () => {
    const parsed = SemanticChunkMetadataSchema.parse({
      chunkId: "metric:net_revenue",
      docType: "metric",
      table: "orders",
      tables: ["orders"],
      metricName: "net_revenue",
      sensitivity: "public",
      updatedAt: "2026-10-26T00:00:00Z",
    });
    expect(parsed.chunkId).toBe("metric:net_revenue");
    expect(parsed.updatedAt).toBe("2026-10-26T00:00:00Z");
    expect(() =>
      SemanticChunkMetadataSchema.parse({
        chunk_id: "metric:net_revenue",
        doc_type: "metric",
        table: "orders",
        tables: ["orders"],
        metric_name: "net_revenue",
        sensitivity: "public",
        updated_at: "2026-10-26T00:00:00Z",
      }),
    ).toThrow();
  });

  it("accepts camelCase benchmark rows with ordered and rejects legacy keys", () => {
    const parsed = BenchmarkRowSchema.parse({
      id: "q01",
      question: "Revenue?",
      difficulty: "easy",
      goldSql: "SELECT 1",
      goldResultPath: "results/q01.json",
      ordered: true,
    });
    expect(parsed.ordered).toBe(true);
    expect(BenchmarkRowSchema.parse({ ...parsed, ordered: undefined }).ordered).toBeUndefined();
    expect(() =>
      BenchmarkRowSchema.parse({
        id: "q01",
        question: "Revenue?",
        difficulty: "easy",
        gold_sql: "SELECT 1",
        gold_result_path: "results/q01.json",
      }),
    ).toThrow();
  });

  it("widens SQLAnswerStatus with needs_clarification and restricted", () => {
    for (const status of ["ok", "no_data", "cannot_answer", "needs_clarification", "restricted", "error"]) {
      expect(SQLAnswerStatusSchema.parse(status)).toBe(status);
      expect(SQLAnswerSchema.parse(validAnswer(status)).status).toBe(status);
    }
  });

  it("discriminates all five AgentResponse variants", () => {
    expect(AgentResponseSchema.parse({ kind: "sql_answer", ...validAnswer() }).kind).toBe("sql_answer");
    for (const kind of ["insight_report", "analysis_plan", "root_cause", "anomaly_alert"]) {
      const parsed = AgentResponseSchema.parse({ kind, status: "ok", summary: "Noted.", data: { n: 1 } });
      expect(parsed.kind).toBe(kind);
    }
    expect(() => AgentResponseSchema.parse({ kind: "nope", status: "ok", summary: "x", data: null })).toThrow();
    expect(() => AgentResponseSchema.parse({ kind: "insight_report", status: "ok", data: null })).toThrow();
    expect(() => AgentResponseSchema.parse({ kind: "sql_answer", ...validAnswer("bogus") })).toThrow();
  });

  it("validates every SSE progress event against its schema", () => {
    expect([...SSE_EVENT_NAMES].sort()).toEqual(
      ["completed", "failed", "intent_parsed", "interrupt_waiting", "query_running", "schema_retrieved", "sql_generated", "sql_repaired", "viz"].sort(),
    );
    for (const event of SSE_EVENT_NAMES) {
      const parsed = SseProgressEventSchema.parse({ event, runId: "r1", threadId: "t1" });
      expect(parsed.event).toBe(event);
    }
    expect(() =>
      SseProgressEventSchema.parse({ event: "started", runId: "r1", threadId: "t1" }),
    ).toThrow();
    expect(() =>
      SseProgressEventSchema.parse({ event: "completed", threadId: "t1" }),
    ).toThrow();
  });

  it("parses the catalog with sensitive and large flags", () => {
    const parsed = SchemaCatalogSchema.parse({
      tables: [
        {
          name: "orders",
          columns: [
            { name: "id", type: "integer", nullable: false, sensitive: false, large: true },
            { name: "phone", type: "text", nullable: true, sensitive: true, large: false },
          ],
        },
      ],
    });
    expect(parsed.tables[0].columns[1]).toMatchObject({ sensitive: true, large: false });
  });

  it("bounds the additive search, render, and alert surfaces", () => {
    expect(SearchSemanticLayerInputSchema.parse({ query: "revenue" }).topK).toBe(5);
    expect(() => SearchSemanticLayerInputSchema.parse({ query: "" })).toThrow();
    expect(() => SearchSemanticLayerInputSchema.parse({ query: "x", topK: 21 })).toThrow();
    const chunk = {
      chunkId: "metric:net_revenue",
      docType: "metric",
      table: "orders",
      tables: ["orders"],
      metricName: "net_revenue",
      content: "Net revenue definition",
      score: 0.9,
    };
    expect(SearchSemanticLayerOutputSchema.parse({ chunks: [chunk] }).chunks).toHaveLength(1);
    expect(RenderChartInputSchema.parse({ chartType: "bar", spec: { x: "status" } }).chartType).toBe("bar");
    expect(() => RenderChartInputSchema.parse({ chartType: "3d", spec: {} })).toThrow();
    const alert = {
      recipientId: "u1",
      severity: "critical",
      metric: "net_revenue",
      currentValue: 10,
      expectedValue: 100,
      deviation: "z=-3.1",
      drilldownSegment: "2026-09-14|Da Nang",
      evidenceSql: "SELECT 1",
      message: "Drop detected",
    };
    expect(SendAlertInputSchema.parse(alert).severity).toBe("critical");
    expect(() => SendAlertInputSchema.parse({ ...alert, severity: "urgent" })).toThrow();
  });
});
