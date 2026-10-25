import { describe, expect, it } from "vitest";
import { WEB_SHELL } from "../src/index.js";

describe("web shell", () => {
  it("exposes a non-empty shell marker", () => {
    expect(typeof WEB_SHELL).toBe("string");
    expect(WEB_SHELL.length).toBeGreaterThan(0);
  });
});
