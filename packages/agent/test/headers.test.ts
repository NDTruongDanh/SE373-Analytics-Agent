// Headers tests (AGENT-09, 01-12): pure resolveCallHeaders units (two
// sequential principals, no cross-contamination), fail-closed configurable
// extraction, and a stub-transport proof that per-call headers reach the wire
// through the beforeToolCall hook. No API key, no database.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createMcpClient,
  getMcpTools,
  identityFromConfigurable,
  resolveCallHeaders,
  type RunIdentity,
} from "../src/mcpClient.js";

interface SeenCall {
  tool: string;
  runId: string;
  auth: string;
  userId: string;
  roleScope: string;
}

const PRINCIPAL_A: RunIdentity = {
  token: "tok-A",
  runId: "run-A",
  userId: "user-a",
  roleScope: "sales_south",
};

const PRINCIPAL_B: RunIdentity = {
  token: "tok-B",
  runId: "run-B",
  userId: "user-b",
  roleScope: "marketing",
};

describe("resolveCallHeaders", () => {
  it("maps identity to Bearer plus run headers", () => {
    expect(resolveCallHeaders(PRINCIPAL_A)).toEqual({
      authorization: "Bearer tok-A",
      "x-run-id": "run-A",
      "x-user-id": "user-a",
      "x-role-scope": "sales_south",
    });
  });

  it("keeps two sequential principals distinct with no cross-contamination", () => {
    const first = resolveCallHeaders(PRINCIPAL_A);
    const second = resolveCallHeaders(PRINCIPAL_B);
    expect(first["x-run-id"]).toBe("run-A");
    expect(second["x-run-id"]).toBe("run-B");
    expect(second.authorization).toBe("Bearer tok-B");
    expect(first).not.toEqual(second);
    // Fresh objects per call: later resolutions never mutate earlier ones.
    expect(first["x-run-id"]).toBe("run-A");
  });
});

describe("identityFromConfigurable", () => {
  it("extracts the host-populated identity and ignores extras", () => {
    expect(
      identityFromConfigurable({
        token: "t",
        runId: "r",
        userId: "u",
        roleScope: "s",
        thread_id: "chat:u:s",
      }),
    ).toEqual({ token: "t", runId: "r", userId: "u", roleScope: "s" });
  });

  it("fails closed on missing or empty fields", () => {
    expect(() => identityFromConfigurable({})).toThrow(/run identity/);
    expect(() =>
      identityFromConfigurable({
        token: "t",
        runId: "",
        userId: "u",
        roleScope: "s",
      }),
    ).toThrow(/runId/);
    expect(() =>
      identityFromConfigurable({
        token: "t",
        runId: "r",
        userId: 42,
        roleScope: "s",
      }),
    ).toThrow(/userId/);
  });
});

describe("per-call identity on the wire", () => {
  let stub: Server | null = null;
  let mcpUrl = "";
  const seen: SeenCall[] = [];

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        resolve(data ? JSON.parse(data) : {});
      });
    });
  }

  function sse(
    res: import("node:http").ServerResponse,
    id: number,
    result: unknown,
  ) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id })}\n\n`,
    );
  }

  beforeAll(async () => {
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = (await readBody(req!)) as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string; name?: string; arguments?: unknown };
      };
      if (body.method === "initialize") {
        sse(res, body.id ?? 0, {
          protocolVersion: body.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "stub", version: "0" },
        });
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body.method === "tools/list") {
        sse(res, body.id ?? 0, {
          tools: [
            {
              name: "run_query",
              description: "run a read-only query",
              inputSchema: {
                type: "object",
                properties: { sql: { type: "string" } },
              },
            },
          ],
        });
        return;
      }
      if (body.method === "tools/call") {
        seen.push({
          tool: body.params?.name ?? "",
          runId: String(req.headers["x-run-id"] ?? ""),
          auth: String(req.headers["authorization"] ?? ""),
          userId: String(req.headers["x-user-id"] ?? ""),
          roleScope: String(req.headers["x-role-scope"] ?? ""),
        });
        sse(res, body.id ?? 0, {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                columns: ["n"],
                rows: [{ n: 1 }],
                rowCount: 1,
                truncated: false,
              }),
            },
          ],
        });
        return;
      }
      res.writeHead(400);
      res.end();
    });
    await new Promise<void>((resolve) => {
      stub = server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (stub) stub.close(() => resolve());
      else resolve();
    });
  });

  it("forks distinct headers per call from configurable (no bleed)", async () => {
    const client = createMcpClient(mcpUrl);
    try {
      const tools = await getMcpTools(client);
      const runQuery = tools.find((tool) => tool.name === "run_query");
      expect(runQuery).toBeDefined();
      seen.length = 0;
      await runQuery!.invoke({ sql: "SELECT 1" }, { configurable: { ...PRINCIPAL_A } });
      await runQuery!.invoke({ sql: "SELECT 1" }, { configurable: { ...PRINCIPAL_B } });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        tool: "run_query",
        runId: "run-A",
        auth: "Bearer tok-A",
        userId: "user-a",
        roleScope: "sales_south",
      });
      expect(seen[1]).toMatchObject({
        tool: "run_query",
        runId: "run-B",
        auth: "Bearer tok-B",
        userId: "user-b",
        roleScope: "marketing",
      });
    } finally {
      await client.close();
    }
  });
});
