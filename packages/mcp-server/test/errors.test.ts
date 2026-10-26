import { describe, expect, it } from "vitest";
import {
  DbToolErrorSchema,
  type ErrorCode,
} from "@se373/contracts";
import { sanitizeError } from "../src/errors.js";

describe("sanitizeError PG-code map", () => {
  const cases: { code: string | undefined; expected: ErrorCode }[] = [
    { code: "57014", expected: "TIMEOUT" },
    { code: "42601", expected: "INVALID_SQL" },
    { code: "42P01", expected: "UNKNOWN_TABLE" },
    { code: "42703", expected: "UNKNOWN_TABLE" },
    { code: "3D000", expected: "UNKNOWN_TABLE" },
    { code: "3F000", expected: "UNKNOWN_TABLE" },
    { code: "25006", expected: "FORBIDDEN_STATEMENT" },
    { code: "42501", expected: "FORBIDDEN_STATEMENT" },
    { code: "40001", expected: "INTERNAL_ERROR" },
    { code: "40P01", expected: "INTERNAL_ERROR" },
    { code: "08006", expected: "INTERNAL_ERROR" },
    { code: "53300", expected: "INTERNAL_ERROR" },
    { code: "28P01", expected: "INTERNAL_ERROR" },
    { code: "XX000", expected: "INTERNAL_ERROR" },
    { code: undefined, expected: "INTERNAL_ERROR" },
  ];

  for (const { code, expected } of cases) {
    it(`maps ${code ?? "<no code>"} to ${expected}`, () => {
      const err =
        code === undefined
          ? new Error("plain failure")
          : Object.assign(new Error("driver failure"), { code });
      const result = sanitizeError(err);
      expect(result.code).toBe(expected);
      expect(() => DbToolErrorSchema.parse(result)).not.toThrow();
    });
  }
});

describe("sanitizeError retryable flags", () => {
  it.each([
    { code: "57014", retryable: true },
    { code: "42601", retryable: false },
    { code: "42P01", retryable: false },
    { code: "25006", retryable: false },
    { code: "42501", retryable: false },
    { code: "XX000", retryable: true },
  ])("code $code yields retryable $retryable", ({ code, retryable }) => {
    const result = sanitizeError(
      Object.assign(new Error("x"), { code }),
    );
    expect(result.retryable).toBe(retryable);
  });
});

describe("sanitizeError redaction", () => {
  it("drops every credential, host, path, and stack fragment from the canary DSN case", () => {
    const err = Object.assign(
      new Error(
        'connection failed: postgres://evil:secret@db.internal:5432/x unreachable at 127.0.0.1, division like 10/2 stays',
      ),
      {
        code: "08006",
        detail: 'data directory "/var/lib/postgresql/data" missing',
        hint: "check host=db.internal port 5432",
        stack:
          'Error: boom\n    at Object.connect (/app/node_modules/pg/lib/client.js:10:20)',
      },
    );
    const result = sanitizeError(err);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toContain("evil");
    expect(result.message).not.toContain("secret");
    expect(result.message).not.toContain("db.internal");
    expect(result.message).not.toContain("127.0.0.1");
    expect(result.message).not.toContain("/var/lib");
    expect(result.message).not.toContain("at Object");
    expect(result.message).not.toContain("client.js");
    // SQL division in message is not path-redacted.
    expect(result.message).toContain("10/2");
    expect(() => DbToolErrorSchema.parse(result)).not.toThrow();
  });

  it("never echoes which credential failed", () => {
    const result = sanitizeError(
      Object.assign(new Error('password authentication failed for user "agent_ro"'), {
        code: "28P01",
      }),
    );
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toContain("agent_ro");
  });
});

describe("sanitizeError message cap", () => {
  it("caps a 1000-char message at 500 chars and still parses", () => {
    const result = sanitizeError(
      Object.assign(new Error("x".repeat(1000)), { code: "XX000" }),
    );
    expect(result.message.length).toBeLessThanOrEqual(500);
    expect(result.message.length).toBeGreaterThan(0);
    expect(() => DbToolErrorSchema.parse(result)).not.toThrow();
  });

  it("falls back to a non-empty message for empty input", () => {
    expect(sanitizeError(undefined).message.length).toBeGreaterThan(0);
    expect(sanitizeError(null).message.length).toBeGreaterThan(0);
    expect(sanitizeError("").message.length).toBeGreaterThan(0);
    expect(sanitizeError({}).message.length).toBeGreaterThan(0);
  });
});
