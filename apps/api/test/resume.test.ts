// Resume routing plus trace-rehydrate legs (API-02, 01-14). DB-free per
// D-21: MemorySaver checkpointer shared across app instances to simulate a
// host restart against the same durable store; the interrupt leg uses an
// injected UC handler (interrupt from @langchain/langgraph directly) so no
// agent internals beyond the registry contract are touched.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemorySaver, interrupt } from "@langchain/langgraph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, buildResumeInvokeOptions } from "../src/index.js";
import type { UcEntryHandler } from "@shared/agent";
import type { LangSmithRunConfig } from "@shared/agent/telemetry";

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

function readTraceEvents(dir: string, runId: string): Record<string, unknown>[] {
  const content = readFileSync(path.join(dir, `${runId}.jsonl`), "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function eventsOf(events: Record<string, unknown>[], type: string): Record<string, unknown>[] {
  return events.filter((event) => event["type"] === type);
}

const stubEnv = {
  MCP_TOKEN_SALES_SOUTH: "stub-sales",
  MCP_TOKEN_MARKETING: "stub-marketing",
  MCP_TOKEN_HR: "stub-hr",
  MCP_TOKEN_ADMIN: "stub-admin",
} as unknown as NodeJS.ProcessEnv;

/** UC handler that pauses for approval, then answers from the resume value. */
const pausingHandler: UcEntryHandler = async (state) => {
  const clarification = state.question === "please clarify";
  const verdict = interrupt(
    clarification
      ? {
          action: "clarify_then_query",
          pendingClarification: {
            field: "timeRange",
            question: "Select a time range",
            options: ["2026-01-01/2026-04-01", "2026-04-01/2026-07-01"],
            attempts: 0,
            table: "orders",
          },
        }
      : { action: "review_sql", sql: "SELECT 1" },
  ) as string;
  return {
    answerText: `decided:${String(verdict)}`,
    status: "ok",
    toolsCalled: [...state.toolsCalled, "review_tool"],
  };
};

describe("buildApp resume", () => {
  let apiBase = "";
  let tracesDir = "";
  let apiServer: { close: (cb?: () => void) => void } | null = null;
  let checkpointer: MemorySaver;

  beforeAll(async () => {
    tracesDir = mkdtempSync(path.join(tmpdir(), "fullhost-resume-"));
    checkpointer = new MemorySaver();
    const app = buildApp({
      checkpointer,
      mcpUrl: "http://127.0.0.1:1/mcp",
      tracesDir,
      env: stubEnv,
      ucHandlers: { tracer: pausingHandler },
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
  });

  async function post(pathname: string, body: unknown): Promise<{ status: number; text: string; json?: unknown }> {
    const res = await fetch(`${apiBase}${pathname}`, {
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

  it("returns 404 for unknown runIds", async () => {
    const out = await post("/api/runs/does-not-exist/resume", { value: "approve" });
    expect(out.status).toBe(404);
  });

  it("rejects a non-object resume body with 400", async () => {
    const res = await fetch(`${apiBase}/api/runs/x/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "42",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a resume body missing value or carrying null with 400", async () => {
    const resEmpty = await fetch(`${apiBase}/api/runs/x/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resEmpty.status).toBe(400);

    const resNull = await fetch(`${apiBase}/api/runs/x/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: null }),
    });
    expect(resNull.status).toBe(400);
  });

  it("pauses on interrupt then resumes on the same thread without re-running", async () => {
    const asked = await post("/api/ask", { question: "please review", persona: "sales_south" });
    expect(asked.status).toBe(200);
    const askBlocks = parseSse(asked.text);
    expect(askBlocks.map((b) => b.event)).toEqual(["intent_parsed", "interrupt_waiting"]);
    const runId = askBlocks[0].data["runId"] as string;
    const threadId = askBlocks[0].data["threadId"] as string;
    expect(threadId.startsWith("chat:sales_south:")).toBe(true);

    const resumed = await post(`/api/runs/${runId}/resume`, { value: "approve" });
    expect(resumed.status).toBe(200);
    const resumeBlocks = parseSse(resumed.text);
    expect(resumeBlocks.map((b) => b.event)).toEqual([
      "intent_parsed",
      "completed",
    ]);
    expect(new Set(resumeBlocks.map((b) => b.data["threadId"]))).toEqual(new Set([threadId]));
    const completed = resumeBlocks[resumeBlocks.length - 1].data["data"] as {
      status: string;
      answerText: string;
      toolsCalled: string[];
    };
    expect(completed.status).toBe("ok");
    expect(completed.answerText).toBe("decided:approve");
    expect(completed.toolsCalled).toEqual(["review_tool"]);
  });

  it("labels a direct UC clarification interrupt in its SSE and trace metadata", async () => {
    const asked = await post("/api/ask", { question: "please clarify", persona: "sales_south" });
    expect(asked.status).toBe(200);
    const blocks = parseSse(asked.text);
    expect(blocks.map((b) => b.event)).toEqual(["intent_parsed", "interrupt_waiting"]);
    const block = blocks.find((b) => b.event === "interrupt_waiting");
    expect(block?.data["data"]).toMatchObject({
      pendingClarification: {
        field: "timeRange",
        options: ["2026-01-01/2026-04-01", "2026-04-01/2026-07-01"],
      },
    });
    const runId = block?.data["runId"] as string;
    const requested = eventsOf(readTraceEvents(tracesDir, runId), "approval_requested")[0];
    expect((requested?.["payload"] as { kind?: unknown }).kind).toBe("clarification");
  });

  it("rehydrates the thread from the trace file after a host restart", async () => {
    const asked = await post("/api/ask", { question: "please review", persona: "marketing" });
    expect(asked.status).toBe(200);
    const askBlocks = parseSse(asked.text);
    const runId = askBlocks[0].data["runId"] as string;
    const threadId = askBlocks[0].data["threadId"] as string;

    // Seed the trace header line the rehydrator consumes: the first event a
    // real run writes before pausing (runId, threadId, userId, role).
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(
      `${tracesDir}/${runId}.jsonl`,
      `${JSON.stringify({ runId, threadId, userId: "marketing", role: "marketing", node: "understand", type: "node_done", durationMs: 1, spanId: "seed-span" })}\n`,
      "utf8",
    );

    // Simulate a restart: a fresh app with an empty in-memory registry over
    // the same checkpointer and the same trace directory.
    const restarted = buildApp({
      checkpointer,
      mcpUrl: "http://127.0.0.1:1/mcp",
      tracesDir,
      env: stubEnv,
      ucHandlers: { tracer: pausingHandler },
    });
    let restartedServer: { close: (cb?: () => void) => void } | null = null;
    await new Promise<void>((resolve) => {
      restartedServer = restarted.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = (restartedServer as unknown as { address: () => AddressInfo }).address();
      const base = `http://127.0.0.1:${address.port}`;
      const res = await fetch(`${base}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "approve" }),
      });
      expect(res.status).toBe(200);
      const blocks = parseSse(await res.text());
      expect(blocks[blocks.length - 1].event).toBe("completed");
      expect(new Set(blocks.map((b) => b.data["threadId"]))).toEqual(new Set([threadId]));
      const completed = blocks[blocks.length - 1].data["data"] as { answerText: string };
      expect(completed.answerText).toBe("decided:approve");
    } finally {
      await new Promise<void>((resolve) => {
        if (restartedServer) restartedServer.close(() => resolve());
        else resolve();
      });
    }
  });

  it("falls through to 404 on malformed trace lines", async () => {
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(`${tracesDir}/bad-run.jsonl`, "not json at all\n", "utf8");
    const out = await post("/api/runs/bad-run/resume", { value: "approve" });
    expect(out.status).toBe(404);
  });

  it("forwards plan payload in interrupt_waiting SSE event for UC-05 plan review", async () => {
    const planReviewHandler: UcEntryHandler = async (state) => {
      const mockPlan = {
        question: state.question,
        metricName: "net_revenue",
        steps: [{ stepId: "s1", status: "todo" }],
      };
      const verdict = interrupt({
        action: "review_analysis_plan",
        plan: mockPlan,
        currentPlan: mockPlan,
      });
      return {
        answerText: `plan_reviewed:${JSON.stringify(verdict)}`,
        status: "ok",
      };
    };

    const localTraces = mkdtempSync(path.join(tmpdir(), "fullhost-plan-"));
    const localApp = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: "http://127.0.0.1:9",
      tracesDir: localTraces,
      env: stubEnv,
      ucHandlers: {
        "root-cause-analysis": planReviewHandler,
      },
    });

    const server = localApp.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const asked = await fetch(`http://127.0.0.1:${port}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: "Vì sao doanh thu tháng 9 giảm?",
          persona: "sales_south",
        }),
      });
      const text = await asked.text();
      const blocks = parseSse(text);
      expect(blocks.map((b) => b.event)).toEqual(["intent_parsed", "interrupt_waiting"]);

      const interruptBlock = blocks.find((b) => b.event === "interrupt_waiting");
      expect(interruptBlock).toBeDefined();

      const eventData = interruptBlock!.data["data"] as Record<string, unknown>;
      expect(eventData.action).toBe("review_analysis_plan");
      expect(eventData.plan).toBeDefined();
      expect(eventData.currentPlan).toBeDefined();

      const runId = interruptBlock!.data["runId"] as string;

      // Resuming with {} or { value: null } must be rejected with 400 and cannot execute plan
      const resEmpty = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resEmpty.status).toBe(400);

      const resNull = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: null }),
      });
      expect(resNull.status).toBe(400);

      const resumed = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: { action: "APPROVE" } }),
      });
      const resText = await resumed.text();
      const resBlocks = parseSse(resText);
      expect(resBlocks.map((b) => b.event)).toContain("completed");
    } finally {
      server.close();
      rmSync(localTraces, { recursive: true, force: true });
    }
  });

  it("emits one approval_requested plus one approval_decided with metadata only", async () => {
    const asked = await post("/api/ask", { question: "please review", persona: "sales_south" });
    expect(asked.status).toBe(200);
    expect(parseSse(asked.text).map((b) => b.event)).toEqual(["intent_parsed", "interrupt_waiting"]);
    const runId = parseSse(asked.text)[0].data["runId"] as string;

    // Interrupt leaves exactly one request and no terminal spans: the run
    // is waiting, not finished.
    let events = readTraceEvents(tracesDir, runId);
    expect(eventsOf(events, "approval_requested")).toHaveLength(1);
    expect(eventsOf(events, "approval_decided")).toHaveLength(0);
    expect(eventsOf(events, "run_done")).toHaveLength(0);
    const requested = eventsOf(events, "approval_requested")[0];
    expect((requested["payload"] as { kind?: unknown }).kind).toBe("approval");

    // A non-allowlisted resume value is metadata-only: decision degrades to
    // "provided" with length, and the raw value reaches no span — nor any
    // hash of it (unsalted sha256 of a short value is brute-forceable).
    const secret = "s3cr3t-resume-canary-9zqx";
    const resumed = await post(`/api/runs/${runId}/resume`, { value: secret });
    expect(resumed.status).toBe(200);
    const resumeBlocks = parseSse(resumed.text);
    expect(resumeBlocks[resumeBlocks.length - 1].event).toBe("completed");

    events = readTraceEvents(tracesDir, runId);
    expect(eventsOf(events, "approval_requested")).toHaveLength(1);
    const decided = eventsOf(events, "approval_decided");
    expect(decided).toHaveLength(1);
    const payload = decided[0]["payload"] as Record<string, unknown>;
    expect(payload["kind"]).toBe("approval");
    expect(payload["decision"]).toBe("provided");
    expect(payload["reviewer"]).toBe("sales_south");
    expect(typeof payload["waitedMs"]).toBe("number");
    expect(payload["waitedMs"] as number).toBeGreaterThanOrEqual(0);
    expect(payload["valueLength"]).toBe(secret.length);
    expect(payload).not.toHaveProperty("valueHash");
    const raw = readFileSync(`${tracesDir}/${runId}.jsonl`, "utf8");
    expect(raw).not.toContain(secret);
    // The resumed run finishes exactly once.
    expect(eventsOf(events, "run_done")).toHaveLength(1);
  });

  it("records allowlisted resume verdicts verbatim", async () => {
    const asked = await post("/api/ask", { question: "please review", persona: "sales_south" });
    expect(asked.status).toBe(200);
    const runId = parseSse(asked.text)[0].data["runId"] as string;
    const resumed = await post(`/api/runs/${runId}/resume`, { value: "approve" });
    expect(resumed.status).toBe(200);
    const events = readTraceEvents(tracesDir, runId);
    const decided = eventsOf(events, "approval_decided");
    expect(decided).toHaveLength(1);
    expect((decided[0]["payload"] as { decision?: unknown }).decision).toBe(
      "approve",
    );
  });
});

describe("buildResumeInvokeOptions", () => {
  const stored = {
    threadId: "chat:sales_south:t1",
    userId: "sales_south",
    roleScope: "sales_south",
    token: "stub-token",
    mcpUrl: "http://127.0.0.1:1/mcp",
    tracesDir: "traces",
  };

  // Offline stand-in for buildLangSmithRunConfig output: the helper only
  // forwards callbacks/tags/metadata, so no client or network is needed.
  function fakeLangSmith(runId: string): LangSmithRunConfig {
    return {
      runId,
      callbacks: [],
      tags: ["se373", "uc:tracer"],
      metadata: {
        runId,
        threadId: stored.threadId,
        userId: stored.userId,
        role: stored.roleScope,
        ucId: "",
        maskedColumns: [],
      },
    };
  }

  it("mints a fresh root runId per resume while metadata keeps the API runId", () => {
    const first = buildResumeInvokeOptions({
      langsmith: fakeLangSmith("api-run-1"),
      run: stored,
      runId: "api-run-1",
    });
    const second = buildResumeInvokeOptions({
      langsmith: fakeLangSmith("api-run-1"),
      run: stored,
      runId: "api-run-1",
    });
    // Fresh LangSmith root on every resume, distinct from the ask's root —
    // the ask already owns a root run under the API runId.
    expect(first.runId).not.toBe("api-run-1");
    expect(second.runId).not.toBe("api-run-1");
    expect(first.runId).not.toBe(second.runId);
    // Correlation preserved: JSONL runId and LangSmith metadata agree.
    expect(first.metadata?.["runId"]).toBe("api-run-1");
    expect(first.metadata?.["threadId"]).toBe(stored.threadId);
    expect(first.configurable["runId"]).toBe("api-run-1");
    expect(first.configurable["thread_id"]).toBe(stored.threadId);
    expect(first.callbacks).toEqual([]);
    expect(first.tags).toEqual(["se373", "uc:tracer"]);
  });

  it("stays untraced when LangSmith is off", () => {
    const opts = buildResumeInvokeOptions({
      langsmith: undefined,
      run: stored,
      runId: "api-run-1",
    });
    expect(typeof opts.runId).toBe("string");
    expect(opts.runId).not.toBe("api-run-1");
    expect(opts.callbacks).toBeUndefined();
    expect(opts.metadata).toBeUndefined();
    expect(opts.configurable["runId"]).toBe("api-run-1");
  });

  it("keeps the JSONL runId stable across ask and resume", async () => {
    const localDir = mkdtempSync(path.join(tmpdir(), "fullhost-resume-meta-"));
    const localEnv = {
      MCP_TOKEN_SALES_SOUTH: "stub-sales",
      MCP_TOKEN_MARKETING: "stub-marketing",
      MCP_TOKEN_HR: "stub-hr",
      MCP_TOKEN_ADMIN: "stub-admin",
    } as unknown as NodeJS.ProcessEnv;
    const seenConfigurable: Record<string, unknown>[] = [];
    const capturing: UcEntryHandler = async (state, rt) => {
      seenConfigurable.push({
        ...(rt.config.configurable as Record<string, unknown>),
      });
      const verdict = interrupt({ action: "review_sql", sql: "SELECT 1" }) as string;
      return {
        answerText: `decided:${String(verdict)}`,
        status: "ok",
        toolsCalled: [...state.toolsCalled, "review_tool"],
      };
    };
    const capturingApp = buildApp({
      checkpointer: new MemorySaver(),
      mcpUrl: "http://127.0.0.1:1/mcp",
      tracesDir: localDir,
      env: localEnv,
      ucHandlers: { tracer: capturing },
    });
    let capturingServer: { close: (cb?: () => void) => void } | null = null;
    await new Promise<void>((resolve) => {
      capturingServer = capturingApp.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = (
        capturingServer as unknown as { address: () => AddressInfo }
      ).address();
      const base = `http://127.0.0.1:${address.port}`;
      const askRes = await fetch(`${base}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "please review", persona: "sales_south" }),
      });
      expect(askRes.status).toBe(200);
      const askBlocks = parseSse(await askRes.text());
      expect(askBlocks.map((b) => b.event)).toEqual(["intent_parsed", "interrupt_waiting"]);
      const runId = askBlocks[0].data["runId"] as string;
      const resumeRes = await fetch(`${base}/api/runs/${runId}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "approve" }),
      });
      expect(resumeRes.status).toBe(200);
      expect(parseSse(await resumeRes.text()).at(-1)?.event).toBe("completed");
      // The handler ran once per invoke on the same thread: both invokes
      // carry the JSONL runId, so traces and metadata keep correlating.
      expect(seenConfigurable).toHaveLength(2);
      expect(seenConfigurable[0]["runId"]).toBe(runId);
      expect(seenConfigurable[1]["runId"]).toBe(runId);
      expect(seenConfigurable[0]["thread_id"]).toBe(
        seenConfigurable[1]["thread_id"],
      );
    } finally {
      await new Promise<void>((resolve) => {
        if (capturingServer) capturingServer.close(() => resolve());
        else resolve();
      });
    }
  });
});
