// Gateway HTTP surface: malformed tool params must reach the pipeline, so
// they are denied with a JSON INVALID_PARAMS DbToolError plus exactly one
// audit line, and scope runs before zod (UC09.md B.1, PR #62 review). The
// SDK would otherwise reject them first with "MCP error -32602" and no
// audit. DB-free: stub catalog, no session factory calls, lazy pg pool.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGatewayApp } from "../src/server.js";
import { resetAgentRoPoolForTests } from "../src/executor.js";
import type { BuiltCatalog } from "../src/catalog.js";

const CLIENTS_YAML = `
version: 1
clients:
  - clientId: sales_south
    role: sales_south
    tokenEnv: MCP_TOKEN_TEST_SALES
    scopes: [schema:read, data:read]
  - clientId: schema_only
    role: schema_only
    tokenEnv: MCP_TOKEN_TEST_SCHEMA
    scopes: [schema:read]
`;

const SENSITIVE_YAML = `
version: 1
columns: []
`;

function stubCatalog(): BuiltCatalog {
  return {
    catalog: {
      tables: [
        {
          name: "orders",
          schema: "public",
          columns: [
            { name: "id", type: "text", nullable: false, sensitive: false, large: false },
          ],
        },
      ],
    },
    primaryKeys: new Map([["orders", ["id"]]]),
    foreignKeys: new Map(),
  };
}

const ENV_KEYS = [
  "MCP_TOKEN_TEST_SALES",
  "MCP_TOKEN_TEST_SCHEMA",
  "AGENT_RO_DATABASE_URL",
] as const;

let server: Server;
let mcpUrl: string;
let auditPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MCP_TOKEN_TEST_SALES = "sales-test-token";
  process.env.MCP_TOKEN_TEST_SCHEMA = "schema-test-token";
  // The search pool is created eagerly but pg pools connect lazily; these
  // tests never query, so a placeholder URL is never dialled.
  process.env.AGENT_RO_DATABASE_URL = "postgres://placeholder@127.0.0.1:1/none";
  auditPath = path.join(mkdtempSync(path.join(tmpdir(), "gw-audit-")), "audit.jsonl");
  const app = await createGatewayApp({
    clientsYaml: CLIENTS_YAML,
    sensitiveYaml: SENSITIVE_YAML,
    auditPath,
    catalogOverride: stubCatalog(),
    search: async () => [],
    documents: [],
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetAgentRoPoolForTests();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

let auditBefore = 0;
beforeEach(() => {
  auditBefore = auditLines().length;
});

function auditLines(): Record<string, unknown>[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function newAuditLines(): Record<string, unknown>[] {
  return auditLines().slice(auditBefore);
}

async function withClient<T>(
  token: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "gateway-server-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
}

describe("gateway tools/call with malformed params", () => {
  it("denies a bad param type in the pipeline with one audit line", async () => {
    const result = await withClient("sales-test-token", (client) =>
      client.callTool({ name: "describe_table", arguments: { table: 123 } }),
    );
    expect(result.isError).toBe(true);
    expect(payload(result)["code"]).toBe("INVALID_PARAMS");
    const lines = newAuditLines().filter((line) => line["tool"] === "describe_table");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      decision: "deny",
      errorCode: "INVALID_PARAMS",
      clientId: "sales_south",
    });
  });

  it("denies a missing required field in the pipeline with one audit line", async () => {
    const result = await withClient("sales-test-token", (client) =>
      client.callTool({ name: "run_query", arguments: { maxRows: 5 } }),
    );
    expect(result.isError).toBe(true);
    expect(payload(result)["code"]).toBe("INVALID_PARAMS");
    const lines = newAuditLines().filter((line) => line["tool"] === "run_query");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ decision: "deny", errorCode: "INVALID_PARAMS" });
  });

  it("rejects unknown keys on strict schemas instead of stripping them", async () => {
    const result = await withClient("sales-test-token", (client) =>
      client.callTool({ name: "list_tables", arguments: { extra: 1 } }),
    );
    expect(result.isError).toBe(true);
    expect(payload(result)["code"]).toBe("INVALID_PARAMS");
  });

  it("checks scope before params", async () => {
    const result = await withClient("schema-test-token", (client) =>
      client.callTool({ name: "run_query", arguments: { sql: 123 } }),
    );
    expect(result.isError).toBe(true);
    expect(payload(result)["code"]).toBe("SCOPE_DENIED");
    const lines = newAuditLines().filter((line) => line["tool"] === "run_query");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ decision: "deny", errorCode: "SCOPE_DENIED" });
  });
});

describe("gateway tools/list", () => {
  it("still advertises the strict contract input schemas", async () => {
    const listed = await withClient("sales-test-token", (client) => client.listTools());
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_tables",
      "describe_table",
      "explain_query",
      "run_query",
      "sample_rows",
      "search_semantic_layer",
    ]);
    const runQuery = listed.tools.find((tool) => tool.name === "run_query");
    const schema = runQuery?.inputSchema as {
      type?: string;
      required?: string[];
      properties?: Record<string, { maximum?: number }>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("sql");
    expect(schema.properties?.["maxRows"]?.maximum).toBe(1000);
    const sampleRows = listed.tools.find((tool) => tool.name === "sample_rows");
    const sampleSchema = sampleRows?.inputSchema as {
      properties?: Record<string, { maximum?: number }>;
    };
    expect(sampleSchema.properties?.["n"]?.maximum).toBe(5);
  });
});
