import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// TRACER MCP client (AGENT-09 slice): a fresh SDK Client + transport per tool
// call, with Authorization Bearer plus X-Run-Id, X-User-Id and X-Role-Scope
// passed explicitly from the run config. Static demo principal sales_south
// with schema:read + data:read. The beforeToolCall fork upgrade lands in 01-12.

export interface TracerRunConfig {
  mcpUrl: string;
  token: string;
  runId: string;
  userId: string;
  roleScope: string;
}

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export async function callMcpTool(
  config: TracerRunConfig,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: {
      headers: {
        authorization: `Bearer ${config.token}`,
        "x-run-id": config.runId,
        "x-user-id": config.userId,
        "x-role-scope": config.roleScope,
      },
    },
  });
  const client = new Client({ name: "se373-tracer-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("");
    return { text, isError: result.isError === true };
  } finally {
    await client.close();
  }
}

/** Parse a tool text payload; throw a plain Error on MCP error payloads. */
export function parseToolJson<T>(result: McpToolResult, tool: string): T {
  const parsed: unknown = JSON.parse(result.text);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "code" in parsed &&
    typeof (parsed as { code: unknown }).code === "string"
  ) {
    const err = parsed as { code: string; message?: string };
    throw new Error(`MCP tool ${tool} failed with ${err.code}: ${err.message ?? ""}`);
  }
  return parsed as T;
}
