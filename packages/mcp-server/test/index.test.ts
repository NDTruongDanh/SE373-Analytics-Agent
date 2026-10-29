import { describe, expect, it } from "vitest";
import * as mcpServer from "../src/index.js";

describe("mcp-server barrel", () => {
  it("re-exports the gateway entrypoints and pure building blocks", () => {
    expect(typeof mcpServer.createGatewayApp).toBe("function");
    expect(typeof mcpServer.startGatewayServer).toBe("function");
    expect(typeof mcpServer.executeToolCall).toBe("function");
    expect(typeof mcpServer.buildCatalog).toBe("function");
    expect(typeof mcpServer.sanitizeError).toBe("function");
    expect(mcpServer.TOOL_SPECS.length).toBeGreaterThan(0);
  });

  it("no longer exposes the Phase 1 shell marker", () => {
    expect("MCP_SERVER_SHELL" in mcpServer).toBe(false);
  });
});
