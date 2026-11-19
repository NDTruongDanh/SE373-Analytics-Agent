// Eval LangSmith guard (Phase 3, plan 03-02, D-04/T-03-06): `pnpm eval`
// must never export to LangSmith, even with the env set. `prepareEvalEnv`
// scrubs every tracing flag in-process before any graph is built; this
// suite proves the scrub on a fake env and through the real
// `buildLiveAdapter` entry (which throws its infra error before any
// DB/gateway work, so the test stays DB-free).
//
// Imports the eval entry from source, the same precedent as
// packages/agent/test/safety.test.ts importing evals/safety.ts.
import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import {
  buildEvalGraph,
  buildLiveAdapter,
  createEvalEmitter,
  prepareEvalEnv,
} from "../../../evals/run.js";
import { TEXT_TO_SQL_UC_ID } from "../src/constants.js";
import { isLangSmithEnabled } from "../src/telemetry/langsmith.js";

const FLAGS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

describe("prepareEvalEnv", () => {
  it("deletes all four tracing flags and drops the live model key", () => {
    const env = {
      LANGSMITH_TRACING: "true",
      LANGSMITH_TRACING_V2: "true",
      LANGCHAIN_TRACING: "true",
      LANGCHAIN_TRACING_V2: "true",
      AGENT_MODEL_API_KEY: "sk-live-should-be-dropped",
      MCP_TOKEN_SALES_SOUTH: "keep-me",
    } as unknown as NodeJS.ProcessEnv;
    prepareEvalEnv(env);
    for (const flag of FLAGS) {
      expect(flag in env).toBe(false);
    }
    expect("AGENT_MODEL_API_KEY" in env).toBe(false);
    expect(env["MCP_TOKEN_SALES_SOUTH"]).toBe("keep-me");
  });

  it("keeps the live model key when explicitly opted in", () => {
    const env = {
      EVAL_USE_LIVE_MODEL: "1",
      AGENT_MODEL_API_KEY: "sk-live-opted-in",
    } as unknown as NodeJS.ProcessEnv;
    prepareEvalEnv(env);
    expect(env["AGENT_MODEL_API_KEY"]).toBe("sk-live-opted-in");
  });
});

describe("buildLiveAdapter env guard", () => {
  it("scrubs tracing flags before failing on missing DB env", async () => {
    const saved = new Map<string, string | undefined>();
    for (const key of [...FLAGS, "AGENT_RO_DATABASE_URL", "EVAL_USE_LIVE_MODEL"] as const) {
      saved.set(key, process.env[key]);
    }
    try {
      for (const flag of FLAGS) process.env[flag] = "true";
      delete process.env["AGENT_RO_DATABASE_URL"];
      delete process.env["EVAL_USE_LIVE_MODEL"];
      // Throws before any DB/gateway work (missing role URL); the scrub
      // already ran, so the flags stay deleted on the way out.
      // loadEnv: false keeps the developer's real .env out of the test
      // (root `pnpm test` runs with cwd = repo root, where .env lives).
      await expect(
        buildLiveAdapter(process.cwd(), { loadEnv: false }),
      ).rejects.toThrow(/AGENT_RO_DATABASE_URL is not set/);
      for (const flag of FLAGS) {
        expect(flag in process.env).toBe(false);
      }
    } finally {
      for (const [key, prior] of saved) {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
    }
  });
});

describe("createEvalEmitter (B6)", () => {
  it("writes a reconciling run_done through the real redacted writer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-emitter-"));
    const emit = createEvalEmitter(dir, {
      runId: "run-eval-1",
      threadId: "thread-eval-1",
      userId: "user-eval-1",
      role: "hr",
    });
    emit.emitLlmCall("propose", {
      model: "openai/gpt-oss-120b",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0,
      pricingKnown: true,
    });
    emit.emitToolCall("run", "run_query", { rowCount: 1 });
    emit.emitRunDone("error");
    const lines = readFileSync(path.join(dir, "run-eval-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    const done = JSON.parse(lines[2] as string) as {
      type?: unknown;
      role?: unknown;
      payload?: unknown;
    };
    expect(done.type).toBe("run_done");
    expect(done.role).toBe("hr");
    expect(done.payload).toMatchObject({
      status: "error",
      llmCalls: 1,
      toolCalls: 1,
      sqlAttempts: 1,
      sqlFailures: 0,
      repairs: 0,
    });
  });

  it("redacts PII through the eval emitter before anything reaches disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-emitter-pii-"));
    const emit = createEvalEmitter(dir, {
      runId: "run-eval-2",
      threadId: "thread-eval-2",
      userId: "user-eval-2",
      role: "sales_south",
    });
    emit({
      node: "run",
      type: "tool_call",
      durationMs: 1,
      payload: { tool: "run_query", note: "lien he 0912345678 nhe" },
    });
    const content = readFileSync(path.join(dir, "run-eval-2.jsonl"), "utf8");
    expect(content).not.toContain("0912345678");
    expect(content).toContain("[MASKED_PHONE]");
  });

  it("keeps eval export-disabled even with every tracing flag and key set", () => {
    const env = {
      LANGSMITH_TRACING: "true",
      LANGSMITH_TRACING_V2: "true",
      LANGCHAIN_TRACING: "true",
      LANGCHAIN_TRACING_V2: "true",
      LANGSMITH_API_KEY: "sk-test-not-real",
      LANGSMITH_PROJECT: "se373-analytics-agent",
      EVAL_USE_LIVE_MODEL: "1",
      AGENT_MODEL_API_KEY: "sk-live-opted-in",
    } as unknown as NodeJS.ProcessEnv;
    // The env as given WOULD enable export through the product gate...
    expect(isLangSmithEnabled(env)).toBe(true);
    // ...but the eval guard scrubs first, so no eval run can export.
    prepareEvalEnv(env);
    expect(isLangSmithEnabled(env)).toBe(false);
    for (const flag of FLAGS) {
      expect(flag in env).toBe(false);
    }
    expect(env["AGENT_MODEL_API_KEY"]).toBe("sk-live-opted-in");
  });
});

describe("buildEvalGraph semantic wiring (#88)", () => {
  function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {}));
    });
  }

  it("emits search_semantic_layer spans for UC-01 data questions, blocks NPS, and cites definitions", async () => {
    const searchQueries: string[] = [];
    let stub: Server | null = null;
    const tracesDir = mkdtempSync(path.join(tmpdir(), "eval-semantic-"));
    const mcp = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const method = body["method"];
      const id = (body["id"] as number | undefined) ?? 0;
      const params = (body["params"] ?? {}) as Record<string, unknown>;
      if (method === "initialize") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: String(params["protocolVersion"] ?? "2025-11-25"),
              capabilities: { tools: {} },
              serverInfo: { name: "stub-eval", version: "0" },
            },
          })}\n\n`,
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (method === "tools/call") {
        const toolName = String(params["name"] ?? "");
        const args = (params["arguments"] ?? {}) as Record<string, unknown>;
        if (toolName === "search_semantic_layer") {
          const q = String(args["query"] ?? "");
          searchQueries.push(q);
          const chunks = q.includes("NPS")
            ? [
                {
                  chunkId: "metric:net_revenue",
                  docType: "metric",
                  table: "order_items",
                  tables: ["orders", "order_items"],
                  metricName: "net_revenue",
                  content: "Metric net_revenue (Doanh thu thuần)",
                  score: 0.25,
                  aliasMatched: false,
                  denseScore: 0.12,
                },
              ]
            : q.includes("hoạt động")
              ? [
                  {
                    chunkId: "metric:active_customers",
                    docType: "metric",
                    table: "orders",
                    tables: ["orders", "customers"],
                    metricName: "active_customers",
                    content: "Khách hàng hoạt động counts distinct customers with >= 1 delivered order",
                    score: 0.95,
                    aliasMatched: true,
                    denseScore: 0.94,
                  },
                ]
              : [
                  {
                    chunkId: "table:regions",
                    docType: "table",
                    table: "regions",
                    tables: ["regions"],
                    metricName: null,
                    content: "Table regions (34 provinces)",
                    score: 0.9,
                    aliasMatched: true,
                    denseScore: 0.91,
                  },
                ];
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify({ chunks }) }] },
            })}\n\n`,
          );
          return;
        }
      }
      res.writeHead(400);
      res.end();
    });

    await new Promise<void>((resolve) => {
      stub = mcp.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (stub!.address() as AddressInfo).port;
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;

    try {
      const checkpointer = new MemorySaver();
      let executorCalls = 0;

      // 1. Standard UC-01 data question (requestedMetrics: [])
      const dataRunId = "eval-data-run-1";
      const dataEmit = createEvalEmitter(tracesDir, {
        runId: dataRunId,
        threadId: `chat:sales_south:${dataRunId}`,
        userId: "sales_south",
        role: "sales_south",
      });
      const dataGraph = buildEvalGraph({
        checkpointer,
        emitSpan: dataEmit,
        textToSql: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => ({
                metric: null,
                dimensions: [],
                filters: [],
                timeRange: null,
                requestedMetrics: [],
                schemaEntities: ["regions"],
                queryMode: "standard_query" as const,
              }),
            }),
          },
          executor: {
            run: async () => {
              executorCalls += 1;
              return {
                status: "ok",
                sql: "SELECT COUNT(*) AS n FROM public.regions",
                tablesUsed: ["regions"],
                columns: ["n"],
                rows: [{ n: 34 }],
                maskedColumns: [],
                attempts: 1,
              };
            },
          },
        },
      });
      const dataOut = await dataGraph.invoke(
        {
          question: "Có bao nhiêu tỉnh/thành trong dữ liệu?",
          ucId: TEXT_TO_SQL_UC_ID,
          runId: dataRunId,
          threadId: `chat:sales_south:${dataRunId}`,
        },
        {
          configurable: {
            thread_id: `chat:sales_south:${dataRunId}`,
            mcpUrl,
            token: "stub-token",
            runId: dataRunId,
            userId: "sales_south",
            roleScope: "sales_south",
            tracesDir,
          },
        },
      );
      dataEmit.emitRunDone(dataOut.status);
      expect(dataOut.status).toBe("ok");
      expect(dataOut.sql).toMatch(/^-- @citations: table:regions\n/);
      const dataEvents = readFileSync(path.join(tracesDir, `${dataRunId}.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; payload?: { tool?: string } });
      expect(
        dataEvents.some(
          (e) => e.type === "tool_call" && e.payload?.tool === "search_semantic_layer",
        ),
      ).toBe(true);

      // 2. Unknown KPI (NPS) returns cannot_answer listing closest metrics with 0 SQL
      executorCalls = 0;
      const npsRunId = "eval-nps-run-1";
      const npsEmit = createEvalEmitter(tracesDir, {
        runId: npsRunId,
        threadId: `chat:sales_south:${npsRunId}`,
        userId: "sales_south",
        role: "sales_south",
      });
      const npsGraph = buildEvalGraph({
        checkpointer,
        emitSpan: npsEmit,
        textToSql: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => ({
                metric: null,
                dimensions: [],
                filters: [],
                timeRange: null,
                requestedMetrics: ["NPS"],
                schemaEntities: [],
                queryMode: "standard_query" as const,
              }),
            }),
          },
          executor: {
            run: async () => {
              executorCalls += 1;
              throw new Error("executor must not run for unknown KPI");
            },
          },
        },
      });
      const npsOut = await npsGraph.invoke(
        {
          question: "Chỉ số NPS của chúng ta là bao nhiêu?",
          ucId: TEXT_TO_SQL_UC_ID,
          runId: npsRunId,
          threadId: `chat:sales_south:${npsRunId}`,
        },
        {
          configurable: {
            thread_id: `chat:sales_south:${npsRunId}`,
            mcpUrl,
            token: "stub-token",
            runId: npsRunId,
            userId: "sales_south",
            roleScope: "sales_south",
            tracesDir,
          },
        },
      );
      expect(npsOut.status).toBe("cannot_answer");
      expect(npsOut.answerText).toMatch(/NPS/);
      expect(npsOut.answerText).toMatch(/metric:net_revenue/);
      expect(executorCalls).toBe(0);

      // 3. Definition question returns cited metric chunks with 0 SQL
      const defRunId = "eval-def-run-1";
      const defEmit = createEvalEmitter(tracesDir, {
        runId: defRunId,
        threadId: `chat:sales_south:${defRunId}`,
        userId: "sales_south",
        role: "sales_south",
      });
      const defGraph = buildEvalGraph({
        checkpointer,
        emitSpan: defEmit,
        textToSql: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => ({
                metric: "active_customers",
                dimensions: [],
                filters: [],
                timeRange: null,
                requestedMetrics: ["khách hàng hoạt động"],
                schemaEntities: [],
                queryMode: "definition_lookup" as const,
              }),
            }),
          },
          executor: {
            run: async () => {
              executorCalls += 1;
              throw new Error("executor must not run for definition lookup");
            },
          },
        },
      });
      const defOut = await defGraph.invoke(
        {
          question: "Khách hàng hoạt động được tính thế nào?",
          ucId: TEXT_TO_SQL_UC_ID,
          runId: defRunId,
          threadId: `chat:sales_south:${defRunId}`,
        },
        {
          configurable: {
            thread_id: `chat:sales_south:${defRunId}`,
            mcpUrl,
            token: "stub-token",
            runId: defRunId,
            userId: "sales_south",
            roleScope: "sales_south",
            tracesDir,
          },
        },
      );
      expect(defOut.status).toBe("ok");
      expect(defOut.sql).toBeNull();
      expect(defOut.answerText).toMatch(/metric:active_customers/);
      expect(defOut.answerText).toMatch(/Citations:/);
      expect(executorCalls).toBe(0);
      expect(searchQueries).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve) => {
        if (stub) stub.close(() => resolve());
        else resolve();
      });
    }
  });
});
