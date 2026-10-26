// Bounded repair loop matrix (AGENT-03, 01-11). Deterministic fakes only:
// input-recording FakeListChatModel plus a scripted stub McpToolCaller. No
// API key, no DB, no network.
import { describe, expect, it } from "vitest";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { dbToolError } from "@se373/contracts";
import {
  SqlProposalSchema,
  ValidatedQueryExecutor,
  type ChatModelLike,
  type McpToolCaller,
  type SqlProposal,
} from "../src/queryExecutor/executor.js";
import { createBudgetState } from "../src/queryExecutor/budgets.js";

const PRINCIPAL = {
  runId: "run-repair-1",
  userId: "demo-user",
  roleScope: "sales_south",
};

const ORDERS_COLUMNS = [
  { name: "id", type: "integer", nullable: false, sensitive: false },
  { name: "status", type: "text", nullable: true, sensitive: false },
  { name: "total", type: "numeric", nullable: true, sensitive: false },
];

class RepairFakeModel implements ChatModelLike {
  readonly inputs: string[] = [];
  private readonly inner: FakeListChatModel;

  constructor(responses: string[]) {
    this.inner = new FakeListChatModel({ responses });
  }

  withStructuredOutput(
    schema: typeof SqlProposalSchema,
  ): { invoke(input: string): Promise<SqlProposal> } {
    const runnable = this.inner.withStructuredOutput(schema);
    return {
      invoke: async (input: string) => {
        this.inputs.push(input);
        return SqlProposalSchema.parse(await runnable.invoke(input));
      },
    };
  }
}

class StubMcpCaller implements McpToolCaller {
  readonly calls: { tool: string; args: Record<string, unknown> }[] = [];

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

  tools(): string[] {
    return this.calls.map((call) => call.tool);
  }
}

function proposalFor(sql: string, tablesUsed: string[]): string {
  return JSON.stringify({ sql, tablesUsed });
}

const GOOD_SQL =
  "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status";

function baseHandlers(
  explain: (args: Record<string, unknown>) => unknown,
  run: (args: Record<string, unknown>) => unknown,
): Record<string, (args: Record<string, unknown>) => unknown> {
  return {
    describe_table: (args) => ({
      table: String(args["table"] ?? ""),
      columns: ORDERS_COLUMNS,
      primaryKey: ["id"],
      foreignKeys: [],
    }),
    explain_query: explain,
    run_query: run,
  };
}

function okRun() {
  return {
    columns: ["status", "n"],
    rows: [{ status: "completed", n: 7 }],
    rowCount: 1,
    truncated: false,
    maskedColumns: [],
    durationMs: 2,
  };
}

describe("bounded repair loop", () => {
  it("repairs INVALID_SQL on attempt 2 with code, message, and cursor feedback", async () => {
    const model = new RepairFakeModel([
      proposalFor("SELECT status FROM orders WHERE status = 'x'", ["orders"]),
      proposalFor(GOOD_SQL, ["orders"]),
    ]);
    let explains = 0;
    const mcp = new StubMcpCaller(
      baseHandlers(
        () => {
          explains += 1;
          if (explains === 1) {
            throw dbToolError("INVALID_SQL", "pump failure", 7);
          }
          return { estimatedCost: 3, estimatedRows: 1 };
        },
        () => okRun(),
      ),
    );
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "statuses",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.attempts).toBe(2);
    expect(explains).toBe(2);
    // The retry feeds code, message, and cursorPosition back to the model.
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[1]).toContain("INVALID_SQL");
    expect(model.inputs[1]).toContain("pump failure");
    expect(model.inputs[1]).toContain("7");
    // Run happens once, only for the repaired SQL.
    expect(mcp.tools()).toEqual([
      "describe_table",
      "explain_query",
      "explain_query",
      "run_query",
    ]);
  });

  it("surfaces the last error after three repairable strikes", async () => {
    const model = new RepairFakeModel([
      proposalFor(GOOD_SQL, ["orders"]),
      proposalFor(GOOD_SQL, ["orders"]),
      proposalFor(GOOD_SQL, ["orders"]),
    ]);
    let explains = 0;
    const mcp = new StubMcpCaller(
      baseHandlers(
        () => {
          explains += 1;
          throw dbToolError("UNKNOWN_TABLE", `strike ${explains}`);
        },
        () => okRun(),
      ),
    );
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "statuses",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe("UNKNOWN_TABLE");
    expect(result.error.message).toContain("strike 3");
    expect(result.attempts).toBe(3);
    expect(explains).toBe(3);
    expect(mcp.tools()).toEqual([
      "describe_table",
      "explain_query",
      "explain_query",
      "explain_query",
    ]);
  });

  it("aborts on attempt 1 for FORBIDDEN_STATEMENT with zero further calls", async () => {
    const model = new RepairFakeModel([proposalFor(GOOD_SQL, ["orders"])]);
    const mcp = new StubMcpCaller(
      baseHandlers(
        () => {
          throw dbToolError("FORBIDDEN_STATEMENT", "nope");
        },
        () => okRun(),
      ),
    );
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "statuses",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("restricted");
    if (result.status !== "restricted") return;
    expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
    expect(result.attempts).toBe(1);
    expect(mcp.tools()).toEqual(["describe_table", "explain_query"]);
  });

  it("simplifies once on TIMEOUT then surfaces on the second TIMEOUT", async () => {
    const model = new RepairFakeModel([
      proposalFor("SELECT id, status FROM orders WHERE status = 'x' ORDER BY id", [
        "orders",
      ]),
    ]);
    let explains = 0;
    const explainedSql: unknown[] = [];
    const mcp = new StubMcpCaller(
      baseHandlers(
        (args) => {
          explains += 1;
          explainedSql.push(args["sql"]);
          throw dbToolError("TIMEOUT", "statement timeout");
        },
        () => okRun(),
      ),
    );
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "recent orders",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error.code).toBe("TIMEOUT");
    expect(result.attempts).toBe(2);
    expect(explains).toBe(2);
    // The single retry drops ORDER BY and tightens the LIMIT.
    const retrySql = String(explainedSql[1]);
    expect(retrySql).not.toMatch(/ORDER\s+BY/i);
    expect(retrySql).toContain("LIMIT 50");
    expect(mcp.tools()).toEqual([
      "describe_table",
      "explain_query",
      "explain_query",
    ]);
  });

  it("probes exactly once before no_data on filtered zero rows", async () => {
    const model = new RepairFakeModel([
      proposalFor("SELECT id, status FROM orders WHERE status = 'zzz'", [
        "orders",
      ]),
    ]);
    const probeSeen: unknown[][] = [];
    const probeCaller = new StubMcpCaller({
      ...baseHandlers(
        () => ({ estimatedCost: 2, estimatedRows: 0 }),
        () => ({
          columns: ["id", "status"],
          rows: [],
          rowCount: 0,
          truncated: false,
          maskedColumns: [],
          durationMs: 1,
        }),
      ),
      sample_rows: (args) => {
        probeSeen.push([args["table"], args["n"]]);
        return {
          columns: ["id", "status"],
          rows: [{ id: 1, status: "ok" }],
          rowCount: 1,
        };
      },
    });
    const executor = new ValidatedQueryExecutor({
      model,
      mcp: probeCaller,
    });

    const result = await executor.run({
      question: "zzz orders",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("no_data");
    if (result.status !== "no_data") return;
    expect(result.diagnostic).toContain("sample_rows");
    expect(probeSeen).toEqual([["orders", 5]]);
    expect(probeCaller.tools()).toEqual([
      "describe_table",
      "explain_query",
      "run_query",
      "sample_rows",
    ]);
  });

  it("concludes no_data with zero probes on unfiltered aggregate zero rows", async () => {
    const model = new RepairFakeModel([proposalFor(GOOD_SQL, ["orders"])]);
    const mcp = new StubMcpCaller(
      baseHandlers(
        () => ({ estimatedCost: 2, estimatedRows: 0 }),
        () => ({
          columns: ["status", "n"],
          rows: [],
          rowCount: 0,
          truncated: false,
          maskedColumns: [],
          durationMs: 1,
        }),
      ),
    );
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "statuses",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });

    expect(result.status).toBe("no_data");
    if (result.status !== "no_data") return;
    expect(result.diagnostic).toBeUndefined();
    expect(mcp.tools()).toEqual([
      "describe_table",
      "explain_query",
      "run_query",
    ]);
  });

  it("stops further calls on a budget trip mid-repair", async () => {
    const model = new RepairFakeModel([
      proposalFor("SELECT status FROM orders WHERE status = 'x'", ["orders"]),
      proposalFor(GOOD_SQL, ["orders"]),
    ]);
    const mcp = new StubMcpCaller(
      baseHandlers(
        () => {
          throw dbToolError("INVALID_SQL", "boom");
        },
        () => okRun(),
      ),
    );
    const executor = new ValidatedQueryExecutor({ model, mcp });

    const result = await executor.run({
      question: "statuses",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
      budget: createBudgetState({ maxLlmCalls: 2 }),
    });

    expect(result.status).toBe("cannot_answer");
    if (result.status !== "cannot_answer") return;
    expect(result.budgetExceeded).toBe(true);
    expect(result.tripReason).toBe("llm-calls");
    expect(result.partials.tablesDescribed).toEqual(["orders"]);
    expect(result.partials.lastSql).toContain("SELECT status, COUNT");
    // Attempt 1 spent one LLM call on the proposal and failed repairable at
    // explain; attempt 2 spent the second on its proposal, and the pre-explain
    // check trips before any further MCP call.
    expect(mcp.tools()).toEqual(["describe_table", "explain_query"]);
  });
});
