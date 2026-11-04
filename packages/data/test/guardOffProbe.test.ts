// DB-free unit tests for the guard-off probe helper (issue #39, D-03).
// Only the pure parts are covered here: COUNT coercion (node-pg returns
// int8 counts as decimal strings) and the untrusted-table fail-closed gate
// (throws before any connection). The live probe itself runs in 02-03.
import { describe, expect, it } from "vitest";
import {
  parseCountValue,
  probeAgentRoWriteRefused,
} from "../src/guardOffProbe.js";

describe("parseCountValue", () => {
  it("accepts finite numbers", () => {
    expect(parseCountValue(42)).toBe(42);
    expect(parseCountValue(0)).toBe(0);
  });

  it("coerces numeric strings (node-pg int8 COUNT shape)", () => {
    expect(parseCountValue("1048576")).toBe(1048576);
    expect(parseCountValue("0")).toBe(0);
  });

  it("rejects non-numeric shapes so callers fail closed", () => {
    expect(parseCountValue(undefined)).toBeUndefined();
    expect(parseCountValue(null)).toBeUndefined();
    expect(parseCountValue("")).toBeUndefined();
    expect(parseCountValue("  ")).toBeUndefined();
    expect(parseCountValue("abc")).toBeUndefined();
    expect(parseCountValue(Number.NaN)).toBeUndefined();
    expect(parseCountValue(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseCountValue({ n: 1 })).toBeUndefined();
  });
});

describe("probeAgentRoWriteRefused", () => {
  it("refuses untrusted table names before connecting", async () => {
    await expect(
      probeAgentRoWriteRefused(
        "postgres://agent_ro:x@127.0.0.1:5433/db",
        "orders; DROP TABLE orders",
        "SELECT 1",
      ),
    ).rejects.toThrow("untrusted table name");
  });
});
