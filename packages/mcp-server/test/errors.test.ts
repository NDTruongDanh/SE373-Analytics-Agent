// sanitizeError permanent matrix (POL-05, T-01-06-04): every PG SQLSTATE
// row, retryable/repairable flags, cursor position, infra stripping, the
// 500-char cap, and shared-redactor composition on echoed literals.
// DB-free: sanitizeError takes plain driver-shaped objects.
import { describe, expect, it } from "vitest";
import { sanitizeError } from "../src/errors.js";

function driverError(fields: Record<string, unknown>): unknown {
  return { ...fields };
}

describe("sanitizeError SQLSTATE matrix", () => {
  it("maps 57014 to TIMEOUT (retryable, not repairable)", () => {
    const err = sanitizeError(
      driverError({ code: "57014", message: "canceling statement due to statement timeout" }),
    );
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
    expect(err.repairable).toBe(false);
  });

  it("maps 42601 to INVALID_SQL (repairable) with the cursor position", () => {
    const err = sanitizeError(
      driverError({ code: "42601", message: 'syntax error at or near "FROM"', position: "27" }),
    );
    expect(err.code).toBe("INVALID_SQL");
    expect(err.retryable).toBe(false);
    expect(err.repairable).toBe(true);
    expect(err.cursorPosition).toBe(27);
  });

  it.each(["42P01", "42703", "3D000", "3F000"])(
    "maps %s to UNKNOWN_TABLE (repairable)",
    (code) => {
      const err = sanitizeError(driverError({ code, message: "missing catalog entry" }));
      expect(err.code).toBe("UNKNOWN_TABLE");
      expect(err.retryable).toBe(false);
      expect(err.repairable).toBe(true);
    },
  );

  it.each(["25006", "42501"])(
    "maps %s to FORBIDDEN_STATEMENT (hard abort)",
    (code) => {
      const err = sanitizeError(driverError({ code, message: "not permitted" }));
      expect(err.code).toBe("FORBIDDEN_STATEMENT");
      expect(err.retryable).toBe(false);
      expect(err.repairable).toBe(false);
    },
  );

  it.each(["22012", "22P02", "22008"])(
    "maps class-22 %s to SQL_EXECUTION_ERROR (repairable)",
    (code) => {
      const err = sanitizeError(driverError({ code, message: "data exception" }));
      expect(err.code).toBe("SQL_EXECUTION_ERROR");
      expect(err.retryable).toBe(false);
      expect(err.repairable).toBe(true);
    },
  );

  it("maps residual class-42 semantic errors to SQL_EXECUTION_ERROR", () => {
    const err = sanitizeError(
      driverError({ code: "42803", message: "column must appear in GROUP BY" }),
    );
    expect(err.code).toBe("SQL_EXECUTION_ERROR");
    expect(err.repairable).toBe(true);
  });

  it.each(["08006", "53300"])(
    "maps %s to INTERNAL_ERROR (retryable)",
    (code) => {
      const err = sanitizeError(driverError({ code, message: "connection failure" }));
      expect(err.code).toBe("INTERNAL_ERROR");
      expect(err.retryable).toBe(true);
      expect(err.repairable).toBe(false);
    },
  );

  it("falls back to INTERNAL_ERROR for unknown codes and codeless errors", () => {
    expect(sanitizeError(driverError({ code: "XX000", message: "weird" })).code).toBe(
      "INTERNAL_ERROR",
    );
    expect(sanitizeError(new Error("plain failure")).code).toBe("INTERNAL_ERROR");
  });

  it("omits cursorPosition for non-syntax errors", () => {
    const err = sanitizeError(
      driverError({ code: "42P01", message: "no table", position: "5" }),
    );
    expect(err.cursorPosition).toBeUndefined();
  });
});

describe("sanitizeError redaction", () => {
  it("strips DSN credentials, hosts, user names and IPv4 literals", () => {
    const err = sanitizeError(
      driverError({
        code: "08006",
        message:
          'connection to server at "127.0.0.1" failed for user "agent_ro" with postgres://agent_ro:secret@db:5432/chosen',
      }),
    );
    expect(err.message).not.toContain("secret");
    expect(err.message).not.toContain("127.0.0.1");
    expect(err.message).not.toContain('user "agent_ro"');
    expect(err.message).toContain("postgres://<redacted>");
  });

  it("strips filesystem paths from detail and hint but keeps SQL division in the message", () => {
    const err = sanitizeError(
      driverError({
        code: "22012",
        message: "SELECT total/2 FROM orders",
        detail: "failing row in /var/lib/data/rows.csv",
        hint: "see /etc/postgres/conf.d/x.conf",
      }),
    );
    expect(err.message).toContain("total/2");
    expect(err.message).not.toContain("/var/lib/data/rows.csv");
    expect(err.message).not.toContain("/etc/postgres/conf.d/x.conf");
  });

  it("strips stack-frame lines", () => {
    const err = sanitizeError(
      driverError({
        code: "XX000",
        message: "boom\n    at query (/app/node_modules/pg/lib/client.js:123:45)",
      }),
    );
    expect(err.message).not.toContain("at query");
    expect(err.message).toContain("boom");
  });

  it("masks echoed phone and email literals via the shared redactor", () => {
    const err = sanitizeError(
      driverError({
        code: "22P02",
        message: 'invalid input syntax for phone: "0901234567"',
        detail: "contact an.nguyen@example.vn for help",
      }),
    );
    expect(err.message).not.toContain("0901234567");
    expect(err.message).not.toContain("an.nguyen@example.vn");
    expect(err.message).toContain("[MASKED_PHONE]");
    expect(err.message).toContain("[MASKED_EMAIL]");
  });

  it("caps the composed message at 500 chars", () => {
    const err = sanitizeError(
      driverError({ code: "XX000", message: `x${"y".repeat(2000)}` }),
    );
    expect(err.message.length).toBeLessThanOrEqual(500);
  });

  it("never returns an empty message", () => {
    const err = sanitizeError(driverError({ code: "XX000", message: "" }));
    expect(err.message.length).toBeGreaterThan(0);
  });
});
