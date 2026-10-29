import { describe, expect, it } from "vitest";
import * as accessPolicy from "../src/index.js";

describe("access-policy barrel", () => {
  it("re-exports the production guard, policy, and redaction entrypoints", () => {
    expect(typeof accessPolicy.sqlGuard).toBe("function");
    expect(typeof accessPolicy.warmupSqlGuard).toBe("function");
    expect(typeof accessPolicy.ColumnScopePolicy).toBe("function");
    expect(typeof accessPolicy.redactPII).toBe("function");
    expect(typeof accessPolicy.redactRow).toBe("function");
  });

  it("no longer exposes the Phase 1 shell marker", () => {
    expect("ACCESS_POLICY_SHELL" in accessPolicy).toBe(false);
  });
});
