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
import { createBudgetState, recordLlmCall } from "../src/queryExecutor/budgets.js";
import { ModelRetryError } from "../src/telemetry/retry.js";
import { loadModelPricing } from "../src/telemetry/pricing.js";
import {
  estimateCostUsd,
  extractFencedSqlProposal,
  invokeJsonWithUsage,
  invokeWithUsage,
  modelFromMessage,
  type PlainJsonModelLike,
  unaccountedUsage,
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

  it("re-asks once after a Zod failure on the same structured profile and totals usage", async () => {
    const prompts: string[] = [];
    const profileOptions: unknown[] = [];
    let calls = 0;
    const budget = createBudgetState({ maxLlmCalls: 10 });
    const model: ChatModelLike = {
      withStructuredOutput: (_schema, options) => {
        profileOptions.push(options);
        return {
          invoke: async (prompt) => {
            prompts.push(prompt);
            calls += 1;
            const raw = calls === 1
              ? rawMessage({ input_tokens: 7, output_tokens: 3 }, KNOWN_MODEL)
              : rawMessage({ input_tokens: 11, output_tokens: 5 }, KNOWN_MODEL);
            return {
              raw,
              parsed: calls === 1 ? { invalid: true } : PARSED,
            };
          },
        };
      },
    };

    const out = await invokeWithUsage(model, SqlProposalSchema, "proposal prompt", {
      name: "sql_proposal",
      node: "propose",
      budget,
    });

    expect(out.parsed).toEqual(PARSED);
    expect(out.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(profileOptions).toEqual([{ name: "sql_proposal", includeRaw: true }, { name: "sql_proposal", includeRaw: true }]);
    expect(prompts[0]).toBe("proposal prompt");
    expect(prompts[1]).toContain("Return exactly one valid JSON object");
    expect(out).toMatchObject({
      inputTokens: 18,
      outputTokens: 8,
      preAccountedUsage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(budget.llmCalls).toBe(1);
    expect(budget.tokensUsed).toBe(10);
    const successfulUsage = unaccountedUsage(out);
    recordLlmCall(budget, successfulUsage.inputTokens + successfulUsage.outputTokens);
    expect(budget.llmCalls).toBe(2);
    expect(budget.tokensUsed).toBe(26);
  });

  it("does not re-ask after a format failure exhausts the LLM-call budget", async () => {
    let calls = 0;
    const budget = createBudgetState({ maxLlmCalls: 1 });
    const model: ChatModelLike = {
      withStructuredOutput: () => ({
        invoke: async () => {
          calls += 1;
          return {
            raw: rawMessage({ input_tokens: 5, output_tokens: 1 }, KNOWN_MODEL),
            parsed: { invalid: true },
          };
        },
      }),
    };

    await expect(invokeWithUsage(model, SqlProposalSchema, "q", { budget })).rejects.toThrow(
      "Run budget exceeded (llm-calls)",
    );
    expect(calls).toBe(1);
    expect(budget.llmCalls).toBe(1);
    expect(budget.tokensUsed).toBe(6);
  });

  it("retries 429 twice then succeeds on structured invoke without retrying schema/auth errors", async () => {
    let calls = 0;
    const budget = createBudgetState({ runDeadlineMs: 30_000 });
    const events: { type: string; payload?: unknown }[] = [];
    const model: ChatModelLike = {
      withStructuredOutput: () => ({
        invoke: async () => {
          calls += 1;
          if (calls <= 2) {
            throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
          }
          return {
            raw: rawMessage(
              { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
              KNOWN_MODEL,
            ),
            parsed: PARSED,
          };
        },
      }),
    };
    const out = await invokeWithUsage(model, SqlProposalSchema, "q", {
      name: "sql_proposal",
      budget,
      retry: { maxRetries: 3, baseMs: 10, maxWaitMs: 500 },
      emit: (e) => {
        events.push(e);
        return `s-${events.length}`;
      },
      sleep: async () => {},
    });
    expect(out.parsed).toEqual(PARSED);
    expect(out.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(budget.llmCalls).toBe(2);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);

    // Non-retryable 401 and Zod errors never retry.
    let authCalls = 0;
    await expect(
      invokeWithUsage(
        {
          withStructuredOutput: () => ({
            invoke: async () => {
              authCalls += 1;
              throw Object.assign(new Error("Unauthorized"), { status: 401 });
            },
          }),
        },
        SqlProposalSchema,
        "q",
        { retry: { maxRetries: 3, baseMs: 1, maxWaitMs: 50 }, sleep: async () => {} },
      ),
    ).rejects.toThrow("Unauthorized");
    expect(authCalls).toBe(1);
  });

  it("aborts structured invoke at the run deadline", async () => {
    const hanging: ChatModelLike = {
      withStructuredOutput: () => ({
        invoke: () => new Promise(() => {}),
      }),
    };
    const err = await invokeWithUsage(hanging, SqlProposalSchema, "q", {
      deadlineMs: Date.now() + 40,
      retry: { maxRetries: 0, baseMs: 1, maxWaitMs: 10 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
  });
});

describe("invokeJsonWithUsage", () => {
  const PARSED = {
    sql: "SELECT status FROM orders",
    tablesUsed: ["orders"],
  };
  const USAGE = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };

  function plainModel(content: unknown): {
    invoke: () => Promise<unknown>;
    stream: () => AsyncIterable<unknown>;
  } {
    const message = () => ({
      content,
      usage_metadata: USAGE,
      response_metadata: { model: KNOWN_MODEL },
    });
    return {
      invoke: async () => message(),
      stream: async function* () {
        yield message();
      },
    };
  }

  it("parses verbatim JSON text and reads usage plus model", async () => {
    const out = await invokeJsonWithUsage(
      plainModel(JSON.stringify(PARSED)),
      SqlProposalSchema,
      "q",
      { name: "sql_proposal" },
    );
    expect(out.parsed).toEqual(PARSED);
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
    expect(out.model).toBe(KNOWN_MODEL);
  });

  it("parses a fenced json block and content-block arrays", async () => {
    const fenced = await invokeJsonWithUsage(
      plainModel(`here you go:\n\`\`\`json\n${JSON.stringify(PARSED)}\n\`\`\``),
      SqlProposalSchema,
      "q",
    );
    expect(fenced.parsed).toEqual(PARSED);
    const blocked = await invokeJsonWithUsage(
      plainModel([{ type: "text", text: JSON.stringify(PARSED) }]),
      SqlProposalSchema,
      "q",
    );
    expect(blocked.parsed).toEqual(PARSED);
  });

  it("throws not-valid-JSON without echoing raw output", async () => {
    const raw = `sorry, cannot comply (${CANARY_PHONE})`;
    const error = await invokeJsonWithUsage(
      plainModel(raw),
      SqlProposalSchema,
      "q",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(String((error as Error).message)).toMatch(/not valid JSON/i);
    expect(String((error as Error).message)).not.toContain(CANARY_PHONE);
  });

  it("re-asks once after malformed streamed JSON and includes failed-call usage", async () => {
    const prompts: string[] = [];
    const outputs = ["{bad json", JSON.stringify(PARSED)];
    const usages = [
      { input_tokens: 7, output_tokens: 3 },
      { input_tokens: 11, output_tokens: 5 },
    ];
    let calls = 0;
    const budget = createBudgetState({ maxLlmCalls: 10 });
    const model: PlainJsonModelLike = {
      invoke: async () => { throw new Error("stream is expected"); },
      stream: async function* (prompt: string) {
        prompts.push(prompt);
        const index = calls++;
        yield {
          content: outputs[index],
          usage_metadata: usages[index],
          response_metadata: { model: KNOWN_MODEL },
        };
      },
    };

    const out = await invokeJsonWithUsage(model, SqlProposalSchema, "json prompt", { budget });

    expect(out.parsed).toEqual(PARSED);
    expect(out.attempts).toBe(2);
    expect(prompts[0]).toBe("json prompt");
    expect(prompts[1]).toContain("Return exactly one valid JSON object");
    expect(out).toMatchObject({
      inputTokens: 18,
      outputTokens: 8,
      preAccountedUsage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(budget.llmCalls).toBe(1);
    expect(budget.tokensUsed).toBe(10);
  });

  it("re-asks a provider 5xx with the unchanged prompt", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const budget = createBudgetState({ maxLlmCalls: 10 });
    const model: ChatModelLike = {
      withStructuredOutput: () => ({
        invoke: async (prompt) => {
          prompts.push(prompt);
          calls += 1;
          if (calls === 1) throw Object.assign(new Error("gateway failure"), { status: 502 });
          return PARSED;
        },
      }),
    };

    const out = await invokeWithUsage(model, SqlProposalSchema, "same prompt", { budget });

    expect(out.parsed).toEqual(PARSED);
    expect(out.attempts).toBe(2);
    expect(prompts).toEqual(["same prompt", "same prompt"]);
    expect(budget.llmCalls).toBe(1);
  });

  it("fails closed on schema violations and degrades fakes to zero usage", async () => {
    await expect(
      invokeJsonWithUsage(
        plainModel(JSON.stringify({ nope: true })),
        SqlProposalSchema,
        "q",
      ),
    ).rejects.toThrow();
    const fake = new FakeListChatModel({
      responses: [JSON.stringify(PARSED)],
    });
    const out = await invokeJsonWithUsage(fake, SqlProposalSchema, "q", {
      name: "sql_proposal",
    });
    expect(out.parsed).toEqual(PARSED);
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.model).toBeUndefined();
  });

  it("counts reasoning chunks as progress and records firstTokenMs", async () => {
    const reasoning = async function* () {
      yield { content: "", additional_kwargs: { reasoning_content: "thinking" } };
      await new Promise((r) => setTimeout(r, 10));
      yield { content: JSON.stringify(PARSED), usage_metadata: USAGE };
    };
    const out = await invokeJsonWithUsage(
      { invoke: async () => ({}), stream: () => reasoning() },
      SqlProposalSchema,
      "q",
      { name: "sql_proposal", idleMs: 1000 },
    );
    expect(out.parsed).toEqual(PARSED);
    expect(out.firstTokenMs).toBeDefined();
    expect(out.firstTokenMs as number).toBeLessThan(1000);
  });

  it("aborts a stalled stream on the idle budget with a TimeoutError", async () => {
    const stalled = async function* () {
      yield { content: "" };
      await new Promise(() => {});
      yield { content: "" };
    };
    const error = await invokeJsonWithUsage(
      { invoke: async () => ({}), stream: () => stalled() },
      SqlProposalSchema,
      "q",
      { idleMs: 50 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
    expect(String((error as Error).message)).toMatch(/stalled/);
  });

  it("retries streaming JSON on 503/429 and stops with RATE_LIMITED without retrying invalid JSON", async () => {
    let calls = 0;
    const budget = createBudgetState({ runDeadlineMs: 30_000 });
    const out = await invokeJsonWithUsage(
      {
        invoke: async () => ({}),
        stream: () => {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("503 Service Unavailable"), {
              status: 503,
              headers: { "Retry-After": "0.1" },
            });
          }
          if (calls === 2) {
            throw Object.assign(new Error("429 Rate limit; try again in 50ms"), {
              status: 429,
            });
          }
          return (async function* () {
            yield { content: JSON.stringify(PARSED), usage_metadata: USAGE };
          })();
        },
      },
      SqlProposalSchema,
      "q",
      {
        budget,
        retry: { maxRetries: 3, baseMs: 10, maxWaitMs: 500 },
        sleep: async () => {},
      },
    );
    expect(out.parsed).toEqual(PARSED);
    expect(out.attempts).toBe(3);
    expect(calls).toBe(3);

    // Invalid JSON receives one format re-ask before the final parse error.
    let badJsonCalls = 0;
    await expect(
      invokeJsonWithUsage(
        {
          invoke: async () => ({}),
          stream: () => {
            badJsonCalls += 1;
            return (async function* () {
              yield { content: "not json at all" };
            })();
          },
        },
        SqlProposalSchema,
        "q",
        { retry: { maxRetries: 3, baseMs: 1, maxWaitMs: 50 }, sleep: async () => {} },
      ),
    ).rejects.toThrow(/not valid JSON/);
    expect(badJsonCalls).toBe(2);

    // Persistent 429 throws ModelRetryError (RATE_LIMITED).
    await expect(
      invokeJsonWithUsage(
        {
          invoke: async () => ({}),
          stream: () => {
            throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
          },
        },
        SqlProposalSchema,
        "q",
        { retry: { maxRetries: 1, baseMs: 1, maxWaitMs: 50 }, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ModelRetryError);
  });

  it("aborts streaming JSON at the run deadline even when totalMs is larger", async () => {
    const hanging = async function* () {
      yield { content: "" };
      await new Promise(() => {});
      yield { content: "" };
    };
    const error = await invokeJsonWithUsage(
      { invoke: async () => ({}), stream: () => hanging() },
      SqlProposalSchema,
      "q",
      {
        idleMs: 10_000,
        totalMs: 300_000,
        deadlineMs: Date.now() + 40,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("extracts JSON from prose with stray braces or earlier non-JSON fences", async () => {
    const proseWithBraces = [
      "Thinking about {orders}:",
      "```text\nsome scratch note\n```",
      `Result: ${JSON.stringify(PARSED)} (ignoring {draft})`,
    ].join("\n");
    const out = await invokeJsonWithUsage(
      plainModel(proseWithBraces),
      SqlProposalSchema,
      "q",
    );
    expect(out.parsed).toEqual(PARSED);

    const proseWithSecondFence = [
      "First, the SQL:",
      "```sql\nSELECT 1\n```",
      "Then the JSON payload:",
      `\`\`\`json\n${JSON.stringify(PARSED)}\n\`\`\``,
    ].join("\n");
    const out2 = await invokeJsonWithUsage(
      plainModel(proseWithSecondFence),
      SqlProposalSchema,
      "q",
    );
    expect(out2.parsed).toEqual(PARSED);
  });

  it("supports fenced SQL fallback while preserving usage and still rejecting plain prose", async () => {
    const proseSql = [
      "Here is the SQL query you requested:",
      "",
      "```sql",
      "SELECT status FROM orders",
      "```",
    ].join("\n");
    const out = await invokeJsonWithUsage(
      plainModel(proseSql),
      SqlProposalSchema,
      "q",
      { fallbackParse: extractFencedSqlProposal },
    );
    expect(out.parsed).toEqual({
      sql: "SELECT status FROM orders",
      tablesUsed: [],
    });
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
    expect(out.model).toBe(KNOWN_MODEL);

    // Plain prose with no JSON and no SQL block still fails closed without leaking raw text.
    const raw = `sorry, cannot comply (${CANARY_PHONE})`;
    const error = await invokeJsonWithUsage(
      plainModel(raw),
      SqlProposalSchema,
      "q",
      { fallbackParse: extractFencedSqlProposal },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
    expect(String((error as Error).message)).not.toContain(CANARY_PHONE);
  });

  it("falls back to invoke() when a fake omits stream()", async () => {
    const invokeOnly = {
      invoke: async () => ({
        content: JSON.stringify(PARSED),
        usage_metadata: USAGE,
        response_metadata: { model: KNOWN_MODEL },
      }),
    } as unknown as Parameters<typeof invokeJsonWithUsage>[0];
    const out = await invokeJsonWithUsage(invokeOnly, SqlProposalSchema, "q");
    expect(out.parsed).toEqual(PARSED);
    expect(out.inputTokens).toBe(100);
    expect(out.outputTokens).toBe(50);
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
    const message = () => ({
      content: JSON.stringify({
        sql: "SELECT status FROM orders",
        tablesUsed: ["orders"],
      }),
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      response_metadata: { model: KNOWN_MODEL },
    });
    return {
      invoke: async () => message(),
      stream: async function* () {
        yield message();
      },
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
