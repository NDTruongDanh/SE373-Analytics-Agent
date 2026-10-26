import { describe, expect, it } from "vitest";
import { MCP_SERVER_SHELL } from "../src/index.js";

describe("mcp-server shell", () => {
  it("exposes a non-empty shell marker", () => {
    expect(typeof MCP_SERVER_SHELL).toBe("string");
    expect(MCP_SERVER_SHELL.length).toBeGreaterThan(0);
  });
});
