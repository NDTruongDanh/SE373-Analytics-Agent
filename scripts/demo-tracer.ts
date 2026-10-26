// pnpm demo:tracer — one-command proof for the 27/10 course checkpoint.
// Orchestrates, in order: compose up -d, agent_ro connectivity poll, spawn
// the MCP server and API as child processes on their tracer ports, POST
// /api/ask over SSE, assert tools called list_tables -> run_query, assert
// answer status ok with 12 orders across 3 status groups, assert the trace
// file exists with span fields and none of the seed PII literals, print the
// exact expected block with the real runId substituted, stop the children,
// exit 0 on success or 1 with the failing assertion on stdout.
// TRACER scaffolding: the eval CLI (01-09) and e2e harness (01-15) replace it.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";

process.loadEnvFile();

const ROOT = process.cwd();
const MCP_PORT = Number(process.env.MCP_PORT ?? 8081);
const API_PORT = Number(process.env.API_PORT ?? 3001);
const TOKEN = process.env.MCP_TRACER_TOKEN ?? "";
const AGENT_RO_URL = process.env.AGENT_RO_DATABASE_URL ?? "";
const QUESTION = "How many orders do we have per status?";
const SEED_PHONES = ["0901111111", "0902222222", "0903333333", "0904444444", "0905555555"];
const SEED_EMAILS = [
  "an.nguyen@example.vn",
  "bich.tran@example.vn",
  "cuong.le@example.vn",
  "dung.pham@example.vn",
  "em.hoang@example.vn",
];

function fail(message: string): never {
  console.log(`[demo:tracer] FAIL: ${message}`);
  process.exit(1);
}

function tcpReady(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs).unref?.();
  });
}

async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) {
      fail(`${label} not ready within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

interface SseBlock {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseBlock[] {
  const blocks: SseBlock[] = [];
  for (const chunk of text.split("\n\n")) {
    const event = /event: ([^\n]+)/.exec(chunk)?.[1].trim();
    const data = /data: ([\s\S]+)/.exec(chunk)?.[1];
    if (event && data) {
      blocks.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  return blocks;
}

async function mcpRpc(payload: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const match = /^data: ([\s\S]+)$/m.exec(text);
  if (!match) {
    throw new Error(`unexpected MCP response HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(match[1]);
}

async function mcpCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const init = (await mcpRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "demo", version: "0" } },
  })) as { result?: { protocolVersion?: string } };
  void init;
  await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const out = (await mcpRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: args },
  })) as { result?: { content?: { text?: string }[] } };
  const text = (out.result?.content ?? []).map((b) => b.text ?? "").join("");
  return JSON.parse(text);
}

function startChild(name: string, script: string, env: Record<string, string>): ChildProcess {
  const child = spawn("node", ["--import", "tsx", script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null && !shuttingDown) {
      console.log(`[demo:tracer] child ${name} exited with code ${code}:\n${stderr.slice(-2000)}`);
    }
  });
  void stderr;
  return child;
}

let shuttingDown = false;

async function main(): Promise<void> {
  if (!TOKEN) fail("MCP_TRACER_TOKEN is not set (copy .env.example to .env and fill it)");
  if (!AGENT_RO_URL) fail("AGENT_RO_DATABASE_URL is not set");

  const up = spawnSync("docker", ["compose", "-f", "docker/docker-compose.yml", "up", "-d"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (up.status !== 0) {
    fail(`docker compose up -d failed: ${(up.stderr || up.stdout).slice(0, 500)}`);
  }

  await waitFor("db", () => tcpReady("127.0.0.1", 5433, 1000), 90_000);

  const mcp = startChild("mcp", "packages/mcp-server/src/server.ts", {
    MCP_PORT: String(MCP_PORT),
    MCP_TRACER_TOKEN: TOKEN,
    AGENT_RO_DATABASE_URL: AGENT_RO_URL,
  });
  await waitFor("mcp", () => httpOk(`http://127.0.0.1:${MCP_PORT}/healthz`), 60_000);

  // Line 2 proof: exactly the 2 tracer tools (stateless: no session needed).
  const listed = (await mcpRpc({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/list",
    params: {},
  })) as { result?: { tools?: { name?: string }[] } };
  const toolNames: string[] = (listed.result?.tools ?? []).map((t) => t.name ?? "");
  if (JSON.stringify(toolNames) !== JSON.stringify(["list_tables", "run_query"])) {
    fail(`unexpected tool list: ${JSON.stringify(toolNames)}`);
  }

  // Line 1 proof: seed counts straight from the agent_ro path.
  const customers = (await mcpCall("run_query", {
    sql: "SELECT count(*) AS n FROM public.customers",
  })) as { rows?: { n?: string }[] };
  const orders = (await mcpCall("run_query", {
    sql: "SELECT count(*) AS n FROM public.orders",
  })) as { rows?: { n?: string }[] };
  const customerCount = Number(customers.rows?.[0]?.n ?? "-1");
  const orderCount = Number(orders.rows?.[0]?.n ?? "-1");
  if (customerCount !== 5 || orderCount !== 12) {
    fail(`unexpected seed counts: ${customerCount} customers, ${orderCount} orders`);
  }

  const api = startChild("api", "apps/api/src/index.ts", {
    API_PORT: String(API_PORT),
    MCP_PORT: String(MCP_PORT),
    MCP_URL: `http://127.0.0.1:${MCP_PORT}/mcp`,
    MCP_TRACER_TOKEN: TOKEN,
    TRACES_DIR: "traces",
  });
  await waitFor("api", () => httpOk(`http://127.0.0.1:${API_PORT}/healthz`), 60_000);

  const askRes = await fetch(`http://127.0.0.1:${API_PORT}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: QUESTION, persona: "sales_south" }),
  });
  if (!askRes.ok) {
    fail(`POST /api/ask returned HTTP ${askRes.status}`);
  }
  const blocks = parseSse(await askRes.text());
  const events = blocks.map((b) => b.event);
  const expected = ["intent_parsed", "schema_retrieved", "sql_generated", "query_running", "completed"];
  if (JSON.stringify(events) !== JSON.stringify(expected)) {
    fail(`unexpected SSE event sequence: ${events.join(",")}`);
  }
  const completed = blocks[blocks.length - 1].data["data"] as {
    status?: string;
    answerText?: string;
    toolsCalled?: string[];
    total?: number;
  };
  if (JSON.stringify(completed.toolsCalled) !== JSON.stringify(["list_tables", "run_query"])) {
    fail(`unexpected tools called: ${JSON.stringify(completed.toolsCalled)}`);
  }
  const runId = String(blocks[0].data["runId"] ?? "");
  if (!runId) {
    fail("SSE blocks carry no runId");
  }
  if (completed.status !== "ok" || completed.total !== 12) {
    fail(`unexpected answer: status=${completed.status} total=${completed.total}`);
  }
  const answerText = String(completed.answerText ?? "");
  if (!answerText.includes("3 status groups") || !answerText.includes("12 orders")) {
    fail(`answer text mismatch: ${answerText.slice(0, 120)}`);
  }

  // Line 5 proof: the committed trace file, span-linked and PII-clean.
  const tracePath = `traces/${runId}.jsonl`;
  if (!existsSync(tracePath)) {
    fail(`trace file missing: ${tracePath}`);
  }
  const lines = readFileSync(tracePath, "utf8").trim().split("\n");
  if (lines.length !== 7) {
    fail(`trace has ${lines.length} events, expected 7`);
  }
  for (const line of lines) {
    const event = JSON.parse(line) as { spanId?: string; runId?: string };
    if (!event.spanId || event.runId !== runId) {
      fail("trace event missing span fields or runId");
    }
  }
  const traceText = lines.join("\n");
  for (const literal of [...SEED_PHONES, ...SEED_EMAILS]) {
    if (traceText.includes(literal)) {
      fail(`trace leaks seed PII: ${literal.slice(0, 4)}...`);
    }
  }

  console.log(`[demo:tracer] db ready: chosen @ 127.0.0.1:5433 (seed: 5 customers, 12 orders)`);
  console.log(`[demo:tracer] mcp ready: ${toolNames.length} tools (${toolNames.join(", ")})`);
  console.log(`[demo:tracer] tools called: list_tables -> run_query`);
  console.log(`[demo:tracer] answer: ok (3 status groups, 12 orders)`);
  console.log(`[demo:tracer] trace: ${tracePath} (7 events, PII clean)`);
  console.log(`[demo:tracer] PASS`);

  shuttingDown = true;
  mcp.kill();
  api.kill();
}

await main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
