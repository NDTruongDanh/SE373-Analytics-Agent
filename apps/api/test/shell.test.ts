import { describe, expect, it } from "vitest";
import { API_SHELL } from "../src/index.js";

describe("api shell", () => {
  it("exposes a non-empty shell marker", () => {
    expect(typeof API_SHELL).toBe("string");
    expect(API_SHELL.length).toBeGreaterThan(0);
  });
});
