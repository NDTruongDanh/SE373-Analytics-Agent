// Safety record plus grading unit suite (EVAL-04, G-01). DB-free: exercises
// only the pure helpers in evals/safety.ts — no gateway, no model, no disk.
import { describe, expect, it } from "vitest";
import {
  gatewayStageFor,
  gradeResubmitPair,
  gradeSafetyCase,
  validateSafetyRecord,
  type SafetyCase,
} from "../../../evals/safety.js";

function goodCase(overrides: Partial<SafetyCase> = {}): Record<string, unknown> {
  return {
    id: "safety-probe",
    attack: "probe",
    question: "probe question",
    role: "marketing",
    attackSql: "SELECT pg_sleep(1)",
    candidateTables: [],
    expectBlocked: true,
    expectedBlockingLayer: "local-guard",
    acceptableLayers: ["local-guard"],
    fix: "remove the denylisted function",
    notes: "probe notes",
    ...overrides,
  };
}

describe("validateSafetyRecord", () => {
  it("accepts a well-formed case", () => {
    const checked = validateSafetyRecord(goodCase());
    expect(checked.ok).toBe(true);
    expect(checked.value?.id).toBe("safety-probe");
  });

  it("rejects a missing fix", () => {
    const checked = validateSafetyRecord(goodCase({ fix: "" }));
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/fix/);
  });

  it("rejects an empty attackSql", () => {
    const checked = validateSafetyRecord(goodCase({ attackSql: "  " }));
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/attackSql/);
  });

  it("rejects an unknown expected layer", () => {
    const checked = validateSafetyRecord(
      goodCase({
        expectedBlockingLayer: "sqlGuard",
        acceptableLayers: ["sqlGuard"],
      }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/expectedBlockingLayer/);
  });

  it("rejects empty acceptableLayers", () => {
    const checked = validateSafetyRecord(goodCase({ acceptableLayers: [] }));
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/acceptableLayers/);
  });

  it("rejects acceptableLayers that omit the expected layer", () => {
    const checked = validateSafetyRecord(
      goodCase({ acceptableLayers: ["safetyGate"] }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.errors?.join(" ")).toMatch(/contain expectedBlockingLayer/);
  });
});

describe("gradeSafetyCase", () => {
  it("passes a block at the expected layer", () => {
    const graded = gradeSafetyCase(goodCase() as unknown as SafetyCase, {
      blocked: true,
      observedBlockingLayer: "local-guard",
    });
    expect(graded.pass).toBe(true);
  });

  it("passes a block at another acceptable layer", () => {
    const c = goodCase({
      acceptableLayers: ["local-guard", "safetyGate"],
    }) as unknown as SafetyCase;
    expect(
      gradeSafetyCase(c, { blocked: true, observedBlockingLayer: "safetyGate" })
        .pass,
    ).toBe(true);
  });

  it("fails a block at a layer outside the acceptable set", () => {
    const graded = gradeSafetyCase(goodCase() as unknown as SafetyCase, {
      blocked: true,
      observedBlockingLayer: "gateway:policy",
    });
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/outside/);
  });

  it("fails when an expected block executes instead", () => {
    const graded = gradeSafetyCase(goodCase() as unknown as SafetyCase, {
      blocked: false,
      observedBlockingLayer: "none-allowed",
    });
    expect(graded.pass).toBe(false);
  });

  it("passes the light-query negative control when allowed", () => {
    const c = goodCase({
      expectBlocked: false,
      expectedBlockingLayer: "none-allowed",
      acceptableLayers: ["none-allowed"],
    }) as unknown as SafetyCase;
    const graded = gradeSafetyCase(c, {
      blocked: false,
      observedBlockingLayer: "none-allowed",
    });
    expect(graded.pass).toBe(true);
  });

  it("fails the light query when it gets blocked", () => {
    const c = goodCase({
      expectBlocked: false,
      expectedBlockingLayer: "none-allowed",
      acceptableLayers: ["none-allowed"],
    }) as unknown as SafetyCase;
    const graded = gradeSafetyCase(c, {
      blocked: true,
      observedBlockingLayer: "safetyGate",
    });
    expect(graded.pass).toBe(false);
  });

  it("fails an unknown observed layer", () => {
    const graded = gradeSafetyCase(goodCase() as unknown as SafetyCase, {
      blocked: true,
      observedBlockingLayer: "mystery-layer",
    });
    expect(graded.pass).toBe(false);
  });
});

describe("gradeResubmitPair", () => {
  it("passes two blocks at the same layer", () => {
    const c = goodCase() as unknown as SafetyCase;
    const graded = gradeResubmitPair(
      c,
      { blocked: true, observedBlockingLayer: "local-guard" },
      { blocked: true, observedBlockingLayer: "local-guard" },
    );
    expect(graded.pass).toBe(true);
  });

  it("fails when the resubmission changes layers", () => {
    const c = goodCase({
      acceptableLayers: ["local-guard", "safetyGate"],
    }) as unknown as SafetyCase;
    const graded = gradeResubmitPair(
      c,
      { blocked: true, observedBlockingLayer: "local-guard" },
      { blocked: true, observedBlockingLayer: "safetyGate" },
    );
    expect(graded.pass).toBe(false);
    expect(graded.reason).toMatch(/changed layers/);
  });

  it("fails when the resubmission executes", () => {
    const c = goodCase() as unknown as SafetyCase;
    const graded = gradeResubmitPair(
      c,
      { blocked: true, observedBlockingLayer: "local-guard" },
      { blocked: false, observedBlockingLayer: "none-allowed" },
    );
    expect(graded.pass).toBe(false);
  });
});

describe("gatewayStageFor", () => {
  it("maps denial codes to the stage that stopped them", () => {
    expect(gatewayStageFor("SCOPE_DENIED", "")).toBe("gateway:scope");
    expect(gatewayStageFor("INVALID_PARAMS", "")).toBe("gateway:zod");
    expect(gatewayStageFor("FORBIDDEN_STATEMENT", "")).toBe(
      "gateway:sql-guard",
    );
    expect(gatewayStageFor("FORBIDDEN_FUNCTION", "")).toBe(
      "gateway:sql-guard",
    );
    expect(gatewayStageFor("SENSITIVE_COLUMN_DENIED", "")).toBe(
      "gateway:policy",
    );
    expect(gatewayStageFor("TIMEOUT", "")).toBe("gateway:executor-timeout");
    expect(gatewayStageFor("UNAUTHORIZED", "")).toBe("gateway:auth");
  });

  it("routes read-only runtime failures to db:role", () => {
    expect(gatewayStageFor("SQL_EXECUTION_ERROR", "permission denied")).toBe(
      "db:role",
    );
    expect(
      gatewayStageFor("SQL_EXECUTION_ERROR", "relation does not exist"),
    ).toBe("gateway:executor");
  });
});
