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

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { interrupt } from "@langchain/langgraph";
import { buildRootGraph, createRcaRuntime } from "@shared/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import {
  createHostPorts,
  createLockPool,
  createThreadLockAcquirer,
  expirePendingCheckpoints,
  pruneCompletedCheckpoints,
  type HostPorts,
} from "../src/ports.js";
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
  let ports: HostPorts | null = null;
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
      throw new Error(`MCP tool ${tool} failed: ${JSON.stringify(out.result)}`);
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
        HARNESS_STATE_DATABASE_URL: HARNESS_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stderr?.on("data", (chunk) => {
      gatewayStderr += String(chunk);
    });
    await waitFor(`http://127.0.0.1:${GATEWAY_PORT}/healthz`, 60_000);

    ports = await createHostPorts();
    const app = buildApp({
      checkpointer: ports.checkpointer,
      store: ports.store,
      acquireThreadLock: ports.acquireThreadLock,
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
    if (ports) {
      await ports.lockPool.end().catch(() => undefined);
    }
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

    // Live PostgreSQL audit hash-chain proof: verify gateway persisted every tool call cleanly.
    const auditRes = await ports!.lockPool.query(
      `SELECT seq, run_id, tool, caller, input_hash, output_hash, prev_hash, current_hash, record
       FROM app_state.mcp_audit_log
       WHERE run_id = $1
       ORDER BY seq ASC`,
      [runId],
    );
    expect(auditRes.rows.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < auditRes.rows.length; i += 1) {
      const row = auditRes.rows[i];
      const seq = Number(row["seq"]);
      if (i > 0) {
        expect(seq).toBeGreaterThan(Number(auditRes.rows[i - 1]["seq"]));
        if (seq === Number(auditRes.rows[i - 1]["seq"]) + 1) {
          expect(String(row["prev_hash"])).toBe(String(auditRes.rows[i - 1]["current_hash"]));
        }
      }
      const recordObj = row["record"] as { ts: string };
      const expectedHash = createHash("sha256")
        .update(
          [
            String(seq),
            String(row["run_id"]),
            String(row["tool"]),
            String(row["caller"]),
            recordObj.ts,
            String(row["input_hash"]),
            String(row["output_hash"]),
            String(row["prev_hash"]),
          ].join("|"),
          "utf8",
        )
        .digest("hex");
      expect(String(row["current_hash"])).toBe(expectedHash);
      expect(containsWirePii(JSON.stringify(recordObj))).toBe(false);
    }
  }, 120_000);

  it("enforces two-connection PostgreSQL 64-bit advisory locks and 409 Conflict on live /api/ask", async () => {
    const threadId = `chat:sales_south:live-lock-${Date.now()}`;
    const poolA = createLockPool(HARNESS_URL);
    const poolB = createLockPool(HARNESS_URL);
    const acqA = createThreadLockAcquirer(poolA);
    const acqB = createThreadLockAcquirer(poolB);
    let handleA: Awaited<ReturnType<typeof acqA>> | null = null;
    let handleB: Awaited<ReturnType<typeof acqB>> | null = null;
    try {
      handleA = await acqA(threadId);
      expect(handleA.acquired).toBe(true);

      const handleBWhileHeld = await acqB(threadId);
      expect(handleBWhileHeld.acquired).toBe(false);

      // Concurrent /api/ask on the same locked threadId must fail fast with 409 Conflict.
      const conflictRes = await fetch(`${apiBase}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: DEMO_QUESTION,
          persona: "sales_south",
          threadId,
        }),
      });
      expect(conflictRes.status).toBe(409);

      await handleA.release();
      handleA = null;
      handleB = await acqB(threadId);
      expect(handleB.acquired).toBe(true);
      await handleB.release();
      handleB = null;
    } finally {
      if (handleA) await handleA.release().catch(() => undefined);
      if (handleB) await handleB.release().catch(() => undefined);
      await Promise.allSettled([poolA.end(), poolB.end()]);
    }
  });

  it("executes expirePendingCheckpoints and pruneCompletedCheckpoints against live PostgreSQL tables", async () => {
    const threadId = `live-lifecycle-${Date.now()}`;
    const lifecycleGraph = buildRootGraph({
      checkpointer: ports!.checkpointer,
      emitSpan: () => "",
      textToSql: {
        intentModel: fakeModel(JSON.stringify(DEMO_INTENT), DEMO_INTENT) as never,
        sqlModel: fakeModel(DEMO_SQL, JSON.parse(DEMO_SQL)) as never,
      },
      routes: {
        "text-to-sql": async () => {
          const decision = interrupt({ action: "review_plan" }) as { action?: string };
          if (decision?.action === "timeout") {
            return {
              status: "error",
              errorCode: "HITL_APPROVAL_TIMEOUT",
              answerText: "timed out",
            };
          }
          return { status: "ok", answerText: "done" };
        },
      },
      retrieve: async () => ({ semanticChunks: [], semanticRetrieveStatus: "ok" as const }),
      viz: async () => ({}),
      synthesize: async () => ({ answerText: "done" }),
    });

    await lifecycleGraph.invoke(
      { question: "live checkpoint expiry test" },
      { configurable: { thread_id: threadId } },
    );

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await ports!.lockPool.query(
      `UPDATE langgraph.checkpoints
       SET checkpoint = jsonb_set(checkpoint, '{ts}', to_jsonb($2::text))
       WHERE thread_id = $1`,
      [threadId, tenDaysAgo],
    );

    const expireRes = await expirePendingCheckpoints({
      pool: ports!.lockPool,
      graph: lifecycleGraph,
      acquireThreadLock: ports!.acquireThreadLock,
      maxAgeDays: 7,
    });
    expect(expireRes.expired).toContain(threadId);

    const stateAfterExpire = await lifecycleGraph.getState({
      configurable: { thread_id: threadId },
    });
    expect(stateAfterExpire.values["errorCode"]).toBe("HITL_APPROVAL_TIMEOUT");
    expect(stateAfterExpire.values["status"]).toBe("error");

    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await ports!.lockPool.query(
      `UPDATE langgraph.checkpoints
       SET checkpoint = jsonb_set(checkpoint, '{ts}', to_jsonb($2::text))
       WHERE thread_id = $1`,
      [threadId, fortyDaysAgo],
    );

    const pruneRes = await pruneCompletedCheckpoints({
      pool: ports!.lockPool,
      graph: lifecycleGraph,
      acquireThreadLock: ports!.acquireThreadLock,
      retentionDays: 30,
    });
    expect(pruneRes.pruned).toContain(threadId);

    const remaining = await ports!.lockPool.query(
      "SELECT COUNT(*)::int AS n FROM langgraph.checkpoints WHERE thread_id = $1",
      [threadId],
    );
    expect(remaining.rows[0]?.["n"]).toBe(0);
  });

  it("enforces real PostgreSQL asOf cutoff filtering, stale checkpointId 409, and >1h STALE_PLAN_RECHECK", async () => {
    const dateProbe = (await mcpCall(
      "run_query",
      {
        sql: "SELECT DISTINCT o.purchase_date::text AS d FROM public.orders o WHERE o.status IN ('delivered','returned') ORDER BY d ASC",
        maxRows: 1000,
      },
      "e2e-asof-dates",
      SALES_TOKEN,
    )) as { rows?: Array<{ d: string }> };
    const dates = (dateProbe.rows ?? [])
      .map((r) => String(r.d).slice(0, 10))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    expect(dates.length).toBeGreaterThanOrEqual(4);

    const queryNetRev = async (start: string, end: string): Promise<number> => {
      const out = (await mcpCall(
        "run_query",
        {
          sql: `SELECT COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN i.price_vnd WHEN o.status = 'returned' THEN -i.price_vnd ELSE 0 END), 0)::float AS val FROM public.order_items i JOIN public.orders o USING (order_id) WHERE o.status IN ('delivered', 'returned') AND o.purchase_date >= '${start}' AND o.purchase_date <= '${end}'`,
          maxRows: 5,
        },
        "e2e-asof-probe",
        SALES_TOKEN,
      )) as { rows?: Array<{ val: number }> };
      return Number(out.rows?.[0]?.val ?? 0);
    };

    const splitIdx = Math.floor(dates.length / 2);
    const baselinePeriod = { start: dates[0], end: dates[splitIdx - 1] };
    const currentPeriod = { start: dates[splitIdx], end: dates[dates.length - 1] };
    const midIdx = splitIdx + Math.max(0, Math.floor((dates.length - splitIdx) / 2) - 1);
    const midDate = dates[midIdx];

    const baseTotal = await queryNetRev(baselinePeriod.start, baselinePeriod.end);
    const midTotal = await queryNetRev(currentPeriod.start, midDate);
    const fullTotal = await queryNetRev(currentPeriod.start, currentPeriod.end);
    expect(Math.abs(fullTotal - midTotal) / Math.max(1, Math.abs(midTotal))).toBeGreaterThan(0.01);
    expect(Math.abs(midTotal - baseTotal) / Math.max(1, Math.abs(baseTotal))).toBeGreaterThanOrEqual(0.01);

    let currentNow = new Date(`${midDate}T12:00:00+07:00`);
    const intentObj = {
      metricName: "net_revenue",
      metricType: "additive" as const,
      direction: midTotal < baseTotal ? ("decrease" as const) : ("increase" as const),
      isExplicitDirection: false,
      currentPeriod,
      baselinePeriod,
      candidateTables: ["orders", "order_items", "customers", "channels", "categories", "products"],
    };
    const rcaIntentModel = {
      withStructuredOutput: () => ({
        invoke: async () => intentObj,
      }),
    };
    const rcaSqlModel = {
      withStructuredOutput: () => ({
        invoke: async (prompt: string) => {
          const qMatch = /\n<question>([\s\S]*?)<\/question>/.exec(prompt);
          if (!qMatch) {
            throw new Error(`Missing <question> block in prompt: ${prompt.slice(0, 120)}`);
          }
          const decoded = JSON.parse(
            qMatch[1]
              .replaceAll("&lt;", "<")
              .replaceAll("&gt;", ">")
              .replaceAll("&amp;", "&"),
          ) as string;
          const match = /Reference SQL:\s*([^\n]+)/.exec(decoded);
          if (!match) {
            throw new Error(`Missing Reference SQL in question: ${decoded.slice(0, 120)}`);
          }
          const sql = match[1].trim();
          const tablesUsed: string[] = [];
          for (const t of ["order_items", "orders", "customers", "channels", "products", "categories"]) {
            if (sql.includes(`public.${t}`)) tablesUsed.push(t);
          }
          return { sql, tablesUsed };
        },
      }),
    };

    const rcaRuntime = createRcaRuntime({
      intentModel: rcaIntentModel as never,
      sqlModel: rcaSqlModel as never,
      now: () => currentNow,
      freshnessTtlMs: 60 * 60 * 1000,
      maxQueriesLimit: 8,
      maxDepthLimit: 1,
    });

    const localTraces = mkdtempSync(path.join(tmpdir(), "e2e-live-rca-"));
    const localApp = buildApp({
      checkpointer: ports!.checkpointer,
      store: ports!.store,
      acquireThreadLock: ports!.acquireThreadLock,
      mcpUrl: gatewayUrl,
      tracesDir: localTraces,
      routes: { "root-cause-analysis": rcaRuntime.entry },
    });
    const localServer = localApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => localServer.on("listening", resolve));
    const localPort = (localServer.address() as { port: number }).port;
    const localBase = `http://127.0.0.1:${localPort}`;

    try {
      const askRes = await fetch(`${localBase}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: `Vì sao doanh thu thuần từ ${currentPeriod.start} đến ${currentPeriod.end} biến động so với ${baselinePeriod.start} đến ${baselinePeriod.end}?`,
          persona: "sales_south",
        }),
      });
      expect(askRes.status).toBe(200);
      const askBlocks = parseSse(await askRes.text());
      const interrupt1 = askBlocks.find((b) => b.event === "interrupt_waiting");
      expect(interrupt1, `ask SSE blocks: ${JSON.stringify(askBlocks)}`).toBeDefined();
      const runId = String(interrupt1!.data["runId"]);
      const checkpointId1 = String(interrupt1!.data["checkpointId"] ?? "");
      expect(checkpointId1.length).toBeGreaterThan(0);

      const intData1 = interrupt1!.data["data"] as {
        asOf?: string;
        plan?: { currentVal?: number; asOf?: string };
      };
      expect(intData1.asOf).toBe(currentNow.toISOString());
      // Real PostgreSQL SQL gated by asOf must match midTotal and be distinct from unclamped fullTotal.
      expect(Math.abs(Number(intData1.plan?.currentVal) - midTotal)).toBeLessThan(1e-3);
      expect(Math.abs(Number(intData1.plan?.currentVal) - fullTotal)).toBeGreaterThan(1);

      // Verify real SQL audit rows were persisted in app_state.mcp_audit_log for this runId.
      const preResumeAudit = await ports!.lockPool.query(
        "SELECT tool, current_hash FROM app_state.mcp_audit_log WHERE run_id = $1 ORDER BY seq ASC",
        [runId],
      );
      expect(preResumeAudit.rows.some((r) => r["tool"] === "run_query")).toBe(true);

      // Missing checkpointId -> 400
      const missingRes = await fetch(`${localBase}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: { action: "approve" } }),
      });
      expect(missingRes.status).toBe(400);

      // Stale / mismatched checkpointId -> 409 Conflict
      const staleRes = await fetch(`${localBase}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: { action: "approve" },
          checkpointId: "stale-checkpoint-id",
        }),
      });
      expect(staleRes.status).toBe(409);

      // Advance clock >1h beyond currentPeriod.end: re-querying real PostgreSQL picks up fullTotal (>1% drift!) -> STALE_PLAN_RECHECK
      currentNow = new Date(
        Math.max(
          currentNow.getTime() + 2 * 60 * 60 * 1000,
          new Date(`${currentPeriod.end}T23:59:00+07:00`).getTime(),
        ),
      );
      const recheckRes = await fetch(`${localBase}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: { action: "approve" },
          checkpointId: checkpointId1,
        }),
      });
      expect(recheckRes.status).toBe(200);
      const recheckBlocks = parseSse(await recheckRes.text());
      const interrupt2 = recheckBlocks.find((b) => b.event === "interrupt_waiting");
      expect(interrupt2).toBeDefined();
      const intData2 = interrupt2!.data["data"] as {
        reason?: string;
        asOf?: string;
        currentPlan?: { currentVal?: number };
      };
      expect(intData2.reason).toBe("STALE_PLAN_RECHECK");
      expect(intData2.asOf).toBe(currentNow.toISOString());
      expect(Math.abs(Number(intData2.currentPlan?.currentVal) - fullTotal)).toBeLessThan(1e-3);
      const checkpointId2 = String(interrupt2!.data["checkpointId"] ?? "");
      expect(checkpointId2.length).toBeGreaterThan(0);
      expect(checkpointId2).not.toBe(checkpointId1);

      // Old checkpointId1 is now stale -> 409 Conflict
      const oldAfterRecheckRes = await fetch(`${localBase}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: { action: "approve" },
          checkpointId: checkpointId1,
        }),
      });
      expect(oldAfterRecheckRes.status).toBe(409);

      // Resume with fresh checkpointId2 executes real step SQL against PostgreSQL -> completes ok
      const finalRes = await fetch(`${localBase}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: { action: "approve" },
          checkpointId: checkpointId2,
        }),
      });
      expect(finalRes.status).toBe(200);
      const finalBlocks = parseSse(await finalRes.text());
      const completed = finalBlocks.find((b) => b.event === "completed");
      expect((completed?.data["data"] as { status?: string })?.status).toBe("ok");

      // Trace file must record asOf, checkpointId, STALE_PLAN_RECHECK, and approval_decided spans.
      const traceLines = readFileSync(`${localTraces}/${runId}.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type?: string; payload?: Record<string, unknown> });
      expect(
        traceLines.some(
          (e) => e.type === "approval_requested" && typeof e.payload?.["asOf"] === "string" && e.payload?.["checkpointId"] === checkpointId1,
        ),
      ).toBe(true);
      expect(
        traceLines.some(
          (e) => e.type === "approval_requested" && e.payload?.["reason"] === "STALE_PLAN_RECHECK" && e.payload?.["checkpointId"] === checkpointId2,
        ),
      ).toBe(true);
      expect(
        traceLines.some(
          (e) => e.type === "approval_decided" && e.payload?.["checkpointId"] === checkpointId2,
        ),
      ).toBe(true);

      // Re-resuming completed thread -> 409 Conflict
      const dupRes = await fetch(`${localBase}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: { action: "approve" },
          checkpointId: checkpointId2,
        }),
      });
      expect(dupRes.status).toBe(409);
    } finally {
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  }, 120_000);
});
