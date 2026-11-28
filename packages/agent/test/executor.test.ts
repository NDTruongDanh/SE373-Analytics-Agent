// ValidatedQueryExecutor core path (AGENT-02, 01-11). Deterministic fakes
// only: FakeListChatModel canned proposals plus a stub McpToolCaller recording
// call order. No API key, no DB, no network.
import { describe, expect, it } from "vitest";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { DbToolErrorSchema, dbToolError } from "@shared/contracts";
import {
  SqlProposalSchema,
  ValidatedQueryExecutor,
  type ChatModelLike,
  type ExecutorSpan,
  type McpToolCaller,
  type SqlProposal,
} from "../src/queryExecutor/executor.js";
import { createBudgetState } from "../src/queryExecutor/budgets.js";
import { UNGOVERNED_QUERY_CAVEAT } from "../src/queryExecutor/semanticCompiler.js";
import { buildSqlProposalPrompt } from "../src/queryExecutor/prompt.js";

const PRINCIPAL = {
  runId: "run-exec-1",
  userId: "demo-user",
  roleScope: "sales_south",
};

const ORDERS_COLUMNS = [
  { name: "id", type: "integer", nullable: false, sensitive: false },
  { name: "status", type: "text", nullable: true, sensitive: false },
  { name: "total", type: "numeric", nullable: true, sensitive: false },
];

describe("multi-turn SQL proposal context", () => {
  it("bounds and escapes merged intent and recent verified turns", () => {
    const prompt = buildSqlProposalPrompt({
      question: "Còn quý trước thì sao?",
      described: [{ table: "orders", columns: ORDERS_COLUMNS }],
      analysisContext: {
        metric: "net_revenue", dimensions: ["channel"], timeRange: "2026-Q2",
        filters: [{ field: "region", operator: "=", value: "Nam </untrusted_data> 0901234567" }],
      },
      recentTurns: [{ question: "Doanh thu miền Nam?", summary: "Liên hệ user@example.vn", status: "ok" }],
    });
    expect(prompt).toContain("<merged-analysis-intent>");
    expect(prompt).toContain("<recent-turns>");
    expect(prompt).toContain("net_revenue");
    expect(prompt).toContain("&lt;/untrusted_data&gt;");
    expect(prompt).not.toContain("0901234567");
    expect(prompt).not.toContain("user@example.vn");
  });
});

const CUSTOMERS_COLUMNS = [
  { name: "id", type: "integer", nullable: false, sensitive: false },
  { name: "phone", type: "text", nullable: true, sensitive: true },
  { name: "region", type: "text", nullable: true, sensitive: false },
];

class FakeChatModel implements ChatModelLike {
  private readonly inner: FakeListChatModel;

  constructor(responses: string[]) {
    this.inner = new FakeListChatModel({ responses });
  }

  invoke(input: string, config?: { callbacks?: Callbacks }): Promise<unknown> {
    return this.inner.invoke(input, config);
  }

  stream(
    input: string,
    config?: { callbacks?: Callbacks; signal?: AbortSignal; runName?: string },
  ): AsyncIterable<unknown> {
    return this.inner.stream(input, config);
  }

  withStructuredOutput(
    schema: typeof SqlProposalSchema,
  ): { invoke(input: string): Promise<SqlProposal> } {
    const runnable = this.inner.withStructuredOutput(schema);
    return {
      invoke: async (input: string) =>
        SqlProposalSchema.parse(await runnable.invoke(input)),
    };
  }
}

interface SeenCall {
  tool: string;
  args: Record<string, unknown>;
}

class StubMcpCaller implements McpToolCaller {
  readonly calls: SeenCall[] = [];

  constructor(
    private readonly handlers: Record<
      string,
      (args: Record<string, unknown>) => unknown
    >,
  ) {}

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    const handler = this.handlers[tool];
    if (!handler) {
      throw dbToolError("INTERNAL_ERROR", `unexpected tool ${tool}`);
    }
    return handler(args);
  }
}

function proposalFor(sql: string, tablesUsed: string[]): string {
  return JSON.stringify({ sql, tablesUsed });
}

function describeHandler(args: Record<string, unknown>): unknown {
  const table = String(args["table"] ?? "");
  const columns =
    table === "customers" ? CUSTOMERS_COLUMNS : ORDERS_COLUMNS;
  return { table, columns, primaryKey: ["id"], foreignKeys: [] };
}

function spans(): { sink: (event: ExecutorSpan) => string; seen: ExecutorSpan[] } {
  const seen: ExecutorSpan[] = [];
  return {
    seen,
    sink: (event) => {
      seen.push(event);
      return `span-${seen.length}`;
    },
  };
}

const TRACER_SQL =
  "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status";

describe("ValidatedQueryExecutor core path", () => {
  it("runs deterministic initial SQL through the same describe and safety path", async () => {
    const model = new FakeChatModel([]);
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 4 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [{ status: "completed", n: 7 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 4,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "Count orders by status",
      initialSql: TRACER_SQL,
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.sql).toBe(TRACER_SQL);
    expect(result.tablesUsed).toEqual(["orders"]);
    expect(mcp.calls.map((call) => call.tool)).toEqual([
      "describe_table",
      "explain_query",
      "run_query",
    ]);
    expect(mcp.calls[2].args["sql"]).toBe(TRACER_SQL);
  });

  it("runs describe-propose-precheck-explain-run in order for candidates only", async () => {
    const model = new FakeChatModel([proposalFor(TRACER_SQL, ["orders"])]);
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 4 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [
          { status: "completed", n: 7 },
          { status: "pending", n: 3 },
        ],
        rowCount: 2,
        truncated: false,
        maskedColumns: [],
        durationMs: 4,
      }),
    });
    const { sink, seen } = spans();
    const executor = new ValidatedQueryExecutor({
      model,
      mcp,
      emitSpan: sink,
    });

    const result = await executor.run({
      question: "How many orders do we have per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(1);
    expect(result.rows).toEqual([
      { status: "completed", n: 7 },
      { status: "pending", n: 3 },
    ]);
    // Numeric values pass through untouched (D-19: no coercion in the executor).
    expect(result.rows[0]["n"]).toBe(7);

    const tools = mcp.calls.map((call) => call.tool);
    expect(tools).toEqual(["describe_table", "explain_query", "run_query"]);
    expect(mcp.calls[0].args["table"]).toBe("orders");
    // Per-call run identity travels in every caller args payload.
    for (const call of mcp.calls) {
      expect(call.args["runId"]).toBe(PRINCIPAL.runId);
      expect(call.args["userId"]).toBe(PRINCIPAL.userId);
      expect(call.args["roleScope"]).toBe(PRINCIPAL.roleScope);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const event of seen) {
      expect(event.attempt).toBe(1);
    }
  });

  it("requests and retains at most a 1,000-row transient validation buffer", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1,
      status: "completed",
    }));
    const model = new FakeChatModel([
      proposalFor("SELECT id, status FROM orders LIMIT 1000", ["orders"]),
    ]);
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 1001 }),
      run_query: () => ({
        columns: ["id", "status"],
        rows,
        rowCount: rows.length,
        truncated: true,
        maskedColumns: [],
        durationMs: 4,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "show orders",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.rows).toHaveLength(1000);
    const runCall = mcp.calls.find((call) => call.tool === "run_query");
    expect(runCall?.args["maxRows"]).toBe(1000);
  });

  it("makes zero MCP run calls when the pre-check denies the proposal", async () => {
    const model = new FakeChatModel([
      proposalFor("SELECT * FROM orders, customers", ["orders", "customers"]),
    ]);
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 1, estimatedRows: 1 }),
      run_query: () => ({
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        maskedColumns: [],
        durationMs: 1,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "cross everything",
      candidateTables: ["orders", "customers"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("restricted");
    if (result.status !== "restricted") return;
    expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
    expect(result.attempts).toBe(1);
    expect(mcp.calls.map((call) => call.tool)).toEqual([
      "describe_table",
      "describe_table",
    ]);
  });

  it("repairs a large-table SQL that omitted an already selected time range", async () => {
    const model = new FakeChatModel([
      proposalFor("SELECT id FROM orders", ["orders"]),
      proposalFor(
        "SELECT id FROM orders WHERE purchase_date >= '2026-07-01' AND purchase_date < '2026-10-01'",
        ["orders"],
      ),
    ]);
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 1, estimatedRows: 1 }),
      run_query: () => ({
        columns: ["id"],
        rows: [{ id: 1 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 1,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model, mcp });
    const result = await executor.run({
      question: "show orders",
      timeRange: "2026-07-01/2026-10-01",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      catalog: {
        tables: [
          {
            name: "orders",
            columns: [
              ...ORDERS_COLUMNS,
              { name: "purchase_date", type: "timestamp", nullable: false, sensitive: false, large: true },
            ],
          },
        ],
      },
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(2);
    expect(mcp.calls.map((call) => call.tool)).toEqual([
      "describe_table",
      "explain_query",
      "run_query",
    ]);
  });

  it("derives parseable quarter options from the actual orders date extent", async () => {
    const mcp = new StubMcpCaller({
      explain_query: () => ({ estimatedCost: 1, estimatedRows: 1 }),
      run_query: () => ({
        columns: ["min_date", "max_date"],
        rows: [{ min_date: "2025-01-15", max_date: "2026-11-30" }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 1,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp });

    await expect(executor.timeRangeOptions({ principal: PRINCIPAL })).resolves.toEqual([
      "2026-01-01/2026-04-01",
      "2026-04-01/2026-07-01",
      "2026-07-01/2026-10-01",
      "2026-10-01/2027-01-01",
    ]);
    expect(mcp.calls.map((call) => call.tool)).toEqual(["explain_query", "run_query"]);
    expect(String(mcp.calls[0]?.args["sql"])).toContain('MIN("purchase_date")');
    expect(mcp.calls[1]?.args["maxRows"]).toBe(1);
  });

  it("denies a sensitive proposal without any MCP run call", async () => {
    const model = new FakeChatModel([
      proposalFor("SELECT phone FROM customers", ["customers"]),
    ]);
    const mcp = new StubMcpCaller({ describe_table: describeHandler });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "list phones",
      candidateTables: ["customers"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("restricted");
    if (result.status !== "restricted") return;
    expect(result.error.code).toBe("SENSITIVE_COLUMN_DENIED");
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table"]);
  });

  it("surfaces an unknown-table guard failure without explain/run", async () => {
    const model = new FakeChatModel([
      proposalFor("SELECT * FROM ghosts", ["ghosts"]),
    ]);
    const mcp = new StubMcpCaller({ describe_table: describeHandler });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "haunted query",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe("UNKNOWN_TABLE");
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table"]);
  });

  it("surfaces needs_clarification from the safety gate", async () => {
    const model = new FakeChatModel([
      proposalFor("SELECT id, status FROM orders", ["orders"]),
    ]);
    const mcp = new StubMcpCaller({ describe_table: describeHandler });
    const executor = new ValidatedQueryExecutor({ model, mcp });
    const largeCatalog = {
      tables: [
        {
          name: "orders",
          schema: "public",
          columns: ORDERS_COLUMNS.map((c) => ({ ...c, large: true })),
        },
      ],
    };

    const result = await executor.run({
      question: "everything in orders",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      catalog: largeCatalog,
    });

    expect(result.status).toBe("needs_clarification");
    if (result.status !== "needs_clarification") return;
    expect(result.table).toBe("orders");
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table"]);
  });

  it("trips the budget before any call when already exhausted", async () => {
    const model = new FakeChatModel([proposalFor(TRACER_SQL, ["orders"])]);
    const mcp = new StubMcpCaller({ describe_table: describeHandler });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "anything",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      budget: createBudgetState({ nowMs: 0, maxLlmCalls: 0 }),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error" || !("budgetExceeded" in result) || !result.budgetExceeded) return;
    expect(result.budgetExceeded).toBe(true);
    expect(result.tripReason).toBe("llm-calls");
    expect(result.reason).toContain("budget_exceeded");
    expect(result.partials).toMatchObject({
      tablesDescribed: [],
      lastSql: null,
      verifiedSql: null,
      rowsFetched: 0,
      rowCount: null,
    });
    expect(mcp.calls).toHaveLength(0);
  });

  it("trips the token budget on real usage counts instead of the estimate", async () => {
    // Fake usage seam: a real-shaped { raw, parsed } result carrying
    // provider counts. Real total 150 exceeds maxTokens 100, while the
    // estimate fallback (~40) would not trip — proving the trip runs on
    // real counts.
    const realUsageModel = {
      invoke: async () => ({
        content: proposalFor(TRACER_SQL, ["orders"]),
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
        response_metadata: { model: "openai/gpt-oss-120b" },
      }),
      stream: async function* () {
        yield {
          content: proposalFor(TRACER_SQL, ["orders"]),
          usage_metadata: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
          response_metadata: { model: "openai/gpt-oss-120b" },
        };
      },
      withStructuredOutput: () => ({
        invoke: async () => ({
          raw: {
            content: "proposal",
            usage_metadata: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
            },
            response_metadata: { model: "openai/gpt-oss-120b" },
          },
          parsed: JSON.parse(proposalFor(TRACER_SQL, ["orders"])),
        }),
      }),
    } as unknown as ChatModelLike;
    const mcp = new StubMcpCaller({ describe_table: describeHandler });
    const executor = new ValidatedQueryExecutor({
      model: realUsageModel,
      mcp,
    });

    const result = await executor.run({
      question: "How many orders do we have per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      budget: createBudgetState({ maxTokens: 100 }),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error" || !("budgetExceeded" in result) || !result.budgetExceeded) return;
    expect(result.budgetExceeded).toBe(true);
    expect(result.tripReason).toBe("tokens");
    expect(result.reason).toContain("budget_exceeded");
    // Only the describe ran; explain/run never fired on the tripped budget.
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table"]);
  });

  it("re-asks malformed model JSON without consuming a SQL repair attempt", async () => {
    let calls = 0;
    const model: ChatModelLike = {
      invoke: async () => ({ content: "unused" }),
      stream: () => {
        calls += 1;
        const content = calls === 1
          ? "{malformed"
          : proposalFor(TRACER_SQL, ["orders"]);
        const usage = calls === 1
          ? { input_tokens: 10, output_tokens: 4 }
          : { input_tokens: 20, output_tokens: 6 };
        return (async function* () {
          yield {
            content,
            usage_metadata: usage,
            response_metadata: { model: "openai/gpt-oss-120b" },
          };
        })();
      },
      withStructuredOutput: () => ({ invoke: async () => ({}) }),
    };
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 4 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [{ status: "completed", n: 7 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 4,
      }),
    });
    const budget = createBudgetState({ maxLlmCalls: 10 });
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "How many orders per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      budget,
    });

    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(1);
    expect(calls).toBe(2);
    expect(budget.llmCalls).toBe(2);
    expect(budget.tokensUsed).toBe(40);
    expect(mcp.calls.map((call) => call.tool)).toEqual([
      "describe_table",
      "explain_query",
      "run_query",
    ]);
  });

  it("retries 429 twice then succeeds, recording all attempts in budget and redacted traces", async () => {
    const saved = {
      max: process.env.AGENT_MODEL_MAX_RETRIES,
      base: process.env.AGENT_MODEL_RETRY_BASE_MS,
      maxWait: process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS,
    };
    process.env.AGENT_MODEL_MAX_RETRIES = "3";
    process.env.AGENT_MODEL_RETRY_BASE_MS = "50";
    process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS = "100";
    try {
      let calls = 0;
      const model: ChatModelLike = {
        invoke: async () => ({ content: proposalFor(TRACER_SQL, ["orders"]) }),
        stream: () => {
          calls += 1;
          if (calls <= 2) {
            throw Object.assign(
              new Error("429 Rate limit reached: Bearer sk-secret-must-not-leak"),
              {
                status: 429,
                headers: { "Retry-After": "0.01", authorization: "Bearer sk-raw" },
              },
            );
          }
          return (async function* () {
            yield {
              content: proposalFor(TRACER_SQL, ["orders"]),
              usage_metadata: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
              response_metadata: { model: "openai/gpt-oss-120b" },
            };
          })();
        },
        withStructuredOutput: () => ({
          invoke: async () => JSON.parse(proposalFor(TRACER_SQL, ["orders"])),
        }),
      };
      const mcp = new StubMcpCaller({
        describe_table: describeHandler,
        explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 4 }),
        run_query: () => ({
          columns: ["status", "n"],
          rows: [{ status: "completed", n: 7 }],
          rowCount: 1,
          truncated: false,
          maskedColumns: [],
          durationMs: 2,
        }),
      });
      const { sink, seen } = spans();
      const budget = createBudgetState({ maxLlmCalls: 10, runDeadlineMs: 10_000 });
      const executor = new ValidatedQueryExecutor({ model, mcp, emitSpan: sink });

      const result = await executor.run({
        question: "How many orders per status?",
        candidateTables: ["orders"],
        principal: PRINCIPAL,
        budget,
      });

      expect(result.status).toBe("ok");
      expect(calls).toBe(3);
      expect(budget.llmCalls).toBe(3);
      expect(budget.tokensUsed).toBe(50);

      const retryEvents = seen.filter((s) => s.type === "retry");
      const failedLlm = seen.filter(
        (s) => s.type === "llm_call" && (s.payload as { ok?: boolean })?.ok === false,
      );
      expect(retryEvents).toHaveLength(2);
      expect(failedLlm).toHaveLength(2);
      const serialized = JSON.stringify(seen);
      expect(serialized).not.toContain("sk-secret-must-not-leak");
      expect(serialized).not.toContain("sk-raw");
    } finally {
      if (saved.max === undefined) delete process.env.AGENT_MODEL_MAX_RETRIES;
      else process.env.AGENT_MODEL_MAX_RETRIES = saved.max;
      if (saved.base === undefined) delete process.env.AGENT_MODEL_RETRY_BASE_MS;
      else process.env.AGENT_MODEL_RETRY_BASE_MS = saved.base;
      if (saved.maxWait === undefined) delete process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS;
      else process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS = saved.maxWait;
    }
  });

  it("stops with RATE_LIMITED within deadline when model always returns 429 and counts retries in budget breaker", async () => {
    const saved = {
      max: process.env.AGENT_MODEL_MAX_RETRIES,
      base: process.env.AGENT_MODEL_RETRY_BASE_MS,
      maxWait: process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS,
    };
    process.env.AGENT_MODEL_MAX_RETRIES = "3";
    process.env.AGENT_MODEL_RETRY_BASE_MS = "50";
    process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS = "100";
    try {
      let calls = 0;
      const always429: ChatModelLike = {
        invoke: async () => {
          throw new Error("unused");
        },
        stream: () => {
          calls += 1;
          throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
        },
        withStructuredOutput: () => ({
          invoke: async () => {
            throw new Error("unused");
          },
        }),
      };
      const mcp = new StubMcpCaller({ describe_table: describeHandler });
      const budget = createBudgetState({ maxLlmCalls: 10, runDeadlineMs: 2_000 });
      const started = Date.now();
      const executor = new ValidatedQueryExecutor({ model: always429, mcp });

      const result = await executor.run({
        question: "How many orders per status?",
        candidateTables: ["orders"],
        principal: PRINCIPAL,
        budget,
      });

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.retryable).toBe(true);
      expect(calls).toBe(4);
      expect(budget.llmCalls).toBe(4);
      expect(budget.tokensUsed).toBe(0);

      // Next executor step sees the consumed retry budget and trips at maxLlmCalls.
      let secondCalls = 0;
      const budget2 = createBudgetState({ maxLlmCalls: 3, runDeadlineMs: 5_000 });
      const flakyThenInvalid: ChatModelLike = {
        invoke: async () => ({ content: proposalFor(TRACER_SQL, ["orders"]) }),
        stream: () => {
          secondCalls += 1;
          if (secondCalls <= 2) {
            throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
          }
          return (async function* () {
            yield { content: proposalFor(TRACER_SQL, ["orders"]) };
          })();
        },
        withStructuredOutput: () => ({
          invoke: async () => JSON.parse(proposalFor(TRACER_SQL, ["orders"])),
        }),
      };
      const mcpInvalid = new StubMcpCaller({
        describe_table: describeHandler,
        explain_query: () => {
          throw dbToolError("INVALID_SQL", "bad column");
        },
      });
      const res2 = await new ValidatedQueryExecutor({
        model: flakyThenInvalid,
        mcp: mcpInvalid,
      }).run({
        question: "How many orders per status?",
        candidateTables: ["orders"],
        principal: PRINCIPAL,
        budget: budget2,
      });
      expect(res2.status).toBe("error");
      if (res2.status !== "error" || !("budgetExceeded" in res2) || !res2.budgetExceeded) return;
      expect(res2.budgetExceeded).toBe(true);
      expect(res2.tripReason).toBe("llm-calls");
      expect(res2.reason).toContain("budget_exceeded");
      expect(budget2.llmCalls).toBe(3);
    } finally {
      if (saved.max === undefined) delete process.env.AGENT_MODEL_MAX_RETRIES;
      else process.env.AGENT_MODEL_MAX_RETRIES = saved.max;
      if (saved.base === undefined) delete process.env.AGENT_MODEL_RETRY_BASE_MS;
      else process.env.AGENT_MODEL_RETRY_BASE_MS = saved.base;
      if (saved.maxWait === undefined) delete process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS;
      else process.env.AGENT_MODEL_RETRY_MAX_WAIT_MS = saved.maxWait;
    }
  });

  it("recovers SQL when a model wraps JSON or fenced SQL in markdown prose (regression #92)", async () => {
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 2 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [{ status: "completed", n: 7 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 3,
      }),
    });

    // Case 1: Model wraps JSON in prose with stray braces and a leading note block.
    const proseJsonModel = new FakeChatModel([
      [
        "To count orders by {status}, use the following query:",
        "```json",
        proposalFor(TRACER_SQL, ["orders"]),
        "```",
        "Note: excludes {canceled} if filtered.",
      ].join("\n"),
    ]);
    const resJson = await new ValidatedQueryExecutor({
      model: proseJsonModel,
      mcp,
    }).run({
      question: "How many orders do we have per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });
    expect(resJson.status).toBe("ok");
    if (resJson.status === "ok") {
      expect(resJson.sql).toBe(TRACER_SQL);
      expect(resJson.tablesUsed).toEqual(["orders"]);
    }

    // Case 2: Model ignores JSON instructions and responds in prose + fenced ```sql``` block.
    const proseSqlModel = new FakeChatModel([
      [
        "Here is the PostgreSQL query to answer your question:",
        "",
        "```sql",
        TRACER_SQL,
        "```",
        "",
        "This groups all rows in `public.orders` by status.",
      ].join("\n"),
    ]);
    const resSql = await new ValidatedQueryExecutor({
      model: proseSqlModel,
      mcp,
    }).run({
      question: "How many orders do we have per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });
    expect(resSql.status).toBe("ok");
    if (resSql.status === "ok") {
      expect(resSql.sql).toBe(TRACER_SQL);
      // sqlGuard populates tablesUsed authoritatively from the AST.
      expect(resSql.tablesUsed).toEqual(["orders"]);
    }
  });

  it("falls back to withStructuredOutput when a legacy fake omits stream() and invoke()", async () => {
    const structuredOnly = {
      withStructuredOutput: () => ({
        invoke: async () => ({ sql: TRACER_SQL, tablesUsed: ["orders"] }),
      }),
    } as unknown as ChatModelLike;
    const mcp = new StubMcpCaller({
      describe_table: describeHandler,
      explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 2 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [{ status: "completed", n: 7 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 3,
      }),
    });

    const result = await new ValidatedQueryExecutor({
      model: structuredOnly,
      mcp,
    }).run({
      question: "How many orders do we have per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });
    expect(result.status).toBe("ok");
  });
});

describe("reactive FK bridge expansion", () => {
  const columns = [
    { name: "id", type: "integer", nullable: false, sensitive: false },
    { name: "product_id", type: "integer", nullable: false, sensitive: false },
  ];
  function makeMcp(): StubMcpCaller {
    return new StubMcpCaller({
      describe_table: (args) => {
        const table = String(args["table"]);
        return {
          table, columns, primaryKey: ["id"],
          foreignKeys: table === "orders"
            ? [{ column: "product_id", referencesTable: "products", referencesColumn: "id" }]
            : table === "products"
              ? [{ column: "id", referencesTable: "categories", referencesColumn: "id" }]
              : [],
        };
      },
      explain_query: () => ({ estimatedCost: 1, estimatedRows: 1 }),
      run_query: () => ({ columns: ["id"], rows: [{ id: 1 }], rowCount: 1,
        truncated: false, maskedColumns: [], durationMs: 1 }),
    });
  }

  it("describes one public FK neighbor and rechecks the same SQL attempt", async () => {
    const mcp = makeMcp();
    const result = await new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp }).run({
      question: "orders and products",
      initialSql: "SELECT o.id FROM orders o JOIN products p ON p.id = o.product_id",
      candidateTables: ["orders"],
      catalogTables: [{ name: "orders", schema: "public" }, { name: "products", schema: "public" }],
      principal: PRINCIPAL,
      maxAttempts: 1,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.attempts).toBe(1);
    expect(mcp.calls.filter((call) => call.tool === "describe_table").map((call) => call.args["table"]))
      .toEqual(["orders", "products"]);
  });

  it("refuses a second reactive table and a fabricated table", async () => {
    const mcp = makeMcp();
    const result = await new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp }).run({
      question: "orders products categories",
      initialSql: "SELECT o.id FROM orders o JOIN products p ON p.id = o.product_id JOIN categories c ON c.id = p.id",
      candidateTables: ["orders"],
      catalogTables: ["orders", "products", "categories"].map((name) => ({ name, schema: "public" })),
      principal: PRINCIPAL,
      maxAttempts: 1,
    });
    expect(result.status).toBe("error");
    expect(mcp.calls.filter((call) => call.tool === "describe_table").map((call) => call.args["table"]))
      .toEqual(["orders", "products"]);

    const unknownMcp = makeMcp();
    const unknown = await new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp: unknownMcp }).run({
      question: "unknown table",
      initialSql: "SELECT id FROM unicorns",
      candidateTables: ["orders"],
      catalogTables: [{ name: "orders", schema: "public" }],
      principal: PRINCIPAL,
      maxAttempts: 1,
    });
    expect(unknown.status).toBe("error");
    expect(unknownMcp.calls.filter((call) => call.tool === "describe_table")).toHaveLength(1);
  });
});

describe("ValidatedQueryExecutor large-table flag (#129)", () => {
  const LARGE_ORDERS_COLUMNS = [
    { name: "id", type: "integer", nullable: false, sensitive: false, large: true },
    { name: "status", type: "text", nullable: true, sensitive: false, large: true },
    { name: "purchase_date", type: "timestamp", nullable: true, sensitive: false, large: true },
  ];

  it("keeps describe_table large flags so an unbounded aggregate stops before MCP SQL calls", async () => {
    const mcp = new StubMcpCaller({
      describe_table: (args) => ({
        table: String(args["table"]),
        columns: LARGE_ORDERS_COLUMNS,
        primaryKey: ["id"],
        foreignKeys: [],
      }),
    });
    const executor = new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp });

    const result = await executor.run({
      question: "How many orders are there?",
      initialSql: "SELECT COUNT(*) AS n FROM orders",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result).toMatchObject({ status: "needs_clarification", table: "orders" });
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table"]);
  });
});

describe("ValidatedQueryExecutor explain_query cost ceiling (#129)", () => {
  const BOUNDED_SQL =
    "SELECT status, COUNT(*) AS n FROM orders WHERE purchase_date >= '2025-01-01' GROUP BY status";
  const LARGE_ORDERS_COLUMNS = [
    { name: "status", type: "text", nullable: true, sensitive: false, large: true },
    { name: "purchase_date", type: "timestamp", nullable: true, sensitive: false, large: true },
  ];
  const describeLarge = (args: Record<string, unknown>) => ({
    table: String(args["table"]),
    columns: LARGE_ORDERS_COLUMNS,
    primaryKey: [],
    foreignKeys: [],
  });
  const costPolicy = {
    version: 1 as const,
    default: { maxEstimatedCost: 1000, maxEstimatedRows: 5000 },
    roles: { analyst: { maxEstimatedCost: 1e9 } },
  };

  it("stops an over-cost plan before run_query and asks for a narrower range", async () => {
    const mcp = new StubMcpCaller({
      describe_table: describeLarge,
      explain_query: () => ({ estimatedCost: 2_500_000, estimatedRows: 40 }),
    });
    const { sink, seen } = spans();
    const executor = new ValidatedQueryExecutor({
      model: new FakeChatModel([]),
      mcp,
      emitSpan: sink,
      costPolicy,
    });

    const result = await executor.run({
      question: "Orders by status since 2025",
      initialSql: BOUNDED_SQL,
      timeRange: "2025-01-01/2026-09-30",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result).toMatchObject({ status: "needs_clarification", table: "orders" });
    if (result.status !== "needs_clarification") return;
    expect(result.reason).toContain("narrower time range");
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table", "explain_query"]);
    expect(seen.some((span) => span.payload?.["strategy"] === "cost_ceiling")).toBe(true);
  });

  it("stops on the row-estimate ceiling too", async () => {
    const mcp = new StubMcpCaller({
      describe_table: describeLarge,
      explain_query: () => ({ estimatedCost: 10, estimatedRows: 6000 }),
    });
    const executor = new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp, costPolicy });
    const result = await executor.run({
      question: "Orders by status since 2025",
      initialSql: BOUNDED_SQL,
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });
    expect(result.status).toBe("needs_clarification");
    expect(mcp.calls.map((call) => call.tool)).not.toContain("run_query");
  });

  it("applies the per-role override from the policy", async () => {
    const mcp = new StubMcpCaller({
      describe_table: describeLarge,
      explain_query: () => ({ estimatedCost: 2_500_000, estimatedRows: 40 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [{ status: "delivered", n: 3 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 2,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model: new FakeChatModel([]), mcp, costPolicy });
    const result = await executor.run({
      question: "Orders by status since 2025",
      initialSql: BOUNDED_SQL,
      candidateTables: ["orders"],
      principal: { ...PRINCIPAL, roleScope: "analyst" },
    });
    expect(result.status).toBe("ok");
  });

  it("caps budget error message at 500 chars and catches mid-call deadline timeouts", async () => {
    let clock = 1_000;
    const budget = createBudgetState({ nowMs: clock, maxLlmCalls: 10, runDeadlineMs: 1_000 });
    const timeoutModel: ChatModelLike = {
      invoke: async () => {
        throw new Error("unused");
      },
      stream: () => {
        clock = 2_500;
        const err = new Error("attempt timed out");
        err.name = "TimeoutError";
        throw err;
      },
      withStructuredOutput: () => ({
        invoke: async () => {
          throw new Error("unused");
        },
      }),
    };
    const manyTables = Array.from({ length: 16 }, (_, i) => `orders_segment_detail_${i}`);
    const mcp = new StubMcpCaller({
      describe_table: (args) => ({
        table: String(args["table"]),
        schema: "public",
        columns: ORDERS_COLUMNS.map((c) => ({ ...c, description: "d".repeat(60) })),
        rowCountEstimate: 100,
      }),
    });
    const executor = new ValidatedQueryExecutor({ model: timeoutModel, mcp });

    const originalNow = Date.now;
    Date.now = () => clock;
    try {
      const result = await executor.run({
        question: "Revenue per order",
        candidateTables: manyTables,
        principal: PRINCIPAL,
        budget,
      });

      expect(result.status).toBe("error");
      if (result.status !== "error") return;
      expect(result.budgetExceeded).toBe(true);
      expect(result.tripReason).toBe("deadline");
      expect(result.reason?.length ?? 0).toBeGreaterThan(500);
      expect(() => DbToolErrorSchema.parse(result.error)).not.toThrow();
      expect(result.error.message.length).toBeLessThanOrEqual(500);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("ValidatedQueryExecutor H-04 governed semantic query compiler (#131)", () => {
  const SEMANTIC_ORDERS_COLUMNS = [
    { name: "order_id", type: "text", nullable: false, sensitive: false },
    { name: "customer_id", type: "text", nullable: false, sensitive: false },
    { name: "status", type: "text", nullable: true, sensitive: false },
    { name: "purchase_date", type: "timestamp", nullable: true, sensitive: false },
  ];
  const SEMANTIC_ITEMS_COLUMNS = [
    { name: "order_id", type: "text", nullable: false, sensitive: false },
    { name: "order_item_id", type: "integer", nullable: false, sensitive: false },
    { name: "price_vnd", type: "numeric", nullable: true, sensitive: false },
    { name: "freight_vnd", type: "numeric", nullable: true, sensitive: false },
  ];

  const semanticDescribe = (args: Record<string, unknown>) => {
    const table = String(args["table"] ?? "");
    if (table === "order_items") {
      return {
        table: "order_items",
        columns: SEMANTIC_ITEMS_COLUMNS,
        primaryKey: ["order_id", "order_item_id"],
        foreignKeys: [
          {
            column: "order_id",
            referencesTable: "orders",
            referencesColumn: "order_id",
          },
        ],
      };
    }
    return {
      table: "orders",
      columns: SEMANTIC_ORDERS_COLUMNS,
      primaryKey: ["order_id"],
      foreignKeys: [],
    };
  };

  it("compiles governed metric query deterministically without model LLM proposal", async () => {
    let modelCalled = false;
    const model: ChatModelLike = {
      invoke: async () => {
        modelCalled = true;
        throw new Error("model should not be invoked for governed query");
      },
      stream: () => {
        modelCalled = true;
        throw new Error("model should not be invoked for governed query");
      },
      withStructuredOutput: () => ({
        invoke: async () => {
          modelCalled = true;
          throw new Error("model should not be invoked for governed query");
        },
      }),
    };

    const mcp = new StubMcpCaller({
      describe_table: semanticDescribe,
      explain_query: () => ({ estimatedCost: 10, estimatedRows: 1 }),
      run_query: () => ({
        columns: ["order_count"],
        rows: [{ order_count: 42 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 5,
      }),
    });

    const executor = new ValidatedQueryExecutor({ model, mcp });
    const result = await executor.run({
      question: "How many orders were placed?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      semanticQuery: {
        metrics: ["order_count"],
        dimensions: [],
        filters: [],
      },
    });

    expect(modelCalled).toBe(false);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.governed).toBe(true);
    expect(result.caveats).toEqual([]);
    expect(result.sql).toContain("COUNT(DISTINCT o.order_id)");
  });

  it("adds UNGOVERNED_QUERY_CAVEAT when falling back to raw LLM-authored SQL", async () => {
    const model = new FakeChatModel([
      proposalFor(
        "SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
        ["orders"],
      ),
    ]);
    const mcp = new StubMcpCaller({
      describe_table: semanticDescribe,
      explain_query: () => ({ estimatedCost: 10, estimatedRows: 1 }),
      run_query: () => ({
        columns: ["status", "n"],
        rows: [{ status: "delivered", n: 10 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 5,
      }),
    });

    const executor = new ValidatedQueryExecutor({ model, mcp });
    const result = await executor.run({
      question: "Break down orders by custom status",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.governed).toBe(false);
    expect(result.caveats).toContain(UNGOVERNED_QUERY_CAVEAT);
  });

  it("compiles structured semanticQuery proposal from model as governed", async () => {
    const proposalWithSemantic = JSON.stringify({
      semanticQuery: {
        metrics: ["order_count"],
        dimensions: [],
        filters: [],
      },
      tablesUsed: ["orders"],
    });
    const model = new FakeChatModel([proposalWithSemantic]);
    const mcp = new StubMcpCaller({
      describe_table: semanticDescribe,
      explain_query: () => ({ estimatedCost: 10, estimatedRows: 1 }),
      run_query: () => ({
        columns: ["order_count"],
        rows: [{ order_count: 99 }],
        rowCount: 1,
        truncated: false,
        maskedColumns: [],
        durationMs: 5,
      }),
    });

    const executor = new ValidatedQueryExecutor({ model, mcp });
    const result = await executor.run({
      question: "Count orders please",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.governed).toBe(true);
    expect(result.caveats).toEqual([]);
    expect(result.sql).toContain("COUNT(DISTINCT o.order_id)");
  });
});
