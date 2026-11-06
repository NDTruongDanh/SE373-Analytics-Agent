// G1 token/cost proofs (Phase 3, plan 03-01 tracer): usage_metadata mapping,
// unknown-model zero-cost, fake-shape fallback, plus one executor run proving
// a real-token llm_call span and an RBAC-carrying run_query span with no raw
// values. All DB-free: stub MCP caller, stub/spy models, never a live key.
//
// Canary literals below are invented for this proof (never seed data) so the
// DB-07 seed-hiding scan stays green.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { dbToolError } from "@shared/contracts";
import { SqlProposalSchema } from "../src/queryExecutor/executor.js";
import {
  ValidatedQueryExecutor,
  type ChatModelLike,
  type ExecutorSpan,
  type McpToolCaller,
} from "../src/queryExecutor/executor.js";
import { createBudgetState } from "../src/queryExecutor/budgets.js";
import { loadModelPricing } from "../src/telemetry/pricing.js";
import {
  estimateCostUsd,
  invokeWithUsage,
  modelFromMessage,
  usageFromMessage,
} from "../src/telemetry/usage.js";

const CANARY_PHONE = "0912 345 678";
const CANARY_EMAIL = "canary.k27@example.vn";

const KNOWN_MODEL = "openai/gpt-oss-120b";

function rawMessage(usage: unknown, model?: string): Record<string, unknown> {
  return {
    content: "proposal",
    ...(usage === undefined ? {} : { usage_metadata: usage }),
    ...(model === undefined
      ? {}
      : { response_metadata: { model } }),
  };
}

describe("usageFromMessage", () => {
  it("maps provider usage_metadata to token counts", () => {
    expect(
      usageFromMessage(
        rawMessage({ input_tokens: 100, output_tokens: 50, total_tokens: 150 }),
      ),
    ).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("yields zeros on missing, malformed, or absent usage without throwing", () => {
    expect(usageFromMessage(rawMessage(undefined))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(usageFromMessage(rawMessage(null))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      usageFromMessage(rawMessage({ input_tokens: "many", output_tokens: -3 })),
    ).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(usageFromMessage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(usageFromMessage("not-a-message")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("modelFromMessage", () => {
  it("prefers response_metadata.model, then model_name", () => {
    expect(modelFromMessage(rawMessage({}, KNOWN_MODEL))).toBe(KNOWN_MODEL);
    expect(
      modelFromMessage({
        content: "x",
        response_metadata: { model_name: "other-model" },
      }),
    ).toBe("other-model");
  });

  it("yields undefined when no model id is present", () => {
    expect(modelFromMessage(rawMessage({}))).toBeUndefined();
    expect(modelFromMessage(null)).toBeUndefined();
  });
});

describe("loadModelPricing + estimateCostUsd", () => {
  const VALID_YAML = `version: 1
models:
  ${KNOWN_MODEL}:
    inputPer1M: 0.15
    outputPer1M: 0.6
  agent-default:
    inputPer1M: 0
    outputPer1M: 0
`;

  it("parses the pricing table fixture", () => {
    const table = loadModelPricing(VALID_YAML);
    expect(table.models[KNOWN_MODEL]).toEqual({
      inputPer1M: 0.15,
      outputPer1M: 0.6,
    });
  });

  it("rejects a wrong version literal and negative rates", () => {
    expect(() =>
      loadModelPricing(
        VALID_YAML.replace("version: 1", "version: 2"),
      ),
    ).toThrow();
    expect(() =>
      loadModelPricing(VALID_YAML.replace("inputPer1M: 0.15", "inputPer1M: -1")),
    ).toThrow();
  });

  it("prices a known model exactly per 1M rates", () => {
    // 1000 input @ 0.15/1M + 500 output @ 0.60/1M = 0.00045 USD.
    const { estimatedCostUsd, pricingKnown } = estimateCostUsd(
      KNOWN_MODEL,
      1000,
      500,
    );
    expect(pricingKnown).toBe(true);
    expect(estimatedCostUsd).toBeCloseTo(0.00045, 10);
  });

  it("costs unknown or missing models at 0 with pricingKnown false, never throwing", () => {
    expect(estimateCostUsd("no-such-model", 100, 50)).toEqual({
      estimatedCostUsd: 0,
      pricingKnown: false,
    });
    expect(estimateCostUsd(undefined, 100, 50)).toEqual({
      estimatedCostUsd: 0,
      pricingKnown: false,
    });
  });
});

describe("invokeWithUsage", () => {
  const PARSED = {
    sql: "SELECT status FROM orders",
    tablesUsed: ["orders"],
  };

  it("reads the real includeRaw shape: parsed plus usage plus model", async () => {
    const model: ChatModelLike = {
      withStructuredOutput: () => ({
        invoke: async () => ({
          raw: rawMessage(
            { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            KNOWN_MODEL,
          ),
          parsed: PARSED,
        }),
      }),
    };
    const out = await invokeWithUsage(model, SqlProposalSchema, "q", {
      name: "sql_proposal",
    });
    expect(out.parsed).toEqual(PARSED);
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
    expect(out.model).toBe(KNOWN_MODEL);
  });

  it("treats the FakeListChatModel bare-parsed shape as zero-usage fallback", async () => {
    const fake = new FakeListChatModel({
      responses: [JSON.stringify(PARSED)],
    });
    const out = await invokeWithUsage(fake, SqlProposalSchema, "q", {
      name: "sql_proposal",
    });
    expect(out.parsed).toEqual(PARSED);
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.model).toBeUndefined();
  });

  it("still parses the fake shape through the schema fail-closed", async () => {
    const fake = new FakeListChatModel({
      responses: [JSON.stringify({ nope: true })],
    });
    await expect(
      invokeWithUsage(fake, SqlProposalSchema, "q", { name: "sql_proposal" }),
    ).rejects.toThrow();
  });
});

describe("executor real-token llm_call plus RBAC run_query span", () => {
  const PRINCIPAL = {
    runId: "run-usage-1",
    userId: "demo-user",
    roleScope: "sales_south",
  };

  class StubMcpCaller implements McpToolCaller {
    async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
      if (tool === "describe_table") {
        return {
          table: "orders",
          columns: [
            { name: "id", type: "integer", nullable: false, sensitive: false },
            { name: "status", type: "text", nullable: true, sensitive: false },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
        };
      }
      if (tool === "explain_query") {
        return { estimatedCost: 12.5, estimatedRows: 4 };
      }
      if (tool === "run_query") {
        void args;
        return {
          columns: ["status"],
          rows: [{ status: CANARY_PHONE, contact: CANARY_EMAIL }],
          rowCount: 1,
          truncated: false,
          maskedColumns: ["customers.phone"],
          rowScopeApplied: [{ table: "sellers", column: "region_group" }],
          durationMs: 4,
        };
      }
      throw dbToolError("INTERNAL_ERROR", `unexpected tool ${tool}`);
    }
  }

  function realUsageModel(): ChatModelLike {
    return {
      withStructuredOutput: () => ({
        invoke: async () => ({
          raw: rawMessage(
            { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            KNOWN_MODEL,
          ),
          parsed: {
            sql: "SELECT status FROM orders",
            tablesUsed: ["orders"],
          },
        }),
      }),
    };
  }

  it("emits one llm_call with real tokens/cost plus a run_query span carrying RBAC fields and no raw values", async () => {
    const seen: ExecutorSpan[] = [];
    const budget = createBudgetState();
    const executor = new ValidatedQueryExecutor({
      model: realUsageModel(),
      mcp: new StubMcpCaller(),
      emitSpan: (event) => {
        seen.push(event);
        return `span-${seen.length}`;
      },
      budget,
    });

    const result = await executor.run({
      question: "How many orders per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      budget,
    });
    expect(result.status).toBe("ok");

    const llmCalls = seen.filter((event) => event.type === "llm_call");
    expect(llmCalls).toHaveLength(1);
    const llmPayload = llmCalls[0]?.payload as Record<string, unknown>;
    expect(llmPayload["model"]).toBe(KNOWN_MODEL);
    expect(llmPayload["inputTokens"]).toBe(100);
    expect(llmPayload["outputTokens"]).toBe(50);
    expect(llmPayload["pricingKnown"]).toBe(true);
    expect(llmPayload["estimatedCostUsd"]).toBeCloseTo(
      (100 * 0.15 + 50 * 0.6) / 1_000_000,
      12,
    );
    expect(typeof llmCalls[0]?.durationMs).toBe("number");

    const runSpans = seen.filter(
      (event) =>
        event.type === "tool_call" &&
        (event.payload as { tool?: string })?.tool === "run_query",
    );
    expect(runSpans).toHaveLength(1);
    const runPayload = runSpans[0]?.payload as Record<string, unknown>;
    expect(runPayload["maskedColumns"]).toEqual(["customers.phone"]);
    expect(runPayload["rowScopeApplied"]).toEqual([
      { table: "sellers", column: "region_group" },
    ]);

    // Budget consumed real provider counts, not the estimate.
    expect(budget.tokensUsed).toBe(150);

    // No raw PII or row values in any span payload.
    const serialized = JSON.stringify(seen.map((event) => event.payload));
    expect(serialized).not.toContain(CANARY_PHONE);
    expect(serialized).not.toContain(CANARY_EMAIL);
  });

  it("falls back to the estimate on the fake shape with pricingKnown false", async () => {
    const seen: ExecutorSpan[] = [];
    const budget = createBudgetState();
    const fake = new FakeListChatModel({
      responses: [
        JSON.stringify({
          sql: "SELECT status FROM orders",
          tablesUsed: ["orders"],
        }),
      ],
    });
    const executor = new ValidatedQueryExecutor({
      model: fake as unknown as ChatModelLike,
      mcp: new StubMcpCaller(),
      emitSpan: (event) => {
        seen.push(event);
        return `span-${seen.length}`;
      },
      budget,
    });

    const result = await executor.run({
      question: "How many orders per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      budget,
    });
    expect(result.status).toBe("ok");

    const llmCalls = seen.filter((event) => event.type === "llm_call");
    expect(llmCalls).toHaveLength(1);
    const llmPayload = llmCalls[0]?.payload as Record<string, unknown>;
    expect(llmPayload["inputTokens"]).toBe(0);
    expect(llmPayload["outputTokens"]).toBe(0);
    expect(llmPayload["pricingKnown"]).toBe(false);
    expect(llmPayload["estimatedCostUsd"]).toBe(0);
    // Estimate fallback still charges the budget instead of zeroing it.
    expect(budget.tokensUsed).toBeGreaterThan(0);
  });
});
