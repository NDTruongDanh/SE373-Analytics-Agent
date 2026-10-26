import { describe, expect, it } from "vitest";
import { ACCESS_POLICY_SHELL } from "../src/index.js";

describe("access-policy shell", () => {
  it("exposes a non-empty shell marker", () => {
    expect(typeof ACCESS_POLICY_SHELL).toBe("string");
    expect(ACCESS_POLICY_SHELL.length).toBeGreaterThan(0);
  });
});
