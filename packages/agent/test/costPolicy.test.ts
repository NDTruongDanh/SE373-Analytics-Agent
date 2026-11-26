// explain_query cost ceilings (#129, H-08): loader strictness plus per-role
// resolution. Pure: the repo policy file is read, nothing else.
import { describe, expect, it } from "vitest";
import {
  ceilingsFor,
  costBreach,
  loadQueryCostPolicy,
  loadQueryCostPolicyFile,
} from "../src/queryExecutor/costPolicy.js";

describe("query cost policy", () => {
  it("loads the repo policy with the documented defaults", () => {
    const policy = loadQueryCostPolicyFile();
    expect(policy.default).toEqual({ maxEstimatedCost: 1e6, maxEstimatedRows: 5e6 });
  });

  it("merges a partial role override over the default", () => {
    const policy = loadQueryCostPolicy(
      "version: 1\ndefault: {maxEstimatedCost: 1000, maxEstimatedRows: 50}\nroles:\n  analyst: {maxEstimatedCost: 9000}\n",
    );
    expect(ceilingsFor(policy, "analyst")).toEqual({ maxEstimatedCost: 9000, maxEstimatedRows: 50 });
    expect(ceilingsFor(policy, "sales_south")).toEqual({ maxEstimatedCost: 1000, maxEstimatedRows: 50 });
  });

  it("rejects unknown keys, a wrong version, and non-positive ceilings", () => {
    expect(() =>
      loadQueryCostPolicy("version: 1\ndefault: {maxEstimatedCost: 1, maxEstimatedRows: 1, maxRows: 2}\n"),
    ).toThrow();
    expect(() =>
      loadQueryCostPolicy("version: 2\ndefault: {maxEstimatedCost: 1, maxEstimatedRows: 1}\n"),
    ).toThrow();
    expect(() =>
      loadQueryCostPolicy("version: 1\ndefault: {maxEstimatedCost: 0, maxEstimatedRows: 1}\n"),
    ).toThrow();
    expect(() => loadQueryCostPolicy("version: [1\n")).toThrow(/Invalid query_cost YAML/);
  });

  it("reports the first exceeded ceiling and nothing at the boundary", () => {
    const ceilings = { maxEstimatedCost: 100, maxEstimatedRows: 10 };
    expect(costBreach({ estimatedCost: 100, estimatedRows: 10 }, ceilings)).toBeUndefined();
    expect(costBreach({ estimatedCost: 101, estimatedRows: 99 }, ceilings)).toMatchObject({
      metric: "estimatedCost",
    });
    expect(costBreach({ estimatedCost: 1, estimatedRows: 11 }, ceilings)).toEqual({
      metric: "estimatedRows",
      estimate: 11,
      ceiling: 10,
    });
  });
});
