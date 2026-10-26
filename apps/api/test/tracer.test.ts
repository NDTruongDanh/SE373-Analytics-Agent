import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTracerApi } from "../src/index.js";

// TRACER slice: runId/threadId minting shape and SSE sanitization (no cell
// value leakage). A minimal stub MCP backs the agent graph — no DB needed.

const SEED_PHONES = ["0901111111", "0905555555"];
const SEED_EMAIL = "an.nguyen@example.vn";

interface SseBlock {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseBlock[] {
  const blocks: SseBlock[] = [];
  for (const chunk of text.split("\n\n")) {
    const event = /event: ([^\n]+)/.exec(chunk)?.[1];
    const data = /data: ([\s\S]+)/.exec(chunk)?.[1];
    if (event && data) {
      blocks.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  return blocks;
}

describe("tracer /api/ask", () => {
  let apiBase = "";
  let stub: Server | null = null;
  let tracesDir = "";
  let apiServer: { close: (cb?: () => void) => void } | null = null;

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data ? JSON.parse(data) : {}));
    });
  }

  function sse(res: import("node:http").ServerResponse, id: number, result: unknown) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id })}\n\n`);
  }

  beforeAll(async () => {
    tracesDir = mkdtempSync(path.join(tmpdir(), "tracer-api-"));
    const mcp = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = (await readBody(req!)) as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string; name?: string };
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
      if (body.method === "tools/call") {
        const payload =
          body.params?.name === "list_tables"
            ? { tables: [{ name: "orders", schema: "public", columns: [] }] }
            : {
                columns: ["status", "n"],
                rows: [
                  { status: "cancelled", n: 2 },
                  { status: "completed", n: 7 },
                  { status: "pending", n: 3 },
                ],
                rowCount: 3,
                truncated: false,
              };
        sse(res, body.id ?? 0, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        });
        return;
      }
      res.writeHead(400);
      res.end();
    });
    await new Promise<void>((resolve) => {
      stub = mcp.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub!.address() as AddressInfo;
    const app = createTracerApi({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      token: "stub-token",
      tracesDir,
    });
    await new Promise<void>((resolve) => {
      apiServer = app.listen(0, "127.0.0.1", () => resolve());
    });
    const apiAddress = (apiServer as unknown as { address: () => AddressInfo }).address();
    apiBase = `http://127.0.0.1:${apiAddress.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (apiServer) apiServer.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => {
      if (stub) stub.close(() => resolve());
      else resolve();
    });
  });

  async function ask(body: unknown): Promise<{ status: number; text: string; json?: unknown }> {
    const res = await fetch(`${apiBase}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }

  it("rejects a missing question with 400", async () => {
    const out = await ask({});
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("streams the five sanitized events with minted ids", async () => {
    const out = await ask({ question: "How many orders do we have per status?" });
    expect(out.status).toBe(200);
    const blocks = parseSse(out.text);
    expect(blocks.map((b) => b.event)).toEqual([
      "intent_parsed",
      "schema_retrieved",
      "sql_generated",
      "query_running",
      "completed",
    ]);
    const runIds = new Set(blocks.map((b) => b.data["runId"]));
    const threadIds = new Set(blocks.map((b) => b.data["threadId"]));
    expect(runIds.size).toBe(1);
    expect(threadIds.size).toBe(1);
    const runId = [...runIds][0] as string;
    const threadId = [...threadIds][0] as string;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runId).not.toBe(threadId);
    const completed = blocks[blocks.length - 1].data["data"] as {
      status: string;
      toolsCalled: string[];
    };
    expect(completed.status).toBe("ok");
    expect(completed.toolsCalled).toEqual(["list_tables", "run_query"]);
  });

  it("mints distinct ids per run", async () => {
    const first = parseSse((await ask({ question: "q1" })).text);
    const second = parseSse((await ask({ question: "q2" })).text);
    expect(first[0].data["runId"]).not.toBe(second[0].data["runId"]);
  });

  it("leaks no cell values or PII through SSE", async () => {
    const out = await ask({ question: "How many orders do we have per status?" });
    for (const phone of SEED_PHONES) {
      expect(out.text).not.toContain(phone);
    }
    expect(out.text).not.toContain(SEED_EMAIL);
    expect(out.text).not.toContain("MASKED_PHONE");
    // No SQL literals: the statement type is metadata, the text is not.
    expect(out.text).not.toContain("COUNT(*)");
    expect(out.text).not.toContain("public.orders");
    expect(out.text).not.toContain("GROUP BY");
  });
});
