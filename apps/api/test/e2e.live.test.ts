// Thin live e2e proof (API-03, 01-14): a real agent run on the loaded DB
// calling at least list_tables then run_query with an ok answer, allowlisted
// SSE free of PII and cell values, and a full redacted trace on disk.
//
// Skip-if-no-DB gating per D-21: without HARNESS_STATE_DATABASE_URL plus
// the MCP/agent DB URLs the file skips green. When the URLs exist the test
// boots the real 01-08 MCP gateway as a child (same shape as demo-tracer)
// and the real buildApp in-process with the 01-13 ports. Assertions are
// scale-agnostic (positive live counts, never hard-coded) so the proof holds
// on small and full volumes alike.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { createHostPorts } from "../src/ports.js";
import { SSE_ALLOWLIST } from "../src/sse.js";

const HARNESS_URL = process.env["HARNESS_STATE_DATABASE_URL"] ?? "";
const AGENT_RO_URL = process.env["AGENT_RO_DATABASE_URL"] ?? "";
const SALES_TOKEN = process.env["MCP_TOKEN_SALES_SOUTH"] ?? "";
const ADMIN_TOKEN = process.env["MCP_TOKEN_ADMIN"] ?? "";
const LIVE = HARNESS_URL.length > 0 && AGENT_RO_URL.length > 0 && SALES_TOKEN.length > 0;

const DEMO_QUESTION = "How many orders do we have per status?";
const GATEWAY_PORT = 18081;

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

describe.skipIf(!LIVE)("live e2e on the loaded DB", () => {
  let gateway: ChildProcess | null = null;
  let apiBase = "";
  let apiServer: { close: (cb?: () => void) => void } | null = null;
  let tracesDir = "";
  let gatewayStderr = "";
  const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}/mcp`;

  async function waitFor(url: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timed out waiting for ${url}: ${gatewayStderr.slice(-1000)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function mcpCall(
    tool: string,
    args: Record<string, unknown>,
    runId: string,
    token: string,
  ): Promise<unknown> {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "x-run-id": runId,
    };
    const rpc = async (payload: unknown): Promise<string> => {
      const res = await fetch(gatewayUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      return res.text();
    };
    const pull = (text: string): unknown => {
      const match = /^data: ([\s\S]+)$/m.exec(text);
      if (!match) throw new Error(`unexpected MCP response: ${text.slice(0, 200)}`);
      return JSON.parse(match[1]);
    };
    await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    });
    await fetch(gatewayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const out = (await pull(
      await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }),
    )) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    if (out.result?.isError === true) {
      throw new Error(`MCP tool ${tool} failed`);
    }
    return JSON.parse((out.result?.content ?? []).map((b) => b.text ?? "").join(""));
  }

  beforeAll(async () => {
    tracesDir = mkdtempSync(path.join(tmpdir(), "fullhost-e2e-"));
    // Repo root anchored from this file: the gateway resolves its yaml,
    // semantic docs, and audit paths relative to cwd (same as demo-tracer).
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    gateway = spawn("node", ["--import", "tsx", "packages/mcp-server/src/server.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MCP_PORT: String(GATEWAY_PORT),
        AGENT_RO_DATABASE_URL: AGENT_RO_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stderr?.on("data", (chunk) => {
      gatewayStderr += String(chunk);
    });
    await waitFor(`http://127.0.0.1:${GATEWAY_PORT}/healthz`, 60_000);

    const ports = await createHostPorts();
    const app = buildApp({
      checkpointer: ports.checkpointer,
      store: ports.store,
      mcpUrl: gatewayUrl,
      tracesDir,
    });
    await new Promise<void>((resolve) => {
      apiServer = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (apiServer as unknown as { address: () => { port: number } }).address();
    apiBase = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (apiServer) apiServer.close(() => resolve());
      else resolve();
    });
    if (gateway) {
      gateway.kill();
      gateway = null;
    }
  });

  it("runs the demo question end to end with redacted trace and clean SSE", async () => {
    // Live PII literals for the leak assertions: real phone/email cells
    // fetched through the pipeline as admin (never through the SSE path).
    const probe = (await mcpCall(
      "run_query",
      { sql: "SELECT phone, email FROM public.customers LIMIT 5", maxRows: 5 },
      "e2e-probe",
      ADMIN_TOKEN,
    )) as { rows?: Record<string, unknown>[] };
    const liveLiterals = (probe.rows ?? []).flatMap((row) =>
      [row["phone"], row["email"]].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    );
    expect(liveLiterals.length).toBeGreaterThan(0);

    const res = await fetch(`${apiBase}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: DEMO_QUESTION, persona: "sales_south" }),
    });
    expect(res.status).toBe(200);
    const sseText = await res.text();
    const blocks = parseSse(sseText);
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      expect([...SSE_ALLOWLIST] as string[]).toContain(block.event);
    }
    const completed = blocks[blocks.length - 1].data["data"] as {
      status: string;
      toolsCalled: string[];
      total: number;
    };
    expect(completed.status).toBe("ok");
    expect(completed.total).toBeGreaterThan(0);

    const runId = blocks[0].data["runId"] as string;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    // Trace proof: full redacted event log with tool spans in call order.
    const tracePath = `${tracesDir}/${runId}.jsonl`;
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(lines.length).toBe(7);
    const tools: string[] = [];
    for (const line of lines) {
      const event = JSON.parse(line) as {
        runId?: string;
        threadId?: string;
        spanId?: string;
        type?: string;
        payload?: { tool?: string };
      };
      expect(event.runId).toBe(runId);
      expect(typeof event.threadId).toBe("string");
      expect(typeof event.spanId).toBe("string");
      expect(/0\d{9}/.test(line)).toBe(false);
      expect(/\S+@\S+\.\S+/.test(line)).toBe(false);
      if (event.type === "tool_call" && event.payload?.tool) {
        tools.push(event.payload.tool);
      }
    }
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools[0]).toBe("list_tables");
    expect(tools).toContain("run_query");
    expect(completed.toolsCalled).toEqual(tools);

    // SSE proof: no seed PII shapes, no live row cell value, no token.
    expect(/0\d{9}/.test(sseText)).toBe(false);
    expect(/\S+@\S+\.\S+/.test(sseText)).toBe(false);
    for (const literal of liveLiterals) {
      expect(sseText).not.toContain(literal);
    }
    expect(sseText).not.toContain(SALES_TOKEN);
    expect(sseText).not.toContain("COUNT(*)");
    expect(sseText).not.toContain("GROUP BY");
  }, 120_000);
});
