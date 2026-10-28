import { describe, expect, it } from "vitest";
import { DATA_SHELL } from "../src/index.js";

describe("data shell", () => {
  it("exposes a non-empty shell marker", () => {
    expect(typeof DATA_SHELL).toBe("string");
    expect(DATA_SHELL.length).toBeGreaterThan(0);
  });
});
