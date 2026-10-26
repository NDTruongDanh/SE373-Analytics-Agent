// Resume routing plus trace-rehydrate legs (API-02, 01-14). DB-free per
// D-21: MemorySaver checkpointer shared across app instances to simulate a
// host restart against the same durable store; the interrupt leg uses an
// injected UC handler (interrupt from @langchain/langgraph directly) so no
// agent internals beyond the registry contract are touched.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MemorySaver, interrupt } from "@langchain/langgraph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import type { UcEntryHandler } from "@se373/agent";

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

const stubEnv = {
  MCP_TOKEN_SALES_SOUTH: "stub-sales",
  MCP_TOKEN_MARKETING: "stub-marketing",
  MCP_TOKEN_HR: "stub-hr",
  MCP_TOKEN_ADMIN: "stub-admin",
} as unknown as NodeJS.ProcessEnv;

/** UC handler that pauses for approval, then answers from the resume value. */
const pausingHandler: UcEntryHandler = async (state) => {
  const verdict = interrupt({ action: "review_sql", sql: "SELECT 1" }) as string;
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

  it("pauses on interrupt then resumes on the same thread without re-running", async () => {
    const asked = await post("/api/ask", { question: "please review", persona: "sales_south" });
    expect(asked.status).toBe(200);
    const askBlocks = parseSse(asked.text);
    expect(askBlocks.map((b) => b.event)).toEqual(["interrupt_waiting"]);
    const runId = askBlocks[0].data["runId"] as string;
    const threadId = askBlocks[0].data["threadId"] as string;
    expect(threadId.startsWith("chat:sales_south:")).toBe(true);

    const resumed = await post(`/api/runs/${runId}/resume`, { value: "approve" });
    expect(resumed.status).toBe(200);
    const resumeBlocks = parseSse(resumed.text);
    expect(resumeBlocks.map((b) => b.event)).toEqual([
      "intent_parsed",
      "schema_retrieved",
      "sql_generated",
      "query_running",
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
});
