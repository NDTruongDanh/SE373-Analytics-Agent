// ValidatedQueryExecutor (AGENT-02, 01-11): the ONLY agent-side SQL path.
// Selective describe_table for candidate tables -> structured SQL proposal
// -> local pre-check (sqlGuard from @se373/access-policy per D-01, then
// LocalQuerySafetyGate) -> explain_query -> run_query. Bounded repair,
// TIMEOUT simplification, and the zero-row diagnostic land in the task-3
// extension inside this file; the seams below are stable for 01-12.
//
// Boundaries: imports contracts, access-policy guard, zod only. Never pg,
// pg-cursor, or mcp-server/src (enforced by eslint.config.mjs). Numeric row
// values pass through untouched — D-19 coercion belongs to the 01-09 grader.

import {
  DescribeTableOutputSchema,
  ExplainQueryOutputSchema,
  RunQueryOutputSchema,
  dbToolError,
  type DbToolError,
  type ErrorCode,
  type SchemaCatalog,
} from "@se373/contracts";
import { sqlGuard } from "@se373/access-policy";
import * as z from "zod";
import {
  checkBudget,
  createBudgetState,
  recordLlmCall,
  type BudgetState,
  type BudgetTripReason,
} from "./budgets.js";
import { localQuerySafetyGate } from "./safetyGate.js";

/** Structured SQL proposal the model must produce (untrusted until gated). */
export const SqlProposalSchema = z.object({
  sql: z.string().min(1),
  tablesUsed: z.array(z.string()),
});

export type SqlProposal = z.infer<typeof SqlProposalSchema>;

/**
 * Narrow model seam 01-12 satisfies with the real factory (or the fake in
 * tests): structured output returning a parsed SqlProposal.
 */
export interface ChatModelLike {
  withStructuredOutput(
    schema: typeof SqlProposalSchema,
    opts?: { name?: string },
  ): {
    invoke(input: string): Promise<SqlProposal>;
  };
}

/**
 * Narrow MCP seam 01-12 satisfies with the real client: one call method.
 * Returns the tool output, or throws a DbToolError on tool failure.
 * Per-call run identity (runId/userId/roleScope) travels inside args so both
 * fakes and header-injecting callers observe it.
 */
export interface McpToolCaller {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Span event the executor emits; the writer fills run identity. */
export interface ExecutorSpan {
  spanId?: string;
  parentSpanId?: string;
  node: string;
  type: string;
  attempt: number;
  durationMs?: number;
  payload?: unknown;
}

export type SpanSink = (event: ExecutorSpan) => string;

/** No-op default: runs without tracing stay silent. */
export const noopSpanSink: SpanSink = () => "";

export interface ExecutorPrincipal {
  runId: string;
  userId: string;
  roleScope: string;
}

export interface ExecutorRunInput {
  question: string;
  /** Only these tables are described — never a full-schema sweep. */
  candidateTables: string[];
  principal: ExecutorPrincipal;
  /**
   * Authoritative catalog override for the pre-check (e.g. large flags the
   * describe output cannot carry). When absent, the catalog is built from
   * the describe_table outputs.
   */
  catalog?: SchemaCatalog;
  /** Reused across calls to share one run budget; created when absent. */
  budget?: BudgetState;
}

export interface PartialFindings {
  tablesDescribed: string[];
  lastSql: string | null;
  rowsFetched: number;
}

export type ExecutorResult =
  | {
      status: "ok";
      sql: string;
      tablesUsed: string[];
      columns: string[];
      rows: Record<string, unknown>[];
      maskedColumns: string[];
      attempts: number;
    }
  | {
      status: "no_data";
      sql: string;
      tablesUsed: string[];
      columns: string[];
      rows: [];
      maskedColumns: string[];
      attempts: number;
      diagnostic?: string;
    }
  | {
      status: "needs_clarification";
      reason: string;
      table?: string;
      sql: string | null;
      attempts: number;
    }
  | {
      status: "restricted";
      error: DbToolError;
      sql: string | null;
      attempts: number;
    }
  | {
      status: "error";
      error: DbToolError;
      sql: string | null;
      attempts: number;
    }
  | {
      status: "cannot_answer";
      reason: string;
      budgetExceeded: true;
      tripReason: BudgetTripReason;
      partials: PartialFindings;
      sql: string | null;
      attempts: number;
    };

export interface ExecutorDeps {
  model: ChatModelLike;
  mcp: McpToolCaller;
  emitSpan?: SpanSink;
}

/** Policy-restricted codes stay restricted; everything else is an error. */
function statusForError(code: ErrorCode): "restricted" | "error" {
  switch (code) {
    case "SCOPE_DENIED":
    case "SENSITIVE_COLUMN_DENIED":
    case "FORBIDDEN_STATEMENT":
    case "FORBIDDEN_FUNCTION":
    case "UNAUTHORIZED":
      return "restricted";
    default:
      return "error";
  }
}

/** Coerce an MCP failure into a DbToolError; unknown shapes fail closed. */
function asDbToolError(tool: string, thrown: unknown): DbToolError {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    "message" in thrown
  ) {
    const candidate = thrown as { code: unknown; message: unknown };
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return dbToolError(
        candidate.code as ErrorCode,
        `MCP tool ${tool} failed: ${candidate.message}`,
      );
    }
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return dbToolError(
    "INTERNAL_ERROR",
    `MCP tool ${tool} failed: ${message.slice(0, 200)}`,
  );
}

function catalogFromDescribe(
  outputs: { table: string; columns: { name: string; type: string; nullable: boolean; sensitive: boolean }[] }[],
): SchemaCatalog {
  return {
    tables: outputs.map((output) => ({
      name: output.table,
      schema: "public",
      columns: output.columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        sensitive: column.sensitive,
        large: false,
      })),
    })),
  };
}

export class ValidatedQueryExecutor {
  private readonly model: ChatModelLike;
  private readonly mcp: McpToolCaller;
  private readonly emitSpan: SpanSink;

  constructor(deps: ExecutorDeps) {
    this.model = deps.model;
    this.mcp = deps.mcp;
    this.emitSpan = deps.emitSpan ?? noopSpanSink;
  }

  private span(
    event: Omit<ExecutorSpan, "spanId" | "parentSpanId"> & {
      parentSpanId?: string;
    },
  ): string {
    return this.emitSpan({ ...event });
  }

  async run(input: ExecutorRunInput): Promise<ExecutorResult> {
    const budget = input.budget ?? createBudgetState();
    const { runId, userId, roleScope } = input.principal;
    const identity = { runId, userId, roleScope };
    const partials: PartialFindings = {
      tablesDescribed: [],
      lastSql: null,
      rowsFetched: 0,
    };
    const attempts = 1;

    const budgetTrip = (
      reason: BudgetTripReason,
    ): Extract<ExecutorResult, { status: "cannot_answer" }> => ({
      status: "cannot_answer",
      reason: `run budget exceeded (${reason}); degrading to synthesis with partial findings`,
      budgetExceeded: true,
      tripReason: reason,
      partials: { ...partials },
      sql: partials.lastSql,
      attempts,
    });

    // 1. Selective describe: candidate tables only, budget-checked per call.
    const described: {
      table: string;
      columns: { name: string; type: string; nullable: boolean; sensitive: boolean }[];
    }[] = [];
    for (const table of input.candidateTables) {
      const check = checkBudget(budget);
      if (check.tripped) return budgetTrip(check.reason);
      const started = Date.now();
      let raw: unknown;
      try {
        raw = await this.mcp.call("describe_table", { ...identity, table });
      } catch (thrown) {
        const error = asDbToolError("describe_table", thrown);
        return { status: statusForError(error.code), error, sql: null, attempts };
      }
      const parsed = DescribeTableOutputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          status: "error",
          error: dbToolError(
            "INTERNAL_ERROR",
            "MCP tool describe_table returned an unexpected shape",
          ),
          sql: null,
          attempts,
        };
      }
      described.push({ table: parsed.data.table, columns: parsed.data.columns });
      partials.tablesDescribed.push(parsed.data.table);
      this.span({
        node: "describe",
        type: "tool_call",
        attempt: attempts,
        durationMs: Date.now() - started,
        payload: { tool: "describe_table", table: parsed.data.table },
      });
    }
    const catalog = input.catalog ?? catalogFromDescribe(described);

    // 2. Structured proposal through the injected model.
    {
      const check = checkBudget(budget);
      if (check.tripped) return budgetTrip(check.reason);
    }
    const proposalStarted = Date.now();
    let proposal: SqlProposal;
    try {
      proposal = await this.model
        .withStructuredOutput(SqlProposalSchema, { name: "sql_proposal" })
        .invoke(input.question);
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      return {
        status: "error",
        error: dbToolError(
          "INTERNAL_ERROR",
          `SQL proposal failed: ${message.slice(0, 200)}`,
        ),
        sql: null,
        attempts,
      };
    }
    recordLlmCall(budget);
    partials.lastSql = proposal.sql;
    this.span({
      node: "propose",
      type: "node_done",
      attempt: attempts,
      durationMs: Date.now() - proposalStarted,
      payload: { sql: proposal.sql, tablesUsed: proposal.tablesUsed },
    });

    // 3. Local pre-check: sqlGuard (D-01) then LocalQuerySafetyGate.
    // No MCP call happens past this point on failure.
    const guard = await sqlGuard(proposal.sql, catalog);
    if (!guard.ok) {
      return {
        status: statusForError(guard.error.code),
        error: guard.error,
        sql: proposal.sql,
        attempts,
      };
    }
    const gate = localQuerySafetyGate(proposal.sql, guard, catalog);
    if (gate.verdict === "deny") {
      return {
        status: "restricted",
        error: gate.error,
        sql: proposal.sql,
        attempts,
      };
    }
    if (gate.verdict === "needs_clarification") {
      return {
        status: "needs_clarification",
        reason: gate.reason,
        table: gate.table,
        sql: proposal.sql,
        attempts,
      };
    }
    const finalSql = gate.sql;

    // 4. explain_query before run_query (both budget-checked).
    {
      const check = checkBudget(budget);
      if (check.tripped) return budgetTrip(check.reason);
    }
    const explainStarted = Date.now();
    try {
      const rawExplain = await this.mcp.call("explain_query", {
        ...identity,
        sql: finalSql,
      });
      const parsedExplain = ExplainQueryOutputSchema.safeParse(rawExplain);
      if (!parsedExplain.success) {
        return {
          status: "error",
          error: dbToolError(
            "INTERNAL_ERROR",
            "MCP tool explain_query returned an unexpected shape",
          ),
          sql: finalSql,
          attempts,
        };
      }
      this.span({
        node: "explain",
        type: "tool_call",
        attempt: attempts,
        durationMs: Date.now() - explainStarted,
        payload: {
          tool: "explain_query",
          estimatedCost: parsedExplain.data.estimatedCost,
        },
      });
    } catch (thrown) {
      const error = asDbToolError("explain_query", thrown);
      return { status: statusForError(error.code), error, sql: finalSql, attempts };
    }

    // 5. run_query: rows pass through untouched (D-19).
    {
      const check = checkBudget(budget);
      if (check.tripped) return budgetTrip(check.reason);
    }
    const runStarted = Date.now();
    let run: {
      columns: string[];
      rows: Record<string, unknown>[];
      maskedColumns: string[];
    };
    try {
      const rawRun = await this.mcp.call("run_query", {
        ...identity,
        sql: finalSql,
        maxRows: 200,
      });
      const parsedRun = RunQueryOutputSchema.safeParse(rawRun);
      if (!parsedRun.success) {
        return {
          status: "error",
          error: dbToolError(
            "INTERNAL_ERROR",
            "MCP tool run_query returned an unexpected shape",
          ),
          sql: finalSql,
          attempts,
        };
      }
      run = {
        columns: parsedRun.data.columns,
        rows: parsedRun.data.rows,
        maskedColumns: parsedRun.data.maskedColumns,
      };
      partials.rowsFetched = parsedRun.data.rows.length;
      this.span({
        node: "run",
        type: "tool_call",
        attempt: attempts,
        durationMs: Date.now() - runStarted,
        payload: { tool: "run_query", rowCount: parsedRun.data.rowCount },
      });
    } catch (thrown) {
      const error = asDbToolError("run_query", thrown);
      return { status: statusForError(error.code), error, sql: finalSql, attempts };
    }

    if (run.rows.length === 0) {
      // Zero-row diagnostic (single probe) lands in the task-3 extension;
      // the core path concludes no_data directly.
      return {
        status: "no_data",
        sql: finalSql,
        tablesUsed: proposal.tablesUsed,
        columns: run.columns,
        rows: [],
        maskedColumns: run.maskedColumns,
        attempts,
      };
    }
    return {
      status: "ok",
      sql: finalSql,
      tablesUsed: proposal.tablesUsed,
      columns: run.columns,
      rows: run.rows,
      maskedColumns: run.maskedColumns,
      attempts,
    };
  }
}
