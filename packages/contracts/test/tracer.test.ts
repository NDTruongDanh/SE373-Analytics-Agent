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
// catalog, SQL_EXECUTION_ERROR + repairable). CONTRACTS_VERSION stays 0.1.0;
// the 1.0.0 breaking release (camelCase renames, semantic/benchmark deltas)
// lands in 01-02.

describe("tracer contracts delta", () => {
  it("keeps CONTRACTS_VERSION at 0.1.0", () => {
    expect(CONTRACTS_VERSION).toBe("0.1.0");
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
