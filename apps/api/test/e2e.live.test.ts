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

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDrillDownSql,
  buildTimeSeriesQuery,
  DEFAULT_ANOMALY_CATALOG,
  drillDownCandidateTables,
  InMemoryAlertHistoryStore,
  InMemoryDigestQueue,
  loadSubscriptionsConfigFile,
  runAnomalyRunner,
  seriesCandidateTables,
  subtractDays,
} from "@shared/agent/alerts";
import {
  ValidatedQueryExecutor,
  type ExecutorPrincipal,
  type McpToolCaller,
} from "@shared/agent/queryExecutor";
import { buildApp } from "../src/index.js";
import { createHostPorts } from "../src/ports.js";
import { containsWirePii, SSE_ALLOWLIST } from "../src/sse.js";

const HARNESS_URL = process.env["HARNESS_STATE_DATABASE_URL"] ?? "";
const AGENT_RO_URL = process.env["AGENT_RO_DATABASE_URL"] ?? "";
const SALES_TOKEN = process.env["MCP_TOKEN_SALES_SOUTH"] ?? "";
const ADMIN_TOKEN = process.env["MCP_TOKEN_ADMIN"] ?? "";
const LIVE = HARNESS_URL.length > 0 && AGENT_RO_URL.length > 0 && SALES_TOKEN.length > 0;

const DEMO_QUESTION = "How many orders do we have per status?";

// The live DB and gateway are under test, not the model: CI runs without a model key,
// so intent and SQL proposals come from deterministic fakes wired through buildApp.
const DEMO_INTENT = {
  metric: "order_count",
  dimensions: ["status"],
  filters: [],
  timeRange: "2025-01-01/2026-10-01",
  requestedMetrics: [],
  schemaEntities: ["orders"],
  queryMode: "standard_query" as const,
};
const DEMO_SQL = JSON.stringify({
  sql: "SELECT status, COUNT(*) AS n FROM public.orders WHERE purchase_date >= '2025-01-01' AND purchase_date < '2026-10-01' GROUP BY status ORDER BY status",
  tablesUsed: ["orders"],
});

function fakeModel(text: string, structured: unknown) {
  return {
    invoke: async () => ({ content: text }),
    async *stream() {
      yield { content: text };
    },
    withStructuredOutput: () => ({ invoke: async () => structured }),
  };
}
const GATEWAY_PORT = 18081;
// Canonical UUIDs (runId/threadId/spanId/parentSpanId) can randomly contain
// `0\d{9}` in their 12-hex node segment and trip PHONE_LIKE in containsWirePii.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
      textToSql: {
        intentModel: fakeModel(JSON.stringify(DEMO_INTENT), DEMO_INTENT) as never,
        sqlModel: fakeModel(DEMO_SQL, JSON.parse(DEMO_SQL)) as never,
      },
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

  it("runs a data question end to end through the router with redacted trace and clean SSE", async () => {
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
    // The question runs the real text-to-sql pipeline: the router span,
    // understand's catalog list_tables plus its pre-retrieve semantic
    // search, the executor's describe_table calls and run_query execution,
    // then the UC-03 VIZ spans. Repair loops can append extra spans, so
    // assert presence and order anchors rather than an exact line count.
    const tracePath = `${tracesDir}/${runId}.jsonl`;
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(10);
    const tools: string[] = [];
    let routerRoute: unknown;
    for (const line of lines) {
      const event = JSON.parse(line) as {
        runId?: string;
        threadId?: string;
        spanId?: string;
        node?: string;
        type?: string;
        payload?: { tool?: string; route?: string };
      };
      expect(event.runId).toBe(runId);
      expect(typeof event.threadId).toBe("string");
      expect(typeof event.spanId).toBe("string");
      // Same detector as the SSE tripwire (#115): a bare /0\d{9}/ also
      // matched float digits (costs, scores) and made this test flaky; strip
      // canonical UUIDs so random spanId/runId hex never trips PHONE_LIKE.
      expect(containsWirePii(line.replace(UUID_RE, "<uuid>"))).toBe(false);
      for (const literal of liveLiterals) {
        expect(line).not.toContain(literal);
      }
      if (event.node === "router" && event.type === "node_done") {
        routerRoute = event.payload?.route;
      }
      if (event.type === "tool_call" && event.payload?.tool) {
        tools.push(event.payload.tool);
      }
    }
    expect(routerRoute).toBe("text-to-sql");
    expect(tools[0]).toBe("list_tables");
    expect(tools).toContain("search_semantic_layer");
    expect(tools).toContain("describe_table");
    expect(tools).toContain("run_query");
    expect(tools.indexOf("list_tables")).toBeLessThan(tools.indexOf("run_query"));
    for (const tool of ["list_tables", "describe_table", "run_query"]) {
      expect(completed.toolsCalled).toContain(tool);
    }
    const vizTypes = lines
      .map((line) => (JSON.parse(line) as { node?: string; type?: string }).type)
      .filter((type) =>
        ["chart_selected", "chart_validated", "node_done"].includes(type ?? ""),
      );
    expect(vizTypes).toContain("chart_selected");
    expect(vizTypes).toContain("chart_validated");

    // SSE proof: no seed PII shapes, no live row cell value, no token. The
    // SQL proposal/display pair is covered by the replay tests in
    // host.test.ts; the live pipeline emits no understand proposal span.
    expect(containsWirePii(sseText.replace(UUID_RE, "<uuid>"))).toBe(false);
    for (const literal of liveLiterals) {
      expect(sseText).not.toContain(literal);
    }
    expect(sseText).not.toContain(SALES_TOKEN);
  }, 120_000);

  it("executes UC-10 time-series and drill-down SQL for all subscriptions against live PostgreSQL", async () => {
    const token = ADMIN_TOKEN || SALES_TOKEN;
    const roleScope = ADMIN_TOKEN ? "admin" : "sales_south";
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const config = loadSubscriptionsConfigFile(path.join(repoRoot, "config/subscriptions.yaml"));
    const runId = randomUUID();
    const mcp: McpToolCaller = {
      call: async (tool, args) => {
        const toolArgs = { ...args };
        delete toolArgs["runId"];
        delete toolArgs["userId"];
        delete toolArgs["roleScope"];
        return mcpCall(tool, toolArgs, runId, token);
      },
    };
    const executor = new ValidatedQueryExecutor({
      mcp,
      model: fakeModel("", {}) as never,
    });
    const principal: ExecutorPrincipal = {
      runId,
      userId: "uc10-live-test",
      roleScope,
    };
    const date = "2026-09-12";
    const startDate = subtractDays(date, 63);

    for (const sub of config.subscriptions) {
      const effectiveRole = ADMIN_TOKEN ? sub.recipientRole : roleScope;
      const seriesSql = buildTimeSeriesQuery({
        metricId: sub.metricId,
        startDate,
        endDate: date,
        recipientRole: effectiveRole,
      });
      const seriesRes = await executor.run({
        question: `Live UC-10 series check for ${sub.id}`,
        initialSql: seriesSql,
        candidateTables: seriesCandidateTables(sub.metricId, effectiveRole),
        principal,
        catalog: DEFAULT_ANOMALY_CATALOG,
      });
      expect(["ok", "no_data"], `${sub.id} series failed: ${JSON.stringify(seriesRes)}`).toContain(seriesRes.status);

      const drillSql = buildDrillDownSql({
        metricId: sub.metricId,
        secondaryDimensions: sub.suggestedSecondaryDimensions ?? [],
        date,
        recipientRole: effectiveRole,
        catalog: DEFAULT_ANOMALY_CATALOG,
      });
      const drillRes = await executor.run({
        question: `Live UC-10 drilldown check for ${sub.id}`,
        initialSql: drillSql,
        candidateTables: drillDownCandidateTables(
          sub.metricId,
          sub.suggestedSecondaryDimensions ?? [],
          effectiveRole,
        ),
        principal,
        catalog: DEFAULT_ANOMALY_CATALOG,
      });
      expect(["ok", "no_data"], `${sub.id} drilldown failed: ${JSON.stringify(drillRes)}`).toContain(drillRes.status);
    }

    const scopedSubs = ADMIN_TOKEN
      ? config.subscriptions
      : config.subscriptions.map((s) => ({ ...s, recipientRole: roleScope }));
    const runnerRes = await runAnomalyRunner({
      subscriptions: scopedSubs,
      targetDate: date,
      manual: true,
      queryExecutor: executor,
      queryPrincipal: principal,
      catalog: DEFAULT_ANOMALY_CATALOG,
      historyStore: new InMemoryAlertHistoryStore(),
      digestQueue: new InMemoryDigestQueue(),
      dispatcherOptions: {
        transport: async () => ({ ok: true, status: 200 }),
      },
    });
    expect(runnerRes.failures).toEqual([]);
    expect(runnerRes.evaluatedSubscriptions).toBe(scopedSubs.length);
  }, 120_000);
});
