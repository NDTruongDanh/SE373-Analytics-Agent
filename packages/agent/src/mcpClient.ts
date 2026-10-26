// MCP client (AGENT-09, 01-12): one long-lived MultiServerMCPClient holding
// only the server URL, with per-call identity headers (Authorization Bearer
// plus X-Run-Id, X-User-Id, X-Role-Scope) forked from RunnableConfig
// configurable through a beforeToolCall hook — never from tool arguments, so
// a prompt-injected header can never reach the transport. The legacy per-call
// tracer surface stays for the 01-10 default route until 01-14 replaces it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

// Legacy tracer surface (01-01 slice): a fresh SDK Client plus transport per
// tool call, identity passed explicitly from the run config. Consumed by the
// 01-10 registry default route and its demo path.

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

// Full 01-12 surface: per-call identity from the host-populated
// RunnableConfig.configurable (D-11), resolved to wire headers by a pure
// helper and injected through the adapters' beforeToolCall hook.

/** Run identity the 01-14 host populates into RunnableConfig.configurable. */
export interface RunIdentity {
  token: string;
  runId: string;
  userId: string;
  roleScope: string;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`run identity missing or invalid: ${key}`);
  }
  return value;
}

/**
 * Fail-closed extraction of run identity from RunnableConfig.configurable.
 * Throws on any missing or non-string field — never runs with partial
 * identity.
 */
export function identityFromConfigurable(
  configurable: Record<string, unknown>,
): RunIdentity {
  return {
    token: readStringField(configurable, "token"),
    runId: readStringField(configurable, "runId"),
    userId: readStringField(configurable, "userId"),
    roleScope: readStringField(configurable, "roleScope"),
  };
}

/**
 * Pure header resolution: same identity in, same headers out, no shared
 * mutable state between calls (T-01-12-01: two sequential principals must
 * produce distinct X-Run-Id values with no bleed).
 */
export function resolveCallHeaders(identity: RunIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${identity.token}`,
    "x-run-id": identity.runId,
    "x-user-id": identity.userId,
    "x-role-scope": identity.roleScope,
  };
}

/** Server key under which the single gateway connection is registered. */
export const MCP_SERVER_NAME = "mcp";

/**
 * beforeToolCall hook reading identity only from RunnableConfig.configurable.
 * The adapters fork the connection with the returned headers per tool call,
 * so each call carries its own run's identity.
 */
export function createIdentityHook(): (
  toolCall: { serverName: string; name: string; args?: unknown },
  state: unknown,
  config: { configurable?: Record<string, unknown> },
) => Promise<{ headers: Record<string, string> }> {
  return async (_toolCall, _state, config) => ({
    headers: resolveCallHeaders(
      identityFromConfigurable(config.configurable ?? {}),
    ),
  });
}

/**
 * One long-lived client holding only the server URL. No static auth: every
 * tool call resolves its headers through the identity hook.
 */
export function createMcpClient(mcpUrl: string): MultiServerMCPClient {
  return new MultiServerMCPClient({
    mcpServers: {
      [MCP_SERVER_NAME]: { transport: "http", url: mcpUrl },
    },
    beforeToolCall: createIdentityHook(),
  });
}

/** Tool wrapper for the 01-11 executor seam (identity flows via config). */
export async function getMcpTools(
  client: MultiServerMCPClient,
  serverName: string = MCP_SERVER_NAME,
): Promise<DynamicStructuredTool[]> {
  return client.getTools([serverName]);
}
