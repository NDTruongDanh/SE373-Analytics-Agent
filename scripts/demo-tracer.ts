// pnpm demo:tracer — one-command proof for the 27/10 course checkpoint.
// Orchestrates, in order: compose up -d, agent_ro connectivity poll, boot
// the full MCP gateway, probe the loaded volume (empty volume seeds small),
// data:verify, spawn the thin API as a child, POST /api/ask over SSE,
// assert tools called list_tables -> run_query, assert answer status ok
// with live per-status order counts, assert the trace file exists with span
// fields and no raw PII, print the six-line block, stop the children, exit
// 0 on success or 1 with the failing assertion on stdout.
//
// The MCP legs run through the real fixed 7-stage pipeline (auth → scope →
// zod → sqlGuard → AccessPolicy → executor → PII scan + audit) with bearer
// tokens from policies/mcp_clients.yaml — no TRACER shortcuts remain.
// Counts are scale-aware (asserted positive live, never hard-coded);
// data:verify pins the loaded volume to the seed manifest without the demo
// itself naming any seed file.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { redactPII } from "@se373/access-policy";

process.loadEnvFile();

const ROOT = process.cwd();
const MCP_PORT = Number(process.env.MCP_PORT ?? 8081);
const API_PORT = Number(process.env.API_PORT ?? 3001);
const TOKEN = process.env.MCP_TOKEN_SALES_SOUTH ?? "";
const ADMIN_TOKEN = process.env.MCP_TOKEN_ADMIN ?? "";
const AGENT_RO_URL = process.env.AGENT_RO_DATABASE_URL ?? "";
const QUESTION = "How many orders do we have per status?";

const EXPECTED_TOOLS = [
  "list_tables",
  "describe_table",
  "explain_query",
  "run_query",
  "sample_rows",
  "search_semantic_layer",
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

function mcpHeaders(runId: string, token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "x-run-id": runId,
  };
}

async function mcpRpc(payload: unknown, runId: string, token: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: mcpHeaders(runId, token),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const match = /^data: ([\s\S]+)$/m.exec(text);
  if (!match) {
    throw new Error(`unexpected MCP response HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(match[1]);
}

async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
  runId: string,
  token: string,
): Promise<unknown> {
  const init = (await mcpRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "demo", version: "0" } },
    },
    runId,
    token,
  )) as { result?: { protocolVersion?: string } };
  void init;
  await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: mcpHeaders(runId, token),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const out = (await mcpRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
    runId,
    token,
  )) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  if (out.result?.isError === true) {
    const text = (out.result.content ?? []).map((b) => b.text ?? "").join("");
    throw new Error(`MCP tool ${tool} failed: ${text.slice(0, 200)}`);
  }
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

function runRootScript(label: string, args: string[]): void {
  const out = spawnSync("pnpm", args, { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) {
    fail(`${label} failed: ${(out.stderr || out.stdout).slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  if (!TOKEN) fail("MCP_TOKEN_SALES_SOUTH is not set (copy .env.example to .env and fill it)");
  if (!ADMIN_TOKEN) fail("MCP_TOKEN_ADMIN is not set (copy .env.example to .env and fill it)");
  if (!AGENT_RO_URL) fail("AGENT_RO_DATABASE_URL is not set");

  const up = spawnSync("docker", ["compose", "-f", "docker/docker-compose.yml", "up", "-d"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (up.status !== 0) {
    fail(`docker compose up -d failed: ${(up.stderr || up.stdout).slice(0, 500)}`);
  }

  await waitFor("db", () => tcpReady("127.0.0.1", 5433, 1000), 90_000);

  // Scale-aware readiness without touching seed files: probe the loaded
  // volume through the pipeline (empty volume seeds small, loaded volume
  // just verifies). data:verify is the manifest-backed health check — it
  // exits non-zero unless counts, FKs and seed signals match the manifest.
  const mcp = startChild("mcp", "packages/mcp-server/src/server.ts", {
    MCP_PORT: String(MCP_PORT),
    AGENT_RO_DATABASE_URL: AGENT_RO_URL,
  });
  await waitFor("mcp", () => httpOk(`http://127.0.0.1:${MCP_PORT}/healthz`), 60_000);

  const probe = (await mcpCall(
    "run_query",
    { sql: "SELECT count(*) AS n FROM public.orders" },
    "demo-direct-probe",
    ADMIN_TOKEN,
  )) as { rows?: { n?: string }[] };
  if (Number(probe.rows?.[0]?.n ?? "0") === 0) {
    runRootScript("data:load --scale=small", ["data:load", "--scale=small"]);
  }
  runRootScript("data:verify", ["data:verify"]);

  // Tool surface proof: the 6 gateway tools through the real pipeline, as
  // the scoped sales principal.
  const listed = (await mcpRpc(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/list",
      params: {},
    },
    "demo-direct-tools",
    TOKEN,
  )) as { result?: { tools?: { name?: string }[] } };
  const toolNames: string[] = (listed.result?.tools ?? []).map((t) => t.name ?? "");
  if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
    fail(`unexpected tool list: ${JSON.stringify(toolNames)}`);
  }

  // Live totals through the real pipeline with the admin token (no
  // row-scope, so totals match the verified load): each direct call carries
  // its own X-Run-Id so the audit trail proves per-call propagation. The
  // sales-scoped agent flow below exercises the row-scope path instead.
  // Scale gate: totals must be positive (never hard-coded) and data:verify
  // above already pinned them to the manifest.
  const customers = (await mcpCall(
    "run_query",
    { sql: "SELECT count(*) AS n FROM public.customers" },
    "demo-direct-customers",
    ADMIN_TOKEN,
  )) as { rows?: { n?: string }[] };
  const orders = (await mcpCall(
    "run_query",
    { sql: "SELECT count(*) AS n FROM public.orders" },
    "demo-direct-orders",
    ADMIN_TOKEN,
  )) as { rows?: { n?: string }[] };
  const groups = (await mcpCall(
    "run_query",
    { sql: "SELECT count(*) AS n FROM (SELECT DISTINCT status FROM public.orders) s" },
    "demo-direct-groups",
    ADMIN_TOKEN,
  )) as { rows?: { n?: string }[] };
  const customerCount = Number(customers.rows?.[0]?.n ?? "0");
  const orderCount = Number(orders.rows?.[0]?.n ?? "0");
  const statusGroups = Number(groups.rows?.[0]?.n ?? "0");
  if (customerCount <= 0 || orderCount <= 0 || statusGroups <= 0) {
    fail(`unexpected live counts: ${customerCount} customers, ${orderCount} orders, ${statusGroups} status groups`);
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
  if (completed.status !== "ok" || completed.total !== orderCount) {
    fail(`unexpected answer: status=${completed.status} total=${completed.total} (live orders=${orderCount})`);
  }
  const answerText = String(completed.answerText ?? "");
  if (!answerText.includes(`${statusGroups} status groups`) || !answerText.includes(`${orderCount} orders`)) {
    fail(`answer text mismatch: ${answerText.slice(0, 120)}`);
  }

  // Trace proof: the committed trace file, span-linked and PII-clean.
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
    if (redactPII(line).hit) {
      fail("trace leaks PII (redactor hit on a trace line)");
    }
  }

  // Audit proof: per-call X-Run-Id propagation plus redaction, traced by run.
  if (!existsSync("logs/mcp_audit.jsonl")) {
    fail("audit file missing: logs/mcp_audit.jsonl");
  }
  const auditLines = readFileSync("logs/mcp_audit.jsonl", "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const forRun = (id: string): Record<string, unknown>[] =>
    auditLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry["runId"] === id);
  for (const directId of ["demo-direct-customers", "demo-direct-orders", "demo-direct-groups"]) {
    if (forRun(directId).length === 0) {
      fail(`no audit line for direct call ${directId} (X-Run-Id propagation broken)`);
    }
  }
  const runAudits = forRun(runId);
  if (runAudits.length < 2) {
    fail(`expected >=2 audit lines for run ${runId}, got ${runAudits.length}`);
  }
  const auditedTools = runAudits.map((entry) => entry["tool"]).sort();
  if (JSON.stringify(auditedTools) !== JSON.stringify(["list_tables", "run_query"])) {
    fail(`unexpected audited tools for run: ${JSON.stringify(auditedTools)}`);
  }
  for (const line of auditLines.slice(-20)) {
    if (redactPII(line).hit) {
      fail("audit leaks PII (redactor hit on an audit line)");
    }
  }

  console.log(`[demo:tracer] db ready: chosen @ 127.0.0.1:5433 (verified load: ${customerCount} customers, ${orderCount} orders)`);
  console.log(`[demo:tracer] mcp ready: ${toolNames.length} tools (${toolNames.join(", ")})`);
  console.log(`[demo:tracer] tools called: list_tables -> run_query`);
  console.log(`[demo:tracer] answer: ok (${statusGroups} status groups, ${orderCount} orders)`);
  console.log(`[demo:tracer] trace: ${tracePath} (7 events, PII clean)`);
  console.log(`[demo:tracer] PASS`);

  shuttingDown = true;
  mcp.kill();
  api.kill();
}

await main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
