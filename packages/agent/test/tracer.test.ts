import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TraceEventSchema } from "@se373/contracts";
import { runTracerGraph } from "../src/graph.js";
import {
  TRACER_SQL_PROPOSAL,
  createChatModel,
} from "../src/models/factory.js";
import { writeTraceEvent } from "../src/traces/writer.js";

// Tracer slice: fake model + stub MCP transport assert at least 2 tool calls
// per run, per-call X-Run-Id propagation, resultPreview cap, and zero raw
// seed phones/emails in writer output. No DB, no API key needed.

const SEED_PHONES = ["0901111111", "0905555555"];
const SEED_EMAIL = "an.nguyen@example.vn";

interface SeenCall {
  tool: string;
  runId: string;
  auth: string;
}

function threeRows() {
  return [
    { status: "cancelled", n: 2 },
    { status: "completed", n: 7 },
    { status: "pending", n: 3 },
  ];
}

function sixtyRows() {
  return Array.from({ length: 60 }, (_, i) => ({
    status: `s${i % 3}`,
    n: 1,
  }));
}

describe("tracer agent", () => {
  let stub: Server | null = null;
  let mcpUrl = "";
  let tracesDir = "";
  const seen: SeenCall[] = [];

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        resolve(JSON.parse(data));
      });
    });
  }

  function sse(res: import("node:http").ServerResponse, id: number, result: unknown) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id })}\n\n`);
  }

  beforeAll(async () => {
    tracesDir = mkdtempSync(path.join(tmpdir(), "tracer-agent-"));
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = (await readBody(req!)) as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string; name?: string; arguments?: unknown };
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
        const tool = body.params?.name ?? "";
        seen.push({
          tool,
          runId: String(req.headers["x-run-id"] ?? ""),
          auth: String(req.headers["authorization"] ?? ""),
        });
        const rows =
          tool === "list_tables"
            ? []
            : String(req.headers["x-run-id"]).includes("cap")
              ? sixtyRows()
              : threeRows();
        const payload =
          tool === "list_tables"
            ? {
                tables: [
                  { name: "customers", schema: "public", columns: [] },
                  { name: "orders", schema: "public", columns: [] },
                ],
              }
            : {
                columns: ["status", "n"],
                rows,
                rowCount: rows.length,
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
      stub = server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = stub!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    mcpUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (stub) stub.close(() => resolve());
      else resolve();
    });
  });

  function ctx(runId: string) {
    return {
      mcpUrl,
      token: "stub-token",
      runId,
      userId: "demo-user",
      roleScope: "sales_south",
      threadId: `thread-${runId}`,
      tracesDir,
    };
  }

  it("proposes the canned SQL through the fake model by default", async () => {
    const model = createChatModel();
    const proposal = await model.proposeSql("How many orders do we have per status?");
    expect(proposal).toEqual(TRACER_SQL_PROPOSAL);
  });

  it("calls at least 2 MCP tools with per-call identity headers", async () => {
    seen.length = 0;
    const out = await runTracerGraph(
      "How many orders do we have per status?",
      ctx("run-tools-1"),
    );
    expect(out.toolsCalled).toEqual(["list_tables", "run_query"]);
    expect(seen).toHaveLength(2);
    expect(seen[0].tool).toBe("list_tables");
    expect(seen[1].tool).toBe("run_query");
    for (const call of seen) {
      expect(call.runId).toBe("run-tools-1");
      expect(call.auth).toBe("Bearer stub-token");
    }
    expect(out.status).toBe("ok");
    expect(out.answerText).toContain("3 status groups, 12 orders");
  });

  it("propagates a distinct X-Run-Id per run", async () => {
    seen.length = 0;
    await runTracerGraph("How many orders do we have per status?", ctx("run-tools-2"));
    const runIds = new Set(seen.map((call) => call.runId));
    expect(runIds).toEqual(new Set(["run-tools-2"]));
  });

  it("caps the result preview at 50 rows", async () => {
    const out = await runTracerGraph("How many orders do we have per status?", ctx("run-cap-1"));
    expect(out.status).toBe("ok");
    const lines = readFileSync(`${tracesDir}/run-cap-1.jsonl`, "utf8").trim().split("\n");
    const answerEvent = lines
      .map((line) => JSON.parse(line))
      .find((event) => event.type === "node_done" && event.node === "answer");
    // The stub returns 60 rows; the deterministic answer counts only the
    // capped preview, proving the 50-row cap without exposing state.
    expect((answerEvent.payload as { total: number }).total).toBe(50);
  });

  it("writes a 7-event redacted trace validated by the contract", async () => {
    await runTracerGraph("How many orders do we have per status?", ctx("run-trace-1"));
    const raw = readFileSync(`${tracesDir}/run-trace-1.jsonl`, "utf8").trim().split("\n");
    expect(raw).toHaveLength(7);
    for (const line of raw) {
      const parsed = TraceEventSchema.parse(JSON.parse(line));
      expect(parsed.runId).toBe("run-trace-1");
      expect(parsed.spanId).toBeDefined();
    }
  });

  it("masks raw seed PII in writer output", () => {
    const runId = "run-pii-1";
    writeTraceEvent(
      {
        runId,
        threadId: "t1",
        userId: "demo-user",
        role: "sales_south",
        node: "run",
        type: "tool_call",
        durationMs: 1,
        payload: { leak: `call ${SEED_PHONES[0]} or ${SEED_EMAIL}` },
      },
      tracesDir,
    );
    const content = readFileSync(`${tracesDir}/${runId}.jsonl`, "utf8");
    expect(content).toContain("MASKED_PHONE");
    expect(content).toContain("MASKED_EMAIL");
    for (const phone of SEED_PHONES) {
      expect(content).not.toContain(phone);
    }
    expect(content).not.toContain(SEED_EMAIL);
  });
});
