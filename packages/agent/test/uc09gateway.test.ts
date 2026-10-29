// Gateway record plus grading unit suite (issue #39, D-01). DB-free:
// exercises only the pure helpers in evals/gateway.ts — no gateway, no
// model, no disk.
import { describe, expect, it } from "vitest";
import {
  assertNoSecretsInMessage,
  gradeAuditLines,
  gradeGatewayCase,
  validateGatewayRecord,
  type GatewayCase,
  type GatewayObserved,
} from "../../../evals/gateway.js";

function goodCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uc09-probe",
    group: "valid",
    tool: "describe_table",
    params: { table: "customers" },
    auth: { role: "sales_south" },
    expect: { ok: true, outputSchemaValid: true },
    notes: "UC09.md B.1 Hop-le probe",
    ...overrides,
  };
}

function goodObserved(
  overrides: Partial<GatewayObserved> = {},
): GatewayObserved {
  return {
    ok: true,
    httpStatus: 200,
    data: {
      table: "customers",
      columns: [
        {
          name: "customer_id",
          type: "text",
          nullable: false,
          sensitive: false,
        },
      ],
      primaryKey: ["customer_id"],
      foreignKeys: [],
    },
    ...overrides,
  };
}

describe("validateGatewayRecord", () => {
  it("accepts a well-formed case", () => {
    const checked = validateGatewayRecord(goodCase());
    expect(checked.ok).toBe(true);
    expect(checked.value?.id).toBe("uc09-probe");
  });

  it("rejects an unknown expect key", () => {
    const checked = validateGatewayRecord(
      goodCase({ expect: { ok: true, errorcode: "TIMEOUT" } }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/unknown expect key/);
  });

  it("rejects an unknown top-level key", () => {
    const checked = validateGatewayRecord(
      goodCase({ mode: "mcp" }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/unknown top-level key/);
  });

  it("rejects a tool outside the db-tools set", () => {
    const checked = validateGatewayRecord(goodCase({ tool: "drop_table" }));
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/tool must be one of/);
  });

  it("rejects auth carrying both role and token", () => {
    const checked = validateGatewayRecord(
      goodCase({ auth: { role: "sales_south", token: "invalid" } }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/exactly one of/);
  });

  it("rejects an unknown token kind", () => {
    const checked = validateGatewayRecord(
      goodCase({ auth: { token: "expired" } }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/auth\.token/);
  });

  it("rejects an errorCode outside the frozen 12", () => {
    const checked = validateGatewayRecord(
      goodCase({ expect: { errorCode: "RATE_LIMIT_EXCEEDED" } }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/expect\.errorCode/);
  });

  it("rejects an empty expect", () => {
    const checked = validateGatewayRecord(goodCase({ expect: {} }));
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/at least one key/);
  });

  it("rejects notes that do not cite a B.1 row", () => {
    const checked = validateGatewayRecord(goodCase({ notes: "  " }));
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/notes/);
  });

  it("accepts the Task-3 legs: driver, timeoutMs, tags", () => {
    const checked = validateGatewayRecord(
      goodCase({ driver: "http401", timeoutMs: 120000, tags: ["slow"] }),
    );
    expect(checked.ok).toBe(true);
    expect(checked.value?.driver).toBe("http401");
  });

  it("rejects an unknown driver and a bad timeoutMs", () => {
    expect(
      validateGatewayRecord(goodCase({ driver: "manual" })).ok,
    ).toBe(false);
    expect(
      validateGatewayRecord(goodCase({ timeoutMs: -5 })).ok,
    ).toBe(false);
    expect(validateGatewayRecord(goodCase({ tags: "slow" })).ok).toBe(
      false,
    );
  });

  it("accepts errorCodeAnyOf, denyOrMask, pgDenyCodes, table rowCountUnchanged", () => {
    const checked = validateGatewayRecord(
      goodCase({
        expect: {
          denyOrMask: {
            codes: ["SENSITIVE_COLUMN_DENIED", "UNKNOWN_TABLE"],
            maskedColumn: "customers.phone",
          },
        },
        driver: "mcp",
      }),
    );
    expect(checked.ok).toBe(true);
    expect(
      validateGatewayRecord(goodCase({ expect: { errorCodeAnyOf: [] } })).ok,
    ).toBe(false);
    expect(
      validateGatewayRecord(
        goodCase({ expect: { denyOrMask: { codes: ["NOPE"], maskedColumn: "x" } } }),
      ).ok,
    ).toBe(false);
    expect(
      validateGatewayRecord(
        goodCase({ expect: { rowCountUnchanged: "orders" } }),
      ).ok,
    ).toBe(true);
    expect(
      validateGatewayRecord(goodCase({ expect: { rowCountUnchanged: 5 } }))
        .ok,
    ).toBe(false);
  });
});

describe("gradeGatewayCase", () => {
  it("passes the describe_table happy path", () => {
    const graded = gradeGatewayCase(
      goodCase() as unknown as GatewayCase,
      goodObserved(),
    );
    expect(graded.pass).toBe(true);
  });

  it("fails when the tool payload breaks its output schema", () => {
    const graded = gradeGatewayCase(
      goodCase() as unknown as GatewayCase,
      goodObserved({ data: { table: "customers" } }),
    );
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/output schema/);
  });

  it("grades errorCode denials and rejects data-shaped denials", () => {
    const c = goodCase({
      expect: { ok: false, errorCode: "FORBIDDEN_STATEMENT" },
    }) as unknown as GatewayCase;
    const denied: GatewayObserved = {
      ok: false,
      httpStatus: 200,
      code: "FORBIDDEN_STATEMENT",
      message: "denied",
      isError: true,
    };
    expect(gradeGatewayCase(c, denied).pass).toBe(true);
    const wrongCode = gradeGatewayCase(c, {
      ...denied,
      code: "UNKNOWN_TABLE",
    });
    expect(wrongCode.pass).toBe(false);
    expect(wrongCode.reason).toMatch(/UNKNOWN_TABLE.*FORBIDDEN_STATEMENT/);
    const dataShaped = gradeGatewayCase(c, { ...denied, isError: false });
    expect(dataShaped.pass).toBe(false);
    expect(dataShaped.reason).toMatch(/isError/);
  });

  it("grades httpStatus independently", () => {
    const c = goodCase({
      expect: { ok: false, httpStatus: 401, errorCode: "UNAUTHORIZED" },
    }) as unknown as GatewayCase;
    const observed: GatewayObserved = {
      ok: false,
      httpStatus: 401,
      code: "UNAUTHORIZED",
      message: "unauthorized",
    };
    expect(gradeGatewayCase(c, observed).pass).toBe(true);
    expect(
      gradeGatewayCase(c, { ...observed, httpStatus: 200 }).pass,
    ).toBe(false);
  });

  it("grades truncated plus maskedColumns contains and exact", () => {
    const contains = goodCase({
      tool: "run_query",
      expect: {
        ok: true,
        truncated: true,
        maskedColumns: ["customers.phone"],
        outputSchemaValid: true,
      },
    }) as unknown as GatewayCase;
    const runPayload = {
      columns: ["customer_id", "phone"],
      rows: [{ customer_id: "c1", phone: "090****" }],
      rowCount: 2,
      truncated: true,
      maskedColumns: ["customers.phone", "customers.email"],
      durationMs: 3,
    };
    const observed: GatewayObserved = {
      ok: true,
      httpStatus: 200,
      data: runPayload,
      rows: runPayload.rows,
      truncated: true,
      maskedColumns: ["customers.phone", "customers.email"],
      message: "",
    };
    expect(gradeGatewayCase(contains, observed).pass).toBe(true);
    const missing = gradeGatewayCase(
      goodCase({
        tool: "run_query",
        expect: { maskedColumns: ["customers.address"] },
      }) as unknown as GatewayCase,
      observed,
    );
    expect(missing.pass).toBe(false);
    expect(missing.reason).toMatch(/customers\.address/);
    const exact = gradeGatewayCase(
      goodCase({
        tool: "run_query",
        expect: { maskedColumnsExact: [] },
      }) as unknown as GatewayCase,
      observed,
    );
    expect(exact.pass).toBe(false);
  });

  it("grades rawValuesVisible for the HR leg", () => {
    const c = goodCase({
      tool: "run_query",
      expect: { ok: true, rawValuesVisible: ["salary"] },
    }) as unknown as GatewayCase;
    const raw: GatewayObserved = {
      ok: true,
      httpStatus: 200,
      rows: [{ employee_id: "e1", salary: 9000000 }],
      message: "",
    };
    expect(gradeGatewayCase(c, raw).pass).toBe(true);
    const masked: GatewayObserved = {
      ok: true,
      httpStatus: 200,
      rows: [{ employee_id: "e1", salary: "[MASKED]" }],
      message: "",
    };
    const graded = gradeGatewayCase(c, masked);
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/salary/);
  });

  it("grades valuesMasked and catches raw PII leaks", () => {
    const c = goodCase({
      tool: "run_query",
      expect: { ok: true, valuesMasked: ["phone"] },
    }) as unknown as GatewayCase;
    const masked: GatewayObserved = {
      ok: true,
      httpStatus: 200,
      rows: [{ customer_id: "c1", phone: "090****" }],
      message: "",
    };
    expect(gradeGatewayCase(c, masked).pass).toBe(true);
    const leaked: GatewayObserved = {
      ok: true,
      httpStatus: 200,
      rows: [{ customer_id: "c1", phone: "0901234567" }],
      message: "",
    };
    const graded = gradeGatewayCase(c, leaked);
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/phone/);
  });

  it("grades rowCountUnchanged for the DELETE probe", () => {
    const c = goodCase({
      expect: { ok: false, rowCountUnchanged: true },
    }) as unknown as GatewayCase;
    expect(
      gradeGatewayCase(c, {
        ok: false,
        httpStatus: 200,
        rowCountBefore: 10,
        rowCountAfter: 10,
      }).pass,
    ).toBe(true);
    const changed = gradeGatewayCase(c, {
      ok: false,
      httpStatus: 200,
      rowCountBefore: 10,
      rowCountAfter: 9,
    });
    expect(changed.pass).toBe(false);
    expect(changed.reason).toMatch(/row count changed/);
  });

  it("grades noSecretsInMessage against the observed message", () => {
    const c = goodCase({
      expect: { noSecretsInMessage: true },
    }) as unknown as GatewayCase;
    expect(
      gradeGatewayCase(c, goodObserved({ message: "denied" })).pass,
    ).toBe(true);
    const graded = gradeGatewayCase(
      c,
      goodObserved({ message: "postgres://agent_ro:secret@db:5432/chosen" }),
    );
    expect(graded.pass).toBe(false);
  });
});

describe("gradeGatewayCase Task-3 legs", () => {
  it("grades errorCodeAnyOf accept-sets", () => {
    const c = goodCase({
      expect: { ok: false, errorCodeAnyOf: ["TIMEOUT", "INTERNAL_ERROR"] },
    }) as unknown as GatewayCase;
    expect(
      gradeGatewayCase(c, {
        ok: false,
        httpStatus: 200,
        code: "TIMEOUT",
        message: "timeout",
        isError: true,
      }).pass,
    ).toBe(true);
    const graded = gradeGatewayCase(c, {
      ok: false,
      httpStatus: 200,
      code: "FORBIDDEN_STATEMENT",
      message: "denied",
      isError: true,
    });
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/not in/);
  });

  it("grades denyOrMask both branches", () => {
    const c = goodCase({
      tool: "run_query",
      expect: {
        denyOrMask: {
          codes: ["SENSITIVE_COLUMN_DENIED", "UNKNOWN_TABLE"],
          maskedColumn: "customers.phone",
        },
      },
    }) as unknown as GatewayCase;
    expect(
      gradeGatewayCase(c, {
        ok: true,
        httpStatus: 200,
        maskedColumns: ["customers.phone"],
        rows: [],
        message: "",
      }).pass,
    ).toBe(true);
    expect(
      gradeGatewayCase(c, {
        ok: false,
        httpStatus: 200,
        code: "UNKNOWN_TABLE",
        message: "denied",
        isError: true,
      }).pass,
    ).toBe(true);
    const unmasked = gradeGatewayCase(c, {
      ok: true,
      httpStatus: 200,
      maskedColumns: [],
      rows: [],
      message: "",
    });
    expect(unmasked.pass).toBe(false);
    expect(unmasked.reason).toMatch(/does not mask/);
    const outside = gradeGatewayCase(c, {
      ok: false,
      httpStatus: 200,
      code: "FORBIDDEN_FUNCTION",
      message: "denied",
      isError: true,
    });
    expect(outside.pass).toBe(false);
  });

  it("grades pgDenyCodes for the guard-off proof", () => {
    const c = goodCase({
      expect: { ok: true, pgDenyCodes: ["25006", "42501"] },
    }) as unknown as GatewayCase;
    expect(
      gradeGatewayCase(c, {
        ok: true,
        httpStatus: 0,
        code: "25006",
        message: "read-only",
        rowCountBefore: 4,
        rowCountAfter: 4,
      }).pass,
    ).toBe(true);
    const graded = gradeGatewayCase(c, {
      ok: true,
      httpStatus: 0,
      code: "XX000",
      message: "weird",
      rowCountBefore: 4,
      rowCountAfter: 4,
    });
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/pg denial code/);
  });
});

function auditLine(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ts: "2026-10-29T00:00:00.000Z",
    runId: "run-1",
    userId: "sales_south",
    role: "sales_south",
    clientId: "sales_south",
    scopes: ["schema:read", "data:read"],
    tool: "run_query",
    params: { sql: "SELECT '?'", maxRows: 1 },
    rowCount: 0,
    durationMs: 3,
    decision: "deny",
    errorCode: "FORBIDDEN_STATEMENT",
    piiHits: 0,
    ...overrides,
  };
}

describe("gradeAuditLines", () => {
  it("passes exact cardinality with full fields", () => {
    const graded = gradeAuditLines(
      [
        JSON.stringify(auditLine({ runId: "a" })),
        JSON.stringify(auditLine({ runId: "a", decision: "allow", errorCode: undefined })),
        JSON.stringify(auditLine({ runId: "b", decision: "allow", errorCode: undefined })),
      ],
      [
        { runId: "a", expectedLines: 2 },
        { runId: "b", expectedLines: 1 },
      ],
    );
    expect(graded.pass).toBe(true);
  });

  it("fails cardinality mismatches and ignores unattributed runIds", () => {
    const graded = gradeAuditLines(
      [
        JSON.stringify(auditLine({ runId: "a" })),
        JSON.stringify(auditLine({ runId: "stray-dev-line" })),
      ],
      [{ runId: "a", expectedLines: 2 }],
    );
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/owns 1 audit line/);
  });

  it("fails lines with missing fields or PII shapes", () => {
    const missing = gradeAuditLines(
      [JSON.stringify(auditLine({ runId: "a", clientId: "" }))],
      [{ runId: "a", expectedLines: 1 }],
    );
    expect(missing.pass).toBe(false);
    expect(missing.reason).toMatch(/clientId/);
    const phoneLeak = gradeAuditLines(
      [
        JSON.stringify(
          auditLine({ runId: "a", userId: "0901234567" }),
        ),
      ],
      [{ runId: "a", expectedLines: 1 }],
    );
    expect(phoneLeak.pass).toBe(false);
    expect(phoneLeak.reason).toMatch(/phone or email/);
  });

  it("fails an IPv4 leak inside an attributed line", () => {
    const graded = gradeAuditLines(
      [
        JSON.stringify(
          auditLine({
            runId: "a",
            params: { sql: "connect ECONNREFUSED 127.0.0.1:5433" },
          }),
        ),
      ],
      [{ runId: "a", expectedLines: 1 }],
    );
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/IPv4/);
  });

  it("fails a deny without errorCode", () => {
    const graded = gradeAuditLines(
      [JSON.stringify(auditLine({ runId: "a", errorCode: undefined }))],
      [{ runId: "a", expectedLines: 1 }],
    );
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/errorCode/);
  });
});
describe("assertNoSecretsInMessage", () => {
  it("passes a clean denial message", () => {
    expect(assertNoSecretsInMessage("query blocked by sql guard").pass).toBe(
      true,
    );
  });

  it("rejects DSN, host, IPv4, and user shapes", () => {
    for (const message of [
      "connect postgres://agent_ro:pw@db:5432/chosen failed",
      "could not connect host=db port=5432",
      "connect ECONNREFUSED 127.0.0.1:5433",
      'password authentication failed for user "agent_ro"',
    ]) {
      expect(assertNoSecretsInMessage(message).pass).toBe(false);
    }
  });

  it("rejects raw phone and email literals", () => {
    expect(assertNoSecretsInMessage("bad phone 0901234567").pass).toBe(
      false,
    );
    expect(
      assertNoSecretsInMessage("contact an.nguyen@example.vn").pass,
    ).toBe(false);
  });

  it("accepts the sanitizer's own redaction placeholders", () => {
    expect(
      assertNoSecretsInMessage("postgres://<redacted> unreachable").pass,
    ).toBe(true);
    expect(
      assertNoSecretsInMessage(
        'password authentication failed for user "<redacted>"',
      ).pass,
    ).toBe(true);
    expect(
      assertNoSecretsInMessage("host=<redacted> refused").pass,
    ).toBe(true);
  });

  it("is repeatable across consecutive calls", () => {
    const leaked = 'failed for user "agent_ro"';
    expect(assertNoSecretsInMessage(leaked).pass).toBe(false);
    expect(assertNoSecretsInMessage(leaked).pass).toBe(false);
    expect(assertNoSecretsInMessage("clean").pass).toBe(true);
  });
});
