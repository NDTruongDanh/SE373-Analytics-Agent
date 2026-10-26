import { describe, expect, it } from "vitest";
import { DbToolErrorSchema, ErrorCodes, dbToolError } from "../src/errors.js";

describe("DbToolError", () => {
  it("parses a valid TIMEOUT error with retryable true", () => {
    const parsed = DbToolErrorSchema.parse({
      code: "TIMEOUT",
      message: "Query exceeded statement timeout",
      retryable: true,
    });
    expect(parsed.retryable).toBe(true);
  });

  it("dbToolError SCOPE_DENIED yields retryable false", () => {
    expect(dbToolError("SCOPE_DENIED", "Missing scope data:read")).toMatchObject({
      code: "SCOPE_DENIED",
      retryable: false,
    });
  });

  it("rejects an unknown code", () => {
    expect(() =>
      DbToolErrorSchema.parse({ code: "NOPE", message: "x", retryable: false }),
    ).toThrow();
  });

  it("exposes exactly 11 error codes", () => {
    expect(ErrorCodes).toHaveLength(11);
  });
});
