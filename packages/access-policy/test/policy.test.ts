import { describe, expect, it } from "vitest";
import {
  COLUMN_SCOPE_POLICY_STUB_NOTICE,
  ColumnScopePolicy,
} from "../src/policy.js";

const VALID_CONFIG = {
  version: 1,
  columns: [
    { table: "customers", column: "phone" },
    { table: "customers", column: "email" },
  ],
} as const;

describe("ColumnScopePolicy stub", () => {
  it("constructs from a valid config", () => {
    const policy = new ColumnScopePolicy({
      version: 1,
      columns: [...VALID_CONFIG.columns.map((c) => ({ ...c }))],
    });
    expect(policy.name).toBe("ColumnScopePolicy/stub");
    expect(policy.columnCount).toBe(2);
  });

  it("throws fail-fast on invalid config", () => {
    expect(() => new ColumnScopePolicy(null)).toThrow();
    expect(() => new ColumnScopePolicy({})).toThrow();
    // Wrong version literal.
    expect(
      () =>
        new ColumnScopePolicy({
          version: 2,
          columns: [{ table: "customers", column: "phone" }],
        }),
    ).toThrow();
    // Missing columns array.
    expect(() => new ColumnScopePolicy({ version: 1 })).toThrow();
    // Empty table name.
    expect(
      () =>
        new ColumnScopePolicy({
          version: 1,
          columns: [{ table: "", column: "phone" }],
        }),
    ).toThrow();
    // Empty column name.
    expect(
      () =>
        new ColumnScopePolicy({
          version: 1,
          columns: [{ table: "customers", column: "" }],
        }),
    ).toThrow();
  });

  it("apply passes through and claims no enforcement", () => {
    const policy = new ColumnScopePolicy({
      version: 1,
      columns: [...VALID_CONFIG.columns.map((c) => ({ ...c }))],
    });
    expect(policy.enforcesMasking).toBe(false);
    expect(
      policy.apply({
        sql: "SELECT phone FROM customers",
        tables: ["customers"],
        columns: [{ table: "customers", column: "phone" }],
      }),
    ).toEqual({ allowed: true, maskedColumns: [] });
    // The stub notice documents the deferral so no caller mistakes
    // pass-through for enforcement.
    expect(COLUMN_SCOPE_POLICY_STUB_NOTICE).toMatch(/UC09-01/);
  });
});
