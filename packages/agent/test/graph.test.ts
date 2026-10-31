import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { buildRootGraph } from "../src/graph.js";
import {
  AgentStateSchema,
  type AgentState,
  type AgentUpdate,
} from "../src/state.js";
import {
  DEFAULT_ROUTE_ID,
  isKnownUc,
  registerUC,
} from "../src/subgraphs/registry.js";
import { UC01_ID } from "../src/subgraphs/uc01.js";

// AGENT-01 seam tests (01-10): FakeListChatModel doubles plus stubbed
// retrieve and UC handlers injected through RootGraphDeps — no API key and
// no live DB or MCP server needed. The live default route stays covered by
// tracer.test.ts and pnpm demo:tracer.

const ProposalSchema = z.object({
  sql: z.string().min(1),
  tablesUsed: z.array(z.string()),
});

function invokeOptions(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

describe("root graph seam", () => {
  it("runs the node chain end to end through injected doubles", async () => {
    const order: string[] = [];
    const graph = buildRootGraph({
      retrieve: async () => {
        order.push("retrieve");
        return { semanticChunks: [{ chunkId: "chunk-1" }] };
      },
      ucHandlers: {
        "uc-alpha": async (state: AgentState): Promise<AgentUpdate> => {
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
            toolsCalled: [...state.toolsCalled, "uc-alpha"],
            status: "ok",
            answerText: "alpha says ok",
          };
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
      { question: "how many?", ucId: "uc-alpha", runId: "r1", threadId: "t1" },
      invokeOptions("t1"),
    );

    // Wired order: understand (intent stub) -> retrieve -> router ->
    // ucEntry -> statusCheck -> vizSeam -> answer.
    expect(order).toEqual(["retrieve", "uc:orders", "vizSeam", "synthesize"]);
    expect(out.status).toBe("ok");
    expect(out.answerText).toBe("alpha says ok");
    expect(out.intent).toEqual({
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
      queryMode: "standard_query",
    });
    expect(out.semanticChunks).toEqual([{ chunkId: "chunk-1" }]);
    expect(out.toolsCalled).toEqual(["uc-alpha"]);
  });

  it("routes a registry-registered UC without touching the root builder", async () => {
    const id = "uc-test-beta";
    registerUC(id, async () => ({ status: "ok", answerText: "beta ok" }));
    expect(isKnownUc(id)).toBe(true);

    const out = await buildRootGraph().invoke(
      { question: "q", ucId: id },
      invokeOptions("t-beta"),
    );
    expect(out.status).toBe("ok");
    expect(out.answerText).toBe("beta ok");
  });

  it("falls through to the default tracer route for unknown UC ids", async () => {
    expect(isKnownUc("nope-unknown")).toBe(false);
    let called = false;
    const graph = buildRootGraph({
      ucHandlers: {
        [DEFAULT_ROUTE_ID]: async () => {
          called = true;
          return { status: "no_data", answerText: "default fallback" };
        },
      },
    });

    const out = await graph.invoke(
      { question: "q", ucId: "nope-unknown" },
      invokeOptions("t-fallback"),
    );
    expect(called).toBe(true);
    expect(out.status).toBe("no_data");
    expect(out.answerText).toBe("default fallback");
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
        ucHandlers: {
          "uc-status": async () => ({
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
        { question: "q", ucId: "uc-status" },
        invokeOptions(`t-status-${status}`),
      );
      expect(vizCalled).toBe(viz);
      expect(out.status).toBe(status);
      expect(out.answerText).toBe(`partial ${status}`);
    });
  }

  it("seeds D-13 budget defaults on a fresh run", async () => {
    const graph = buildRootGraph({
      ucHandlers: {
        [DEFAULT_ROUTE_ID]: async () => ({
          status: "no_data",
          answerText: "x",
        }),
      },
    });
    const out = await graph.invoke(
      { question: "q", ucId: "zzz-unknown" },
      invokeOptions("t-seed"),
    );
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
      ucHandlers: {
        "uc-big": async () => ({
          status: "ok",
          resultPreview: Array.from({ length: 61 }, (_, i) => ({ n: i })),
        }),
      },
    });
    await expect(
      graph.invoke({ question: "q", ucId: "uc-big" }, invokeOptions("t-big")),
    ).rejects.toThrow();
  });

  it("merges budget and telemetry counters instead of overwriting", async () => {
    const graph = buildRootGraph({
      retrieve: async () => ({
        budget: { llmCalls: 2, tokensUsed: 100 },
        telemetry: { promptTokens: 10, completionTokens: 20, latencyMs: 5 },
      }),
      ucHandlers: {
        "uc-budget": async () => ({
          status: "ok",
          answerText: "b",
          budget: { llmCalls: 3, tokensUsed: 50 },
          telemetry: { promptTokens: 1, completionTokens: 2, latencyMs: 3 },
        }),
      },
    });

    const out = await graph.invoke(
      { question: "q", ucId: "uc-budget" },
      invokeOptions("t-budget"),
    );
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
    expect(specifiers).toContain("./subgraphs/registry.js");
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
    expect(source).toContain("FROZEN");
  });

  it("runs UC-01 intent extraction, skill tracing, and the injected executor", async () => {
    const spans: { node: string; type: string }[] = [];
    const runs: unknown[] = [];
    const graph = buildRootGraph({
      emitSpan: ({ node, type }) => {
        spans.push({ node, type });
        return "span-1";
      },
      uc01: {
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
      { question: "How many orders per status?", ucId: UC01_ID },
      {
        configurable: {
          thread_id: "thread-uc01",
          runId: "run-uc01",
          userId: "user-uc01",
          roleScope: "sales_south",
        },
      },
    );

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
        principal: { runId: "run-uc01", userId: "user-uc01", roleScope: "sales_south" },
      }),
    ]);
    expect(spans).toContainEqual({ node: "skills", type: "skill_call" });
  });

  it("stops an exhausted UC-01 budget before the model or executor", async () => {
    let modelCalled = false;
    let executorCalled = false;
    const graph = buildRootGraph({
      uc01: {
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
      { question: "q", ucId: UC01_ID, budget: { llmCalls: 20 } },
      invokeOptions("t-exhausted"),
    );

    expect(out.status).toBe("cannot_answer");
    expect(out.answerText).toContain("Run budget exceeded");
    expect(modelCalled).toBe(false);
    expect(executorCalled).toBe(false);
  });

  it("exposes only the root surface from the barrel", async () => {
    const index = (await import("../src/index.js")) as Record<string, unknown>;
    expect(typeof index["buildRootGraph"]).toBe("function");
    expect(typeof index["registerUC"]).toBe("function");
    expect(typeof index["AgentStateSchema"]).toBe("object");
    expect(index["DEFAULT_ROUTE_ID"]).toBe("tracer");
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
});
