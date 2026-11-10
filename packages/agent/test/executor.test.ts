// ValidatedQueryExecutor core path (AGENT-02, 01-11). Deterministic fakes
// only: FakeListChatModel canned proposals plus a stub McpToolCaller recording
// call order. No API key, no DB, no network.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { dbToolError } from "@shared/contracts";
import {
  SqlProposalSchema,
  ValidatedQueryExecutor,
  type ChatModelLike,
  type ExecutorSpan,
  type McpToolCaller,
  type SqlProposal,
} from "../src/queryExecutor/executor.js";
import { createBudgetState } from "../src/queryExecutor/budgets.js";

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

    expect(result.status).toBe("cannot_answer");
    if (result.status !== "cannot_answer") return;
    expect(result.budgetExceeded).toBe(true);
    expect(result.tripReason).toBe("llm-calls");
    expect(result.partials).toEqual({
      tablesDescribed: [],
      lastSql: null,
      rowsFetched: 0,
    });
    expect(mcp.calls).toHaveLength(0);
  });

  it("trips the token budget on real usage counts instead of the estimate", async () => {
    // Fake usage seam: a real-shaped { raw, parsed } result carrying
    // provider counts. Real total 150 exceeds maxTokens 100, while the
    // estimate fallback (~40) would not trip — proving the trip runs on
    // real counts.
    const realUsageModel = {
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

    expect(result.status).toBe("cannot_answer");
    if (result.status !== "cannot_answer") return;
    expect(result.budgetExceeded).toBe(true);
    expect(result.tripReason).toBe("tokens");
    // Only the describe ran; explain/run never fired on the tripped budget.
    expect(mcp.calls.map((call) => call.tool)).toEqual(["describe_table"]);
  });
});
