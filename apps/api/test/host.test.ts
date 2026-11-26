// Full-host ask plus SSE sanitization legs (API-01/API-03, 01-14).
// DB-free per D-21: MemorySaver checkpointer plus a stub MCP gateway —
// no database, no network beyond loopback.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemorySaver } from "@langchain/langgraph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_CSP_HEADER, buildApp } from "../src/index.js";
import { SSE_ALLOWLIST } from "../src/sse.js";
import { ModelRetryError } from "@shared/agent/telemetry";

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
      if (req.url === "/reindex") {
        if (req.headers.authorization === "Bearer stub-admin") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ added: 1, updated: 2, skipped: 15, deleted: 0 }));
        } else {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "forbidden" }));
        }
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
    expect(out.headers.get("content-security-policy")).toBe(API_CSP_HEADER);
  });

  it("sends strict Content-Security-Policy header on /healthz and SSE /api/ask responses", async () => {
    const healthRes = await fetch(`${apiBase}/healthz`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' data:; connect-src 'self'",
    );

    const askRes = await ask({
      question: "How many orders per status?",
      persona: "sales_south",
    });
    expect(askRes.status).toBe(200);
    expect(askRes.headers.get("content-security-policy")).toBe(
      "default-src 'self'; img-src 'self' data:; connect-src 'self'",
    );
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

  it("sends the initial progress event while the graph is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = buildApp({
      checkpointer: new MemorySaver(), mcpUrl: "http://127.0.0.1:1/mcp", tracesDir, env: stubEnv,
      routes: { "text-to-sql": async () => { await gate; return { status: "ok", answerText: "done" }; } },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q", persona: "sales_south" }), signal: AbortSignal.timeout(5000),
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("intent_parsed");
      expect(text).not.toContain("completed");
      release();
      let remaining = "";
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value); }
      expect(remaining).toContain("completed");
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("starts a fresh run on a reused thread after cannot_answer", async () => {
    let calls = 0;
    const intentPayload = {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
      queryMode: "standard_query" as const,
    };
    const app = buildApp({
      checkpointer: new MemorySaver(), mcpUrl: "http://127.0.0.1:1/mcp", tracesDir, env: stubEnv,
      textToSql: {
        listTables: async () => [
          { name: "orders", schema: "public", description: "Orders" },
        ],
        semanticSearch: async () => [],
        intentModel: {
          invoke: async () => ({ content: JSON.stringify(intentPayload) }),
          async *stream() {
            yield { content: JSON.stringify(intentPayload) };
          },
          withStructuredOutput: () => ({
            invoke: async () => intentPayload,
          }),
        } as never,
      },
      routes: { "text-to-sql": async (state, rt) => {
        calls++;
        expect(state.answerText).toBe("");
        expect(state.tablesUsed).toEqual([]);
        expect(state.budget.llmCalls).toBe(1);
        expect(state.telemetry.promptTokens).toBe(0);
        rt.emit({ node: "understand", type: "node_done", durationMs: 1, payload: { sql: "SELECT 1", tablesUsed: ["unauthorized_table"] } });
        return { status: "cannot_answer", answerText: "Stopped", tablesUsed: ["stale_table"], budget: { llmCalls: 20 }, telemetry: { promptTokens: 42 } };
      } },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    const ask = async (threadId?: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q", persona: "sales_south", ...(threadId ? { threadId } : {}) }),
      });
      return parseSse(await response.text());
    };
    try {
      const first = await ask();
      const proposal = first.find((block) => block.event === "sql_generated");
      expect(proposal?.data["data"]).toEqual({ statementType: "SELECT", tablesUsed: [] });
      const threadId = first[0]!.data["threadId"] as string;
      const second = await ask(threadId);
      expect(calls).toBe(2);
      expect(second[0]!.data["threadId"]).toBe(threadId);
      expect(second.some((block) => block.event === "completed")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("ignores a stale ucId body field and routes a plain question to text-to-sql", async () => {
    let textToSqlCalls = 0;
    let rcaCalls = 0;
    const app = buildApp({
      checkpointer: new MemorySaver(), mcpUrl: "http://127.0.0.1:1/mcp", tracesDir, env: stubEnv,
      routes: {
        "text-to-sql": async () => { textToSqlCalls += 1; return { status: "ok", answerText: "sql answer" }; },
        "root-cause-analysis": async () => { rcaCalls += 1; return { status: "ok", answerText: "rca answer" }; },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "How many orders do we have per status?", persona: "sales_south", ucId: "root-cause-analysis" }),
      });
      expect(response.status).toBe(200);
      const blocks = parseSse(await response.text());
      const completed = blocks.find((block) => block.event === "completed");
      expect((completed?.data["data"] as { answerText?: string }).answerText).toBe("sql answer");
      expect(textToSqlCalls).toBe(1);
      expect(rcaCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("withholds sensitive SQL even after a successful query", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = buildApp({
      checkpointer: new MemorySaver(), mcpUrl: "http://127.0.0.1:1/mcp", tracesDir, env: stubEnv,
      routes: { "text-to-sql": async (_state, rt) => {
        rt.emit({ node: "understand", type: "node_done", durationMs: 1, payload: { sql: "SELECT secret FROM orders WHERE phone = '0901111111'", tablesUsed: ["orders"] } });
        rt.emit({ node: "describe", type: "tool_call", durationMs: 1, payload: { tool: "list_tables", tables: ["orders"] } });
        rt.emit({ node: "run", type: "tool_call", durationMs: 1, payload: { tool: "run_query", ok: true } });
        await gate;
        return { status: "ok", answerText: "done" };
      } },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "q", persona: "sales_south" }), signal: AbortSignal.timeout(5000),
      });
      const reader = response.body!.getReader();
      let streamed = "";
      while (!streamed.includes("event: query_running")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended before query progress");
        streamed += new TextDecoder().decode(chunk.value);
      }
      expect(streamed).toContain("event: sql_generated");
      expect(streamed).toContain("event: schema_retrieved");
      expect(streamed).not.toContain("completed");
      expect(streamed).not.toContain("0901111111");
      expect(streamed).not.toContain("SELECT secret");
      while (!streamed.includes('"withheld":true')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended before SQL display verdict");
        streamed += new TextDecoder().decode(chunk.value);
      }
      expect(streamed).not.toContain("0901111111");
      release();
      await reader.cancel();
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams allowlisted schema-validated SSE with minted chat ids", async () => {
    const proposalSql =
      "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status";
    const app = buildApp({
      checkpointer: new MemorySaver(), mcpUrl: "http://127.0.0.1:1/mcp", tracesDir, env: stubEnv,
      routes: { "text-to-sql": async (_state, rt) => {
        rt.emit({ node: "understand", type: "node_done", durationMs: 1, payload: { sql: proposalSql, tablesUsed: ["orders"] } });
        rt.emit({ node: "describe", type: "tool_call", durationMs: 1, payload: { tool: "list_tables", tables: ["orders"] } });
        rt.emit({ node: "run", type: "tool_call", durationMs: 1, payload: { tool: "run_query", ok: true } });
        return {
          status: "ok",
          answerText: "3 status groups, 12 orders: cancelled=2, completed=7, pending=3",
          toolsCalled: ["list_tables", "run_query"],
          columns: ["status", "n"],
          resultPreview: [
            { status: "cancelled", n: 2 },
            { status: "completed", n: 7 },
            { status: "pending", n: 3 },
          ],
        };
      } },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "How many orders do we have per status?", persona: "sales_south" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-run-id")).toMatch(/^[0-9a-f-]{36}$/);
      const text = await response.text();
      const blocks = parseSse(text);
      expect(blocks.map((b) => b.event)).toEqual([
        "intent_parsed",
        "sql_generated",
        "schema_retrieved",
        "query_running",
        "sql_generated",
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
      expect(response.headers.get("x-run-id")).toBe(runId);
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
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

  it("sends the literal-free SQL proposal only after the gateway succeeds, without row values or tokens", async () => {
    const proposalSql =
      "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status";
    const app = buildApp({
      checkpointer: new MemorySaver(), mcpUrl: "http://127.0.0.1:1/mcp", tracesDir, env: stubEnv,
      routes: { "text-to-sql": async (_state, rt) => {
        rt.emit({ node: "understand", type: "node_done", durationMs: 1, payload: { sql: proposalSql, tablesUsed: ["orders"] } });
        rt.emit({ node: "describe", type: "tool_call", durationMs: 1, payload: { tool: "list_tables", tables: ["orders"] } });
        rt.emit({ node: "run", type: "tool_call", durationMs: 1, payload: { tool: "run_query", ok: true } });
        return { status: "ok", answerText: "3 status groups, 12 orders" };
      } },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "How many orders do we have per status?", persona: "hr" }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const phone of SEED_PHONES) {
        expect(text).not.toContain(phone);
      }
      expect(text).not.toContain(SEED_EMAIL);
      expect(text).not.toContain("MASKED_PHONE");
      const blocks = parseSse(text);
      const sqlEvent = blocks.find((block) => block.event === "sql_generated" && (block.data["data"] as Record<string, unknown>)?.["phase"] === "display");
      expect(sqlEvent?.data["data"]).toMatchObject({ sql: proposalSql });
      expect(blocks.findIndex((block) => block === sqlEvent)).toBeGreaterThan(blocks.findIndex((block) => block.event === "query_running"));
      expect(text).not.toContain("stub-hr");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function reindexCall(
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json?: unknown }> {
    const res = await fetch(`${apiBase}/api/semantic/reindex`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  it("rejects missing or unknown persona with 400", async () => {
    const missing = await reindexCall({});
    expect(missing.status).toBe(400);
    expect(missing.json).toMatchObject({ code: "INVALID_PARAMS" });
    for (const persona of ["root", "admin", "default", ""]) {
      const out = await reindexCall({ persona });
      expect(out.status).toBe(400);
      expect(out.json).toMatchObject({ code: "INVALID_PARAMS" });
    }
  });

  it("rejects non-data_admin personas with 403", async () => {
    for (const persona of ["sales_south", "marketing", "hr"]) {
      const out = await reindexCall({ persona });
      expect(out.status).toBe(403);
      expect(out.json).toMatchObject({ code: "SCOPE_DENIED" });
    }
  });

  it("succeeds for data_admin with reindex counts", async () => {
    const out = await reindexCall({ persona: "data_admin" });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ added: 1, updated: 2, skipped: 15, deleted: 0 });
  });
  it("wires createRetrieveSemantic into buildApp by default and records search_semantic_layer spans", async () => {
    const localTraces = mkdtempSync(path.join(tmpdir(), "fullhost-semantic-"));
    const mcpCalls: string[] = [];
    let observedChunks: string[] = [];
    let localMcp: Server | null = null;
    const mcpServer = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = (await readBody(req)) as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string; name?: string };
      };
      if (body.method === "initialize") {
        sse(res, body.id ?? 0, {
          protocolVersion: body.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-semantic", version: "0" },
        });
        return;
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body.method === "tools/call") {
        const toolName = body.params?.name ?? "";
        mcpCalls.push(toolName);
        const payload =
          toolName === "search_semantic_layer"
            ? {
                chunks: [
                  {
                    chunkId: "metric:net_revenue",
                    docType: "metric",
                    table: "order_items",
                    tables: ["orders", "order_items"],
                    metricName: "net_revenue",
                    content: "Metric net_revenue (Doanh thu thuần)",
                    score: 0.94,
                    aliasMatched: true,
                    denseScore: 0.92,
                  },
                ],
              }
            : toolName === "list_tables"
              ? { tables: [{ name: "orders", schema: "public", columns: [] }] }
              : {};
        sse(res, body.id ?? 0, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        });
        return;
      }
      res.writeHead(400);
      res.end();
    });

    await new Promise<void>((resolve) => {
      localMcp = mcpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const mcpAddress = localMcp!.address() as AddressInfo;
    const intentPayload = {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
      queryMode: "standard_query" as const,
    };
    const app = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: `http://127.0.0.1:${mcpAddress.port}/mcp`,
      tracesDir: localTraces,
      env: stubEnv,
      textToSql: {
        intentModel: {
          invoke: async () => ({ content: JSON.stringify(intentPayload) }),
          async *stream() {
            yield { content: JSON.stringify(intentPayload) };
          },
          withStructuredOutput: () => ({
            invoke: async () => intentPayload,
          }),
        } as never,
      },
      routes: {
        "text-to-sql": async (state) => {
          observedChunks = state.semanticChunks.map((c) => c.chunkId);
          return { status: "ok", answerText: "probed" };
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const apiPort = (server.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Doanh thu thuần tháng 8?",
          persona: "sales_south",
        }),
      });
      expect(res.status).toBe(200);
      const blocks = parseSse(await res.text());
      const runId = blocks[0]!.data["runId"] as string;
      expect(mcpCalls).toContain("search_semantic_layer");
      expect(observedChunks).toEqual(["metric:net_revenue"]);
      const traceEvents = readFileSync(path.join(localTraces, `${runId}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; payload?: { tool?: string } });
      expect(
        traceEvents.some(
          (e) => e.type === "tool_call" && e.payload?.tool === "search_semantic_layer",
        ),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => {
        if (localMcp) localMcp.close(() => resolve());
        else resolve();
      });
    }
  });

  it("fails if production or live-eval root graph builders omit the retrieve seam", () => {
    const apiSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const evalSrc = readFileSync(new URL("../../../evals/run.ts", import.meta.url), "utf8");

    expect(apiSrc).toMatch(/createRetrieveSemantic/);
    expect(apiSrc).toMatch(/buildRootGraph\(\{[\s\S]*?\bretrieve\s*:/);

    expect(evalSrc).toMatch(/createRetrieveSemantic/);
    expect(evalSrc).toMatch(/buildRootGraph\(\{[\s\S]*?\bretrieve\s*:/);
    expect(evalSrc).toMatch(/buildEvalGraph\(/);
  });

  it("propagates RATE_LIMITED without downgrading to INTERNAL_ERROR on SSE failed events", async () => {
    const app = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: "http://127.0.0.1:1/mcp",
      tracesDir,
      env: stubEnv,
      routes: {
        "text-to-sql": async () => {
          throw new ModelRetryError({
            message: "RATE_LIMITED: model provider rate limit (HTTP 429) after 4 attempt(s)",
            status: 429,
            attempts: 4,
            reason: "max_retries_exhausted",
          });
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "How many orders?", persona: "sales_south" }),
      });
      const blocks = parseSse(await response.text());
      const failed = blocks.find((b) => b.event === "failed");
      expect(failed).toBeDefined();
      expect(failed?.data["data"]).toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
        repairable: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("routes a normal /api/ask question to textToSql by default with PII redaction", async () => {
    let searchCalls = 0;
    const intentPayload = {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: ["customers"],
      queryMode: "standard_query" as const,
    };
    const app = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: "http://127.0.0.1:1/mcp",
      tracesDir,
      env: stubEnv,
      textToSql: {
        listTables: async () => [
          { name: "customers", schema: "public", description: "Customer directory" },
        ],
        semanticSearch: async () => {
          searchCalls += 1;
          return [
            {
              chunkId: "table:customers",
              docType: "table",
              table: "customers",
              tables: ["customers"],
              metricName: null,
              content: "Customer directory",
              score: 0.9,
              aliasMatched: true,
            },
          ];
        },
        intentModel: {
          invoke: async () => ({ content: JSON.stringify(intentPayload) }),
          async *stream() {
            yield { content: JSON.stringify(intentPayload) };
          },
          withStructuredOutput: () => ({
            invoke: async () => intentPayload,
          }),
        } as never,
        executor: {
          run: async (input) => ({
            status: "ok",
            sql: "SELECT name, contact FROM public.customers LIMIT 5",
            tablesUsed: input.candidateTables,
            columns: ["name", "contact"],
            rows: [{ name: "An Nguyen", contact: `${SEED_PHONES[0]} / ${SEED_EMAIL}` }],
            maskedColumns: [],
            attempts: 1,
          }),
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "List customer names",
          persona: "sales_south",
        }),
      });
      const raw = await response.text();
      expect(raw).not.toContain(SEED_PHONES[0]);
      expect(raw).not.toContain(SEED_EMAIL);
      const blocks = parseSse(raw);
      const completed = blocks.find((b) => b.event === "completed");
      expect(completed).toBeDefined();
      expect(searchCalls).toBe(1);
      const answer = completed?.data["data"] as { status?: string; answerText?: string } | undefined;
      expect(answer?.status).toBe("ok");
      expect(answer?.answerText).toContain("An Nguyen");
      expect(answer?.answerText).not.toContain(SEED_PHONES[0]);
      expect(answer?.answerText).not.toContain(SEED_EMAIL);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("supports HITL interrupt_waiting and /api/runs/:runId/resume for unmapped table entities", async () => {
    const intentPayload = {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: ["orders", "kênh bán"],
      queryMode: "standard_query" as const,
    };
    const app = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: "http://127.0.0.1:1/mcp",
      tracesDir,
      env: stubEnv,
      textToSql: {
        listTables: async () => [
          { name: "orders", schema: "public", description: "Orders" },
          { name: "channels", schema: "public", description: "Channels" },
        ],
        semanticSearch: async () => [],
        intentModel: {
          invoke: async () => ({ content: JSON.stringify(intentPayload) }),
          async *stream() {
            yield { content: JSON.stringify(intentPayload) };
          },
          withStructuredOutput: () => ({
            invoke: async () => intentPayload,
          }),
        } as never,
        executor: {
          run: async (input) => ({
            status: "ok",
            sql: "SELECT c.channel_name, COUNT(*) AS cnt FROM public.orders o JOIN public.channels c ON c.channel_id = o.channel_id GROUP BY c.channel_name",
            tablesUsed: input.candidateTables,
            columns: ["channel_name", "cnt"],
            rows: [{ channel_name: "Website", cnt: 4 }],
            maskedColumns: [],
            attempts: 1,
          }),
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address() as AddressInfo;
    try {
      const askRes = await fetch(`http://127.0.0.1:${address.port}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Số đơn theo kênh bán",
          persona: "sales_south",
        }),
      });
      const askBlocks = parseSse(await askRes.text());
      const waiting = askBlocks.find((b) => b.event === "interrupt_waiting");
      expect(waiting).toBeDefined();
      const pending = (waiting?.data["data"] as { pendingClarification?: { field?: string; options?: string[] } })?.pendingClarification;
      expect(pending?.field).toBe("table");
      expect(pending?.options).toContain("channels");

      const runId = waiting?.data["runId"] as string;
      const resumeRes = await fetch(`http://127.0.0.1:${address.port}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "channels" }),
      });
      expect(resumeRes.status).toBe(200);
      const resumeBlocks = parseSse(await resumeRes.text());
      const completed = resumeBlocks.find((b) => b.event === "completed");
      const answer = completed?.data["data"] as { status?: string; answerText?: string } | undefined;
      expect(answer?.status).toBe("ok");
      expect(answer?.answerText).toContain("Website");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
