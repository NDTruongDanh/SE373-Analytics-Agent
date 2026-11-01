import { describe, expect, it } from "vitest";
import { AGENT_SHELL } from "../src/constants.js";

describe("agent shell", () => {
  it("exposes a non-empty shell marker", () => {
    expect(typeof AGENT_SHELL).toBe("string");
    expect(AGENT_SHELL.length).toBeGreaterThan(0);
  });
});
