import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { buildRootGraph } from "../src/graph.js";
import {
  AgentStateSchema,
  type AgentState,
  type AgentUpdate,
} from "../src/state.js";
import { RCA_ROUTE, TEXT_TO_SQL_ROUTE } from "../src/constants.js";
import { routeQuestion } from "../src/router.js";
import { resumeDecision } from "../src/hitl.js";
import type { ExecutorRunInput } from "../src/queryExecutor/executor.js";

// AGENT-01 seam tests (01-10): FakeListChatModel doubles plus stubbed
// retrieve and route entry handlers injected through RootGraphDeps — no API
// key and no live DB or MCP server needed. The router decides the route
// from the question (issue #98); a caller-supplied route is overwritten.

const ProposalSchema = z.object({
  sql: z.string().min(1),
  tablesUsed: z.array(z.string()),
});

function invokeOptions(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

function pendingFromInterrupt(output: unknown) {
  const first = (output as { __interrupt__?: { value?: unknown }[] }).__interrupt__?.[0];
  return (first?.value as { pendingClarification?: unknown } | undefined)?.pendingClarification as
    | { field: string; options: string[]; attempts: number }
    | undefined;
}

/** Minimal offline text-to-SQL deps so the real understand node succeeds. */
function stubTextToSql() {
  return {
    listTables: async () => [{ name: "orders", schema: "public" }],
    intentModel: {
      withStructuredOutput: () => ({
        invoke: async () => ({
          metric: null,
          dimensions: [],
          filters: [],
          timeRange: null,
          requestedMetrics: [],
          schemaEntities: [],
          queryMode: "standard_query" as const,
        }),
      }),
    },
  };
}

describe("root graph seam", () => {
  it("runs the node chain end to end through injected doubles", async () => {
    const order: string[] = [];
    const rcaCalled: string[] = [];
    const graph = buildRootGraph({
      retrieve: async () => {
        order.push("retrieve");
        return { semanticChunks: [{ chunkId: "chunk-1" }] };
      },
      routes: {
        "text-to-sql": async (state: AgentState): Promise<AgentUpdate> => {
          // FakeListChatModel double: exercises the structured-output path
          // with no API key, standing in for a real UC proposal step.
          const fake = new FakeListChatModel({
            responses: [
              JSON.stringify({ sql: "SELECT 1", tablesUsed: ["orders"] }),
            ],
          });
          const proposal = await fake
            .withStructuredOutput(ProposalSchema, { name: "sql_proposal" })
            .invoke(state.question);
          order.push(`uc:${proposal.tablesUsed[0] ?? "none"}`);
          return {
            sql: proposal.sql,
            tablesUsed: proposal.tablesUsed,
            resultPreview: [{ n: 1 }],
            toolsCalled: [...state.toolsCalled, "tts-alpha"],
            status: "ok",
            answerText: "alpha says ok",
          };
        },
        "root-cause-analysis": async () => {
          rcaCalled.push("rca");
          return { status: "ok", answerText: "should not run" };
        },
      },
      textToSql: {
        listTables: async () => [{ name: "orders", schema: "public" }],
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => ({
              metric: "order_count",
              dimensions: ["status"],
              filters: [],
              timeRange: null,
              requestedMetrics: ["order_count"],
              schemaEntities: ["orders"],
              queryMode: "standard_query" as const,
            }),
          }),
        },
      },
      viz: async () => {
        order.push("vizSeam");
        return { vizSpec: { kind: "table" } };
      },
      synthesize: async (state: AgentState) => {
        order.push("synthesize");
        return state.answerText.length > 0 ? {} : { answerText: "derived" };
      },
      emitSpan: () => "",
    });

    const out = await graph.invoke(
      { question: "How many orders per status?", runId: "r1", threadId: "t1" },
      invokeOptions("t1"),
    );

    // Wired order: router -> budgetGuard -> understand -> retrieve ->
    // textToSqlEntry -> statusCheck -> vizSeam -> answer.
    expect(order).toEqual(["retrieve", "uc:orders", "vizSeam", "synthesize"]);
    expect(rcaCalled).toEqual([]);
    expect(out.route).toBe("text-to-sql");
    expect(out.status).toBe("ok");
    expect(out.answerText).toBe("alpha says ok");
    expect(out.intent).toMatchObject({
      requestedMetrics: ["order_count"],
      schemaEntities: ["orders"],
      queryMode: "standard_query",
    });
    expect(out.semanticChunks).toEqual([{ chunkId: "chunk-1" }]);
    expect(out.toolsCalled).toEqual(["list_tables", "tts-alpha"]);
  });

  const routingCases: { status: AgentState["status"]; viz: boolean }[] = [
    { status: "ok", viz: true },
    { status: "no_data", viz: true },
    { status: "needs_clarification", viz: false },
    { status: "restricted", viz: false },
    { status: "cannot_answer", viz: false },
    { status: "error", viz: false },
  ];
  for (const { status, viz } of routingCases) {
    it(`routes status ${status} ${viz ? "through" : "past"} the VIZ seam`, async () => {
      let vizCalled = false;
      const graph = buildRootGraph({
        textToSql: stubTextToSql(),
        routes: {
          "text-to-sql": async () => ({
            status,
            answerText: `partial ${status}`,
          }),
        },
        viz: async () => {
          vizCalled = true;
          return {};
        },
      });

      const out = await graph.invoke(
        { question: "q" },
        invokeOptions(`t-status-${status}`),
      );
      expect(vizCalled).toBe(viz);
      expect(out.status).toBe(status);
      expect(out.answerText).toBe(`partial ${status}`);
    });
  }

  it("seeds D-13 budget defaults on a fresh run", async () => {
    const graph = buildRootGraph({
      routes: {
        "root-cause-analysis": async () => ({
          status: "no_data",
          answerText: "x",
        }),
      },
    });
    const out = await graph.invoke(
      { question: "Vì sao doanh thu giảm so với tháng trước?" },
      invokeOptions("t-seed"),
    );
    expect(out.route).toBe("root-cause-analysis");
    expect(out.budget).toMatchObject({
      llmCalls: 0,
      tokensUsed: 0,
      maxLlmCalls: 20,
      maxTokens: 60000,
      deadlineMs: 0,
    });
  });

  it("rejects resultPreview beyond 50 rows at the schema boundary", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ n: i }));
    await expect(
      AgentStateSchema.validateInput({ resultPreview: rows }),
    ).rejects.toThrow(/too_big|maximum|50/);
  });

  it("rejects a handler update that exceeds the preview cap", async () => {
    const graph = buildRootGraph({
      textToSql: stubTextToSql(),
      routes: {
        "text-to-sql": async () => ({
          status: "ok",
          resultPreview: Array.from({ length: 61 }, (_, i) => ({ n: i })),
        }),
      },
    });
    await expect(
      graph.invoke({ question: "q" }, invokeOptions("t-big")),
    ).rejects.toThrow();
  });

  it("merges budget and telemetry counters instead of overwriting", async () => {
    const graph = buildRootGraph({
      retrieve: async () => ({
        budget: { llmCalls: 2, tokensUsed: 100 },
        telemetry: { promptTokens: 10, completionTokens: 20, latencyMs: 5 },
      }),
      routes: {
        "root-cause-analysis": async () => ({
          status: "ok",
          answerText: "b",
          budget: { llmCalls: 3, tokensUsed: 50 },
          telemetry: { promptTokens: 1, completionTokens: 2, latencyMs: 3 },
        }),
      },
    });

    const out = await graph.invoke(
      { question: "Vì sao doanh thu giảm so với tháng trước?" },
      invokeOptions("t-budget"),
    );
    expect(out.route).toBe("root-cause-analysis");
    expect(out.budget.llmCalls).toBe(5);
    expect(out.budget.tokensUsed).toBe(150);
    expect(out.budget.maxLlmCalls).toBe(20);
    expect(out.budget.maxTokens).toBe(60000);
    expect(out.budget.deadlineMs).toBe(0);
    expect(out.telemetry).toEqual({
      promptTokens: 11,
      completionTokens: 22,
      latencyMs: 8,
    });
  });

  it("keeps graph.ts on the seam-only import boundary", () => {
    const source = readFileSync(
      new URL("../src/graph.ts", import.meta.url),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(specifiers).toContain("./state.js");
    expect(specifiers).toContain("./router.js");
    expect(specifiers).not.toContain("./subgraphs/registry.js");
    const banned = [
      "queryExecutor",
      "models/",
      "skills/",
      "mcpClient",
      "hitl",
      "telemetry",
      "ports",
      "pg",
      "pg-cursor",
      "mcp-server",
    ];
    for (const spec of specifiers) {
      for (const bad of banned) {
        expect(
          `${spec ?? ""}`.includes(bad),
          `graph.ts imports banned module '${bad}' via '${spec ?? ""}'`,
        ).toBe(false);
      }
    }
    // The route is decided once, before the budget guard: the router node
    // reads the question and overwrites any caller-supplied route.
    expect(source).toContain("routeQuestion");
    expect(source).toContain("\"router\"");
  });

  it("runs text-to-SQL intent extraction, skill tracing, and the injected executor", async () => {
    const spans: { node: string; type: string }[] = [];
    const runs: ExecutorRunInput[] = [];
    const graph = buildRootGraph({
      emitSpan: ({ node, type }) => {
        spans.push({ node, type });
        return "span-1";
      },
      // UC-02 two-tier gate: metric queries must be grounded. Provide the
      // retrieved turn context so order_count passes the gate.
      retrieve: async () => ({
        semanticChunks: [
          { chunkId: "metric:order_count", text: "order count", aliasMatched: true, denseScore: 0.95 },
        ],
      }),
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => ({
              metric: "order_count",
              dimensions: ["status"],
              filters: [],
              timeRange: null,
              requestedMetrics: ["order_count"],
              schemaEntities: ["orders"],
              queryMode: "standard_query" as const,
            }),
          }),
        },
        executor: {
          timeRangeOptions: async () => [
            "2026-04-01/2026-07-01",
            "2026-07-01/2026-10-01",
          ],
          run: async (input) => {
            runs.push(input);
            return {
              status: "ok" as const,
              sql: "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status",
              tablesUsed: ["orders"],
              columns: ["status", "n"],
              rows: [{ status: "delivered", n: 1 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "How many orders per status?" },
      {
        configurable: {
          thread_id: "thread-text-to-sql",
          runId: "run-text-to-sql",
          userId: "user-text-to-sql",
          roleScope: "sales_south",
        },
      },
    );

    expect(out.route).toBe("text-to-sql");
    expect(out.intent).toMatchObject({
      requestedMetrics: ["order_count"],
      schemaEntities: ["orders"],
      queryMode: "standard_query",
    });
    expect(out.budget.llmCalls).toBe(1);
    expect(out.budget.deadlineMs).toBeGreaterThan(Date.now() - 120000);
    expect(runs).toEqual([
      expect.objectContaining({
        candidateTables: ["orders"],
        principal: { runId: "run-text-to-sql", userId: "user-text-to-sql", roleScope: "sales_south" },
        budget: expect.objectContaining({ llmCalls: 1 }),
      }),
    ]);
    expect(spans).toContainEqual({ node: "skills", type: "skill_call" });
  });

  it("resumes a large-query clarification on the same thread without re-running understand", async () => {
    let intentCalls = 0;
    const questions: string[] = [];
    const graph = buildRootGraph({
      retrieve: async () => ({
        semanticChunks: [
          {
            chunkId: "metric:order_count",
            text: "order_count metric definition",
            aliasMatched: true,
          },
        ],
      }),
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => {
              intentCalls += 1;
              return {
                metric: "order_count",
                dimensions: [],
                filters: [],
                timeRange: null,
                requestedMetrics: ["order_count"],
                schemaEntities: ["orders"],
                queryMode: "standard_query" as const,
              };
            },
          }),
        },
        executor: {
          timeRangeOptions: async () => [
            "2026-04-01/2026-07-01",
            "2026-07-01/2026-10-01",
          ],
          run: async (input) => {
            questions.push(input.question);
            if (!input.question.includes("Clarification (timeRange)")) {
              return {
                status: "needs_clarification" as const,
                reason: "orders needs an indexed time filter",
                table: "orders",
                sql: null,
                attempts: 1,
              };
            }
            return {
              status: "ok" as const,
              sql: "SELECT COUNT(*) AS n FROM public.orders WHERE purchase_date >= '2026-01-01'",
              tablesUsed: ["orders"],
              columns: ["n"],
              rows: [{ n: 1 }],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });
    const config = {
      configurable: {
        thread_id: "thread-clarify",
        runId: "run-clarify",
        userId: "user-clarify",
        roleScope: "sales_south",
      },
    };

    const paused = await graph.invoke(
      { question: "Show orders" },
      config,
    );
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toHaveLength(1);
    const pending = pendingFromInterrupt(paused);
    expect(pending).toMatchObject({
      field: "timeRange",
      attempts: 0,
      options: expect.any(Array),
    });

    const selected = pending?.options[0];
    if (!selected) throw new Error("missing clarification option");
    const completed = await graph.invoke(resumeDecision(selected), config);
    expect(completed.status).toBe("ok");
    expect(completed.pendingClarification).toBeNull();
    expect(completed.clarificationAttempts).toBe(1);
    expect(completed.intent.timeRange).toBe(selected);
    expect(intentCalls).toBe(1);
    // LangGraph restarts the interrupted UC node on resume, so the guarded
    // proposal runs once more; the intent extraction node is not re-run.
    expect(questions).toHaveLength(3);
    expect(questions[2]).toContain(`Clarification (timeRange): ${selected}`);
  });

  it("pauses before the executor when intent has multiple KPI candidates", async () => {
    let executorCalled = false;
    const graph = buildRootGraph({
      retrieve: async () => ({
        semanticChunks: [
          {
            chunkId: "metric:net_revenue",
            text: "net_revenue metric definition",
            aliasMatched: true,
          },
          {
            chunkId: "metric:gross_revenue",
            text: "gross_revenue metric definition",
            aliasMatched: true,
          },
        ],
      }),
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => ({
              metric: null,
              dimensions: [],
              filters: [],
              timeRange: null,
              requestedMetrics: ["net_revenue", "gross_revenue"],
              schemaEntities: ["orders"],
              queryMode: "standard_query" as const,
            }),
          }),
        },
        executor: {
          run: async () => {
            executorCalled = true;
            return {
              status: "no_data" as const,
              sql: "SELECT 1 WHERE false",
              tablesUsed: [],
              columns: [],
              rows: [],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });
    const paused = await graph.invoke(
      { question: "Doanh thu" },
      {
        configurable: {
          thread_id: "thread-metric",
          runId: "run-metric",
          userId: "user-metric",
          roleScope: "sales_south",
        },
      },
    );
    expect(executorCalled).toBe(false);
    expect(pendingFromInterrupt(paused)).toMatchObject({
      field: "metric",
      options: ["net_revenue", "gross_revenue"],
    });
    expect((paused as { __interrupt__?: unknown[] }).__interrupt__).toHaveLength(1);
  });

  it("does not run an ambiguous KPI query after the two-selection limit", async () => {
    let executorCalled = false;
    const graph = buildRootGraph({
      retrieve: async () => ({
        semanticChunks: [
          {
            chunkId: "metric:net_revenue",
            text: "net_revenue metric definition",
            aliasMatched: true,
          },
          {
            chunkId: "metric:gross_revenue",
            text: "gross_revenue metric definition",
            aliasMatched: true,
          },
        ],
      }),
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => ({
              metric: null,
              dimensions: [],
              filters: [],
              timeRange: null,
              requestedMetrics: ["net_revenue", "gross_revenue"],
              schemaEntities: ["orders"],
              queryMode: "standard_query" as const,
            }),
          }),
        },
        executor: {
          run: async () => {
            executorCalled = true;
            throw new Error("executor must not run after clarification exhaustion");
          },
        },
      },
    });

    const out = await graph.invoke(
      {
        question: "Doanh thu",
        clarificationAttempts: 2,
      },
      invokeOptions("thread-metric-exhausted"),
    );

    expect(out.status).toBe("needs_clarification");
    expect(out.answerText).toContain("could not be disambiguated");
    expect(executorCalled).toBe(false);
  });

  it("stops after two invalid clarification responses", async () => {
    const graph = buildRootGraph({
      retrieve: async () => ({
        semanticChunks: [
          {
            chunkId: "metric:net_revenue",
            text: "net_revenue metric definition",
            aliasMatched: true,
          },
          {
            chunkId: "metric:gross_revenue",
            text: "gross_revenue metric definition",
            aliasMatched: true,
          },
        ],
      }),
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => ({
              metric: null,
              dimensions: [],
              filters: [],
              timeRange: null,
              requestedMetrics: ["net_revenue", "gross_revenue"],
              schemaEntities: ["orders"],
              queryMode: "standard_query" as const,
            }),
          }),
        },
        executor: {
          run: async () => {
            throw new Error("executor must not run for invalid clarification values");
          },
        },
      },
    });
    const config = {
      configurable: {
        thread_id: "thread-invalid-clarification",
        runId: "run-invalid-clarification",
        userId: "user-invalid-clarification",
        roleScope: "sales_south",
      },
    };
    await graph.invoke({ question: "Doanh thu" }, config);
    const retry = await graph.invoke(resumeDecision("other"), config);
    expect((retry as { __interrupt__?: unknown[] }).__interrupt__).toHaveLength(1);
    expect(pendingFromInterrupt(retry)?.attempts).toBe(1);

    const stopped = await graph.invoke(resumeDecision("still-other"), config);
    expect((stopped as { __interrupt__?: unknown[] }).__interrupt__).toBeUndefined();
    expect(stopped.status).toBe("needs_clarification");
    expect(stopped.pendingClarification).toBeNull();
    expect(stopped.answerText).toContain("two responses");
  });

  it("stops an exhausted text-to-SQL budget before the model or executor", async () => {
    let modelCalled = false;
    let executorCalled = false;
    const graph = buildRootGraph({
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => {
              modelCalled = true;
              return {
                metric: null,
                dimensions: [],
                filters: [],
                timeRange: null,
                requestedMetrics: [],
                schemaEntities: [],
                queryMode: "standard_query" as const,
              };
            },
          }),
        },
        executor: {
          run: async () => {
            executorCalled = true;
            return {
              status: "no_data" as const,
              sql: "SELECT 1 WHERE false",
              tablesUsed: [],
              columns: [],
              rows: [],
              maskedColumns: [],
              attempts: 1,
            };
          },
        },
      },
    });

    const out = await graph.invoke(
      { question: "q", budget: { llmCalls: 20 } },
      invokeOptions("t-exhausted"),
    );

    expect(out.route).toBe("text-to-sql");
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toContain("Run budget exceeded");
    expect(modelCalled).toBe(false);
    expect(executorCalled).toBe(false);
  });

  it("stops an exhausted RCA budget before retrieve or the route entry", async () => {
    let retrieveCalled = false;
    let handlerCalled = false;
    const graph = buildRootGraph({
      retrieve: async () => {
        retrieveCalled = true;
        return {};
      },
      routes: {
        "root-cause-analysis": async () => {
          handlerCalled = true;
          return { status: "ok", answerText: "should not run" };
        },
      },
    });

    const out = await graph.invoke(
      { question: "Vì sao doanh thu giảm so với tháng trước?", budget: { llmCalls: 20 } },
      invokeOptions("t-generic-exhausted"),
    );

    expect(out.route).toBe("root-cause-analysis");
    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toContain("Run budget exceeded");
    expect(retrieveCalled).toBe(false);
    expect(handlerCalled).toBe(false);
  });

  it("exposes only the root surface from the barrel", async () => {
    const index = (await import("../src/index.js")) as Record<string, unknown>;
    expect(typeof index["buildRootGraph"]).toBe("function");
    expect(typeof index["routeQuestion"]).toBe("function");
    expect(typeof index["createAnswerSynthesizer"]).toBe("function");
    expect(typeof index["previewCountKey"]).toBe("function");
    expect(typeof index["AgentStateSchema"]).toBe("object");
    expect(index["TEXT_TO_SQL_ROUTE"]).toBe("text-to-sql");
    expect(index["RCA_ROUTE"]).toBe("root-cause-analysis");
    expect(index["ROUTES"]).toEqual(["text-to-sql", "root-cause-analysis"]);
    for (const banned of [
      "createChatModel",
      "callMcpTool",
      "loadSkill",
      "createSpanEmitter",
      "createCheckpointer",
    ]) {
      expect(banned in index, `barrel leaks sibling service '${banned}'`).toBe(
        false,
      );
    }
  });

  it("retries intentModel 429 twice then succeeds on text-to-sql, or stops with RATE_LIMITED when exhausted", async () => {
    const saved = {
      max: process.env.AGENT_MODEL_MAX_RETRIES,
      base: process.env.AGENT_MODEL_RETRY_BASE_MS,
      maxWait: process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS,
    };
    process.env.AGENT_MODEL_MAX_RETRIES = "2";
    process.env.AGENT_MODEL_RETRY_BASE_MS = "50";
    process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS = "100";
    try {
      let okCalls = 0;
      const spans: { node: string; type: string; payload?: unknown }[] = [];
      const okGraph = buildRootGraph({
        emitSpan: (event) => {
          spans.push({ node: event.node, type: event.type, payload: event.payload });
          return `s-${spans.length}`;
        },
        retrieve: async () => ({
          semanticChunks: [
            { chunkId: "metric:order_count", text: "order_count", aliasMatched: true },
          ],
        }),
        textToSql: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                okCalls += 1;
                if (okCalls <= 2) {
                  throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
                }
                return {
                  metric: "order_count",
                  dimensions: ["status"],
                  filters: [],
                  timeRange: null,
                  requestedMetrics: ["order_count"],
                  schemaEntities: ["orders"],
                  queryMode: "standard_query" as const,
                };
              },
            }),
          },
          executor: {
            run: async () => ({
              status: "ok" as const,
              sql: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
              tablesUsed: ["orders"],
              columns: ["status", "n"],
              rows: [{ status: "delivered", n: 4 }],
              maskedColumns: [],
              attempts: 1,
            }),
          },
        },
      });
      const okOut = await okGraph.invoke(
        { question: "How many orders?" },
        {
          configurable: {
            thread_id: "thread-429-ok",
            runId: "run-429-ok",
            userId: "u1",
            roleScope: "sales_south",
          },
        },
      );
      expect(okOut.status).toBe("ok");
      expect(okCalls).toBe(3);
      expect(okOut.budget.llmCalls).toBe(3);
      expect(spans.filter((s) => s.type === "retry")).toHaveLength(2);

      // Persistent 429 on intentModel stops cleanly with RATE_LIMITED without calling executor.
      let executorCalled = false;
      const failGraph = buildRootGraph({
        textToSql: {
          intentModel: {
            withStructuredOutput: () => ({
              invoke: async () => {
                throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
              },
            }),
          },
          executor: {
            run: async () => {
              executorCalled = true;
              throw new Error("executor must not run when intentModel is rate-limited");
            },
          },
        },
      });
      const failOut = await failGraph.invoke(
        { question: "How many orders?" },
        {
          configurable: {
            thread_id: "thread-429-fail",
            runId: "run-429-fail",
            userId: "u1",
            roleScope: "sales_south",
          },
        },
      );
      expect(executorCalled).toBe(false);
      expect(failOut.status).toBe("error");
      expect(failOut.answerText).toContain("RATE_LIMITED");
      expect(failOut.budget.llmCalls).toBe(3);
      expect(failOut.budget.tokensUsed).toBe(0);
    } finally {
      if (saved.max === undefined) delete process.env.AGENT_MODEL_MAX_RETRIES;
      else process.env.AGENT_MODEL_MAX_RETRIES = saved.max;
      if (saved.base === undefined) delete process.env.AGENT_MODEL_RETRY_BASE_MS;
      else process.env.AGENT_MODEL_RETRY_BASE_MS = saved.base;
      if (saved.maxWait === undefined) delete process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS;
      else process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS = saved.maxWait;
    }
  });
});

describe("router decides the route from the question (issue #98)", () => {
  function routedDoubles() {
    const calls: string[] = [];
    const spans: { node: string; type: string; payload?: unknown }[] = [];
    const graph = buildRootGraph({
      emitSpan: (event) => {
        spans.push({ node: event.node, type: event.type, payload: event.payload });
        return `s-${spans.length}`;
      },
      textToSql: stubTextToSql(),
      routes: {
        "text-to-sql": async () => {
          calls.push("text-to-sql");
          return { status: "ok" as const, answerText: "tts says ok" };
        },
        "root-cause-analysis": async () => {
          calls.push("root-cause-analysis");
          return { status: "ok" as const, answerText: "rca says ok" };
        },
      },
      synthesize: async (state: AgentState) =>
        state.answerText.length > 0 ? {} : { answerText: "derived" },
    });
    return { graph, calls, spans };
  }

  it("runs the text-to-sql entry for a plain data question with no routing field", async () => {
    const { graph, calls } = routedDoubles();
    const out = await graph.invoke(
      { question: "How many orders per status?" },
      invokeOptions("t-route-plain"),
    );
    expect(routeQuestion("How many orders per status?")).toBe(TEXT_TO_SQL_ROUTE);
    expect(calls).toEqual(["text-to-sql"]);
    expect(out.route).toBe("text-to-sql");
    expect(out.answerText).toBe("tts says ok");
  });

  it("routes the active-customers definition question to text-to-sql", async () => {
    const question = "Khách hàng hoạt động được tính thế nào?";
    const { graph, calls } = routedDoubles();
    const out = await graph.invoke({ question }, invokeOptions("t-route-definition"));
    // The definition fast-path lives inside the text-to-sql entry.
    expect(routeQuestion(question)).toBe(TEXT_TO_SQL_ROUTE);
    expect(calls).toEqual(["text-to-sql"]);
    expect(out.route).toBe(TEXT_TO_SQL_ROUTE);
  });

  it("routes a why-revenue-dropped question to the RCA entry", async () => {
    const question = "Vì sao doanh thu T10 giảm so với T9?";
    const { graph, calls } = routedDoubles();
    const out = await graph.invoke({ question }, invokeOptions("t-route-rca"));
    expect(routeQuestion(question)).toBe(RCA_ROUTE);
    expect(calls).toEqual(["root-cause-analysis"]);
    expect(out.route).toBe(RCA_ROUTE);
    expect(out.answerText).toBe("rca says ok");
  });

  it("ignores a caller-supplied route for a plain data question", async () => {
    const { graph, calls } = routedDoubles();
    const out = await graph.invoke(
      { question: "How many orders per status?", route: "root-cause-analysis" },
      invokeOptions("t-route-override"),
    );
    expect(calls).toEqual(["text-to-sql"]);
    expect(out.route).toBe("text-to-sql");
  });

  it("ignores a legacy ucId in the graph input for a plain data question", async () => {
    const { graph, calls } = routedDoubles();
    const out = await graph.invoke(
      {
        question: "How many orders per status?",
        ucId: "root-cause-analysis",
      } as unknown as { question: string },
      invokeOptions("t-route-legacy"),
    );
    expect(calls).toEqual(["text-to-sql"]);
    expect(out.route).toBe("text-to-sql");
  });

  it("emits a router span with the decided route", async () => {
    const { graph, spans } = routedDoubles();
    await graph.invoke(
      { question: "How many orders per status?" },
      invokeOptions("t-route-span"),
    );
    const routerSpan = spans.find(
      (span) => span.node === "router" && span.type === "node_done",
    );
    expect(routerSpan?.payload).toEqual({ route: "text-to-sql" });
  });
});
