import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { withMcpToolRun } from "./telemetry/toolRuns.js";
import {
  dbToolError,
  DbToolErrorSchema,
  ErrorCodes,
  type DbToolError,
  type ErrorCode,
} from "@shared/contracts";

export interface TracerRunConfig {
  mcpUrl: string;
  token: string;
  runId: string;
  userId: string;
  roleScope: string;
  /** Server-resolved row predicate used only to partition the local model cache. */
  rowScope?: { column: string; value: string } | null;
  /** Graph callbacks for local tracing only; never forwarded to the MCP gateway. */
  callbacks?: Callbacks;
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
  return withMcpToolRun(config.callbacks, tool, args, () =>
    callMcpToolUntraced(config, tool, args),
  );
}

async function callMcpToolUntraced(
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

function asValidErrorCode(code: string): ErrorCode {
  return (ErrorCodes as readonly string[]).includes(code)
    ? (code as ErrorCode)
    : "INTERNAL_ERROR";
}

export function parseMcpToolError(tool: string, text: string): DbToolError {
  try {
    const raw: unknown = JSON.parse(text);
    const validated = DbToolErrorSchema.safeParse(raw);
    if (validated.success) return validated.data;
    if (
      typeof raw === "object" &&
      raw !== null &&
      "code" in raw &&
      typeof (raw as { code: unknown }).code === "string" &&
      "message" in raw &&
      typeof (raw as { message: unknown }).message === "string"
    ) {
      const code = asValidErrorCode((raw as { code: string }).code);
      const msg = (raw as { message: string }).message;
      return dbToolError(code, msg.slice(0, 500));
    }
  } catch {
  }
  return dbToolError("INTERNAL_ERROR", `MCP tool ${tool} failed: ${text.slice(0, 200)}`);
}

export function toNormalizedMcpError(tool: string, thrown: unknown): DbToolError {
  const validated = DbToolErrorSchema.safeParse(thrown);
  if (validated.success) return validated.data;
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    typeof (thrown as { code: unknown }).code === "string" &&
    "message" in thrown &&
    typeof (thrown as { message: unknown }).message === "string"
  ) {
    return dbToolError(
      asValidErrorCode((thrown as { code: string }).code),
      (thrown as { message: string }).message.slice(0, 500),
    );
  }
  const msg = thrown instanceof Error ? thrown.message : String(thrown);
  return dbToolError("INTERNAL_ERROR", `MCP tool ${tool} failed: ${msg.slice(0, 200)}`);
}

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

/** Fail closed if any identity field is missing or empty so calls never run with partial identity. */
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

export function resolveCallHeaders(identity: RunIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${identity.token}`,
    "x-run-id": identity.runId,
    "x-user-id": identity.userId,
    "x-role-scope": identity.roleScope,
  };
}

import { MCP_SERVER_NAME } from "./constants.js";

export { MCP_SERVER_NAME } from "./constants.js";

/**
 * Resolve per-call auth/identity headers from RunnableConfig only so
 * prompt-injected tool arguments cannot override them.
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

/** Long-lived client without static auth; headers are resolved per call via beforeToolCall. */
export function createMcpClient(mcpUrl: string): MultiServerMCPClient {
  return new MultiServerMCPClient({
    mcpServers: {
      [MCP_SERVER_NAME]: { transport: "http", url: mcpUrl },
    },
    beforeToolCall: createIdentityHook(),
  });
}

export async function getMcpTools(
  client: MultiServerMCPClient,
  serverName: string = MCP_SERVER_NAME,
): Promise<DynamicStructuredTool[]> {
  return client.getTools([serverName]);
}
