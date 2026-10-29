// Full-host ask plus SSE sanitization legs (API-01/API-03, 01-14).
// DB-free per D-21: MemorySaver checkpointer plus a stub MCP gateway —
// no database, no network beyond loopback.

import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemorySaver } from "@langchain/langgraph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { SSE_ALLOWLIST } from "../src/sse.js";

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

describe("buildApp /api/ask", () => {
  let apiBase = "";
  let stub: Server | null = null;
  let tracesDir = "";
  let apiServer: { close: (cb?: () => void) => void } | null = null;

  const stubEnv = {
    MCP_TOKEN_SALES_SOUTH: "stub-sales",
    MCP_TOKEN_MARKETING: "stub-marketing",
    MCP_TOKEN_HR: "stub-hr",
    MCP_TOKEN_ADMIN: "stub-admin",
    MCP_TOKEN_EVAL_SCOPE: "stub-eval-scope",
  } as unknown as NodeJS.ProcessEnv;

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
    tracesDir = mkdtempSync(path.join(tmpdir(), "fullhost-api-"));
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
                columns: ["status", "n", "phone"],
                rows: [
                  { status: "cancelled", n: 2, phone: SEED_PHONES[0] },
                  { status: "completed", n: 7, phone: SEED_EMAIL },
                  { status: "pending", n: 3, phone: SEED_PHONES[1] },
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
    const app = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      tracesDir,
      env: stubEnv,
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

  async function ask(body: unknown): Promise<{ status: number; text: string; headers: Headers; json?: unknown }> {
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
    return { status: res.status, text, headers: res.headers, json };
  }

  it("rejects a missing question with 400", async () => {
    const out = await ask({});
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("fails closed on unknown personas with no default role", async () => {
    for (const persona of ["root", "admin", "default", ""]) {
      const out = await ask({ question: "q", persona });
      expect(out.status).toBe(400);
      expect(out.json).toMatchObject({ code: "INVALID_PARAMS" });
    }
  });

  it("rejects malformed client threadIds", async () => {
    const out = await ask({ question: "q", persona: "sales_south", threadId: "nope" });
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("streams allowlisted schema-validated SSE with minted chat ids", async () => {
    const out = await ask({ question: "How many orders do we have per status?", persona: "sales_south" });
    expect(out.status).toBe(200);
    expect(out.headers.get("x-run-id")).toMatch(/^[0-9a-f-]{36}$/);
    const blocks = parseSse(out.text);
    expect(blocks.map((b) => b.event)).toEqual([
      "intent_parsed",
      "schema_retrieved",
      "sql_generated",
      "query_running",
      "completed",
    ]);
    for (const block of blocks) {
      expect([...SSE_ALLOWLIST] as string[]).toContain(block.event);
    }
    const runIds = new Set(blocks.map((b) => b.data["runId"]));
    const threadIds = new Set(blocks.map((b) => b.data["threadId"]));
    expect(runIds.size).toBe(1);
    expect(threadIds.size).toBe(1);
    const runId = [...runIds][0] as string;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.headers.get("x-run-id")).toBe(runId);
    const threadId = [...threadIds][0] as string;
    expect(threadId.startsWith(`chat:sales_south:${runId}`)).toBe(true);
    const completed = blocks[blocks.length - 1].data["data"] as {
      status: string;
      answerText: string;
      toolsCalled: string[];
      total: number;
    };
    expect(completed.status).toBe("ok");
    expect(completed.toolsCalled).toEqual(["list_tables", "run_query"]);
    expect(completed.total).toBe(12);
    expect(completed.answerText).toContain("3 status groups");
  });

  it("honours a well-formed client threadId", async () => {
    const out = await ask({
      question: "How many orders do we have per status?",
      persona: "marketing",
      threadId: "chat:marketing:session-9",
    });
    expect(out.status).toBe(200);
    const blocks = parseSse(out.text);
    expect(new Set(blocks.map((b) => b.data["threadId"] as string))).toEqual(
      new Set(["chat:marketing:session-9"]),
    );
  });

  it("leaks no cell values, SQL literals, or tokens through SSE", async () => {
    const out = await ask({ question: "How many orders do we have per status?", persona: "hr" });
    for (const phone of SEED_PHONES) {
      expect(out.text).not.toContain(phone);
    }
    expect(out.text).not.toContain(SEED_EMAIL);
    expect(out.text).not.toContain("MASKED_PHONE");
    expect(out.text).not.toContain("COUNT(*)");
    expect(out.text).not.toContain("public.orders");
    expect(out.text).not.toContain("GROUP BY");
    expect(out.text).not.toContain("stub-hr");
  });
});
