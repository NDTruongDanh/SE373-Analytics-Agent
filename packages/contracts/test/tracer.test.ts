import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  DbToolErrorSchema,
  dbToolError,
  ErrorCodes,
  REPAIRABLE_CODES,
  RETRYABLE_CODES,
  SchemaCatalogSchema,
  TraceEventSchema,
} from "../src/index.js";

// Tracer slice: additive contracts delta only (CONT-05 span fields, CONT-08
// catalog, SQL_EXECUTION_ERROR + repairable). Kept green through the 01-02
// 1.0.0 breaking release: version bumped, field renames applied.

describe("tracer contracts delta", () => {
  it("keeps CONTRACTS_VERSION at 1.0.0", () => {
    expect(CONTRACTS_VERSION).toBe("1.0.0");
  });

  it("inserts SQL_EXECUTION_ERROR after SENSITIVE_COLUMN_DENIED", () => {
    expect(ErrorCodes).toContain("SQL_EXECUTION_ERROR");
    expect(ErrorCodes.indexOf("SQL_EXECUTION_ERROR")).toBe(
      ErrorCodes.indexOf("SENSITIVE_COLUMN_DENIED") + 1,
    );
  });

  it("leaves RETRYABLE_CODES unchanged", () => {
    expect([...RETRYABLE_CODES].sort()).toEqual(
      ["INTERNAL_ERROR", "RATE_LIMITED", "TIMEOUT"].sort(),
    );
  });

  it("routes repairable from REPAIRABLE_CODES exactly like retryable", () => {
    expect([...REPAIRABLE_CODES].sort()).toEqual(
      ["INVALID_SQL", "SQL_EXECUTION_ERROR", "UNKNOWN_TABLE"].sort(),
    );
    for (const code of ErrorCodes) {
      const err = dbToolError(code, "tracer probe");
      expect(err.retryable).toBe(RETRYABLE_CODES.includes(code));
      expect(err.repairable).toBe(REPAIRABLE_CODES.includes(code));
      expect(DbToolErrorSchema.parse(err)).toEqual(err);
    }
  });

  it("treats runtime SQL errors as repairable but not retryable", () => {
    const err = dbToolError("SQL_EXECUTION_ERROR", "boom");
    expect(err.repairable).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it("supports optional cursorPosition", () => {
    const withCursor = dbToolError("INVALID_SQL", "bad", 7);
    expect(withCursor.cursorPosition).toBe(7);
    expect(DbToolErrorSchema.parse(withCursor).cursorPosition).toBe(7);
    const without = dbToolError("INVALID_SQL", "bad");
    expect(without.cursorPosition).toBeUndefined();
    expect(
      DbToolErrorSchema.parse({ code: "TIMEOUT", message: "t", retryable: true, repairable: false })
        .cursorPosition,
    ).toBeUndefined();
  });

  it("accepts CONT-05 span fields on trace events", () => {
    const base = {
      runId: "r1",
      threadId: "t1",
      userId: "u1",
      role: "sales_south",
      node: "run",
      type: "tool_call",
      ts: new Date().toISOString(),
      durationMs: 3,
    };
    expect(TraceEventSchema.parse(base).spanId).toBeUndefined();
    const withSpans = {
      ...base,
      spanId: "s1",
      parentSpanId: "s0",
      attempt: 1,
    };
    const parsed = TraceEventSchema.parse(withSpans);
    expect(parsed.spanId).toBe("s1");
    expect(parsed.parentSpanId).toBe("s0");
    expect(parsed.attempt).toBe(1);
  });

  it("parses the CONT-08 array-of-tables catalog shape", () => {
    const catalog = {
      tables: [
        {
          name: "customers",
          columns: [
            { name: "phone", type: "text", nullable: true, sensitive: true, large: false },
            { name: "id", type: "integer", nullable: false, sensitive: false, large: false },
          ],
        },
      ],
    };
    const parsed = SchemaCatalogSchema.parse(catalog);
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0].schema).toBe("public");
    expect(parsed.tables[0].columns[0].sensitive).toBe(true);
  });
});

describe("tracer redaction contract", () => {
  // Schema-level half of the task-4 canary: the contracts support the
  // redaction vocabulary (MASKED markers validate wherever strings do) and
  // cap error messages at 500 chars to bound leak surface. The sink-level
  // half (demo trace + audit scan) lives in mcp-server/test/tracer.test.ts.

  it("accepts MASKED markers in trace event payloads", () => {
    const event = {
      runId: "r1",
      threadId: "t1",
      userId: "u1",
      role: "sales_south",
      node: "run",
      type: "tool_call",
      ts: new Date().toISOString(),
      durationMs: 1,
      payload: { phone: "MASKED_PHONE", email: "MASKED_EMAIL" },
    };
    const parsed = TraceEventSchema.parse(event);
    expect(parsed.payload).toEqual({ phone: "MASKED_PHONE", email: "MASKED_EMAIL" });
  });

  it("caps error messages at 500 chars", () => {
    expect(() =>
      DbToolErrorSchema.parse({
        code: "TIMEOUT",
        message: "x".repeat(501),
        retryable: true,
        repairable: false,
      }),
    ).toThrow();
    const err = dbToolError("TIMEOUT", "x".repeat(500));
    expect(err.message).toHaveLength(500);
  });
});
