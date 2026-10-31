// ValidatedQueryExecutor (AGENT-02/03/04, 01-11): the ONLY agent-side SQL path.
// Selective describe_table for candidate tables -> structured SQL proposal
// -> local pre-check (sqlGuard from @shared/access-policy per D-01, then
// LocalQuerySafetyGate) -> explain_query -> run_query, with a bounded repair
// loop (D-02), one TIMEOUT simplification, and a single-pass zero-row
// diagnostic. The seams below are stable for 01-12.
//
// Boundaries: imports contracts, access-policy guard, zod only. Never pg,
// pg-cursor, or mcp-server/src (enforced by eslint.config.mjs). Numeric row
// values pass through untouched — D-19 coercion belongs to the 01-09 grader.

import {
  DescribeTableOutputSchema,
  ExplainQueryOutputSchema,
  REPAIRABLE_CODES,
  RunQueryOutputSchema,
  SampleRowsOutputSchema,
  dbToolError,
  type DbToolError,
  type ErrorCode,
  type SchemaCatalog,
} from "@shared/contracts";
import { sqlGuard } from "@shared/access-policy";
import * as z from "zod";
import {
  checkBudget,
  createBudgetState,
  recordLlmCall,
  type BudgetState,
  type BudgetTripReason,
} from "./budgets.js";
import {
  clampLimit,
  hasWhereFilter,
  localQuerySafetyGate,
} from "./safetyGate.js";

/** Hard cap on total attempts including the first try (D-02). */
export const MAX_ATTEMPTS = 3;

/** Tighter cap the TIMEOUT simplification enforces on the retry. */
export const TIMEOUT_RETRY_LIMIT = 50;

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

/** Conservative local fallback when a provider does not expose token usage. */
function estimateTokens(...texts: string[]): number {
  return Math.max(1, Math.ceil(texts.join("").length / 4));
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
  /** Total-attempt cap override for tests; defaults to MAX_ATTEMPTS. */
  maxAttempts?: number;
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

/**
 * Coerce an MCP failure into a DbToolError; unknown shapes fail closed as a
 * non-repairable INTERNAL_ERROR (hard abort, never a repair loop). Preserves
 * the server cursorPosition so the repair feedback can point at it.
 */
function asDbToolError(tool: string, thrown: unknown): DbToolError {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    "message" in thrown
  ) {
    const candidate = thrown as {
      code: unknown;
      message: unknown;
      cursorPosition?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      const cursor =
        typeof candidate.cursorPosition === "number"
          ? candidate.cursorPosition
          : undefined;
      return dbToolError(
        candidate.code as ErrorCode,
        `MCP tool ${tool} failed: ${candidate.message}`,
        cursor,
      );
    }
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return dbToolError(
    "INTERNAL_ERROR",
    `MCP tool ${tool} failed: ${message.slice(0, 200)}`,
  );
}

function isRepairable(code: ErrorCode): boolean {
  return (REPAIRABLE_CODES as readonly string[]).includes(code);
}

/**
 * TIMEOUT simplification (single rewrite): drop the ORDER BY tail and tighten
 * the LIMIT. The result always re-passes sqlGuard plus the safety gate before
 * any MCP call, so an over-aggressive strip fails closed instead of running.
 */
export function simplifyForTimeout(sql: string): string {
  const noOrder = sql.replace(
    /\s+ORDER\s+BY\s+[^;]*?(?=\s+LIMIT\b|\s+OFFSET\b|\s*;?\s*$)/i,
    "",
  );
  return clampLimit(noOrder, TIMEOUT_RETRY_LIMIT);
}

function catalogFromDescribe(
  outputs: {
    table: string;
    columns: {
      name: string;
      type: string;
      nullable: boolean;
      sensitive: boolean;
    }[];
  }[],
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
  private readonly maxAttempts: number;

  constructor(deps: ExecutorDeps) {
    this.model = deps.model;
    this.mcp = deps.mcp;
    this.emitSpan = deps.emitSpan ?? noopSpanSink;
    this.maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
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

    const budgetTrip = (
      reason: BudgetTripReason,
      attempts: number,
    ): Extract<ExecutorResult, { status: "cannot_answer" }> => ({
      status: "cannot_answer",
      reason: `run budget exceeded (${reason}); degrading to synthesis with partial findings`,
      budgetExceeded: true,
      tripReason: reason,
      partials: { ...partials, tablesDescribed: [...partials.tablesDescribed] },
      sql: partials.lastSql,
      attempts,
    });

    // 1. Selective describe: candidate tables only, budget-checked per call.
    // Describe failures return immediately — the catalog they would build is
    // the repair loop's ground truth, so there is nothing to repair with.
    const described: {
      table: string;
      columns: {
        name: string;
        type: string;
        nullable: boolean;
        sensitive: boolean;
      }[];
    }[] = [];
    for (const table of input.candidateTables) {
      const check = checkBudget(budget);
      if (check.tripped) return budgetTrip(check.reason, 0);
      const started = Date.now();
      let raw: unknown;
      try {
        raw = await this.mcp.call("describe_table", { ...identity, table });
      } catch (thrown) {
        const error = asDbToolError("describe_table", thrown);
        return { status: statusForError(error.code), error, sql: null, attempts: 1 };
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
          attempts: 1,
        };
      }
      described.push({ table: parsed.data.table, columns: parsed.data.columns });
      partials.tablesDescribed.push(parsed.data.table);
      this.span({
        node: "describe",
        type: "tool_call",
        attempt: 1,
        durationMs: Date.now() - started,
        payload: { tool: "describe_table", table: parsed.data.table },
      });
    }
    const catalog = input.catalog ?? catalogFromDescribe(described);

    // 2-5. Bounded repair loop (D-02): at most maxAttempts total including
    // the first try. Only REPAIRABLE_CODES retry; hard security codes abort on
    // attempt 1; TIMEOUT gets exactly one simplification rewrite.
    let attemptNo = 0;
    let lastError: DbToolError | null = null;
    let repairFeedback: string | null = null;
    let forcedSql: string | null = null;
    let lastTablesUsed: string[] = [];
    let timeoutSimplified = false;

    while (attemptNo < this.maxAttempts) {
      attemptNo += 1;
      const attempt = attemptNo;

      // Propose (skipped when a TIMEOUT simplification forces the SQL).
      let sql: string;
      if (forcedSql !== null) {
        sql = forcedSql;
        forcedSql = null;
      } else {
        const check = checkBudget(budget);
        if (check.tripped) return budgetTrip(check.reason, attempt);
        const proposalStarted = Date.now();
        let proposal: SqlProposal;
        const prompt =
          repairFeedback === null
            ? input.question
            : `${input.question}\n\nPrevious attempt ${attempt - 1} failed with ${repairFeedback}. Propose corrected read-only SQL.`;
        try {
          proposal = await this.model
            .withStructuredOutput(SqlProposalSchema, { name: "sql_proposal" })
            .invoke(prompt);
        } catch (thrown) {
          const message =
            thrown instanceof Error ? thrown.message : String(thrown);
          return {
            status: "error",
            error: dbToolError(
              "INTERNAL_ERROR",
              `SQL proposal failed: ${message.slice(0, 200)}`,
            ),
            sql: partials.lastSql,
            attempts: attempt,
          };
        }
        // Structured-output adapters do not consistently expose provider usage.
        // Charge a conservative local estimate so maxTokens remains a real
        // circuit breaker instead of an inert counter.
        recordLlmCall(budget, estimateTokens(prompt, JSON.stringify(proposal)));
        partials.lastSql = proposal.sql;
        sql = proposal.sql;
        lastTablesUsed = proposal.tablesUsed;
        this.span({
          node: "propose",
          type: "node_done",
          attempt,
          durationMs: Date.now() - proposalStarted,
          payload: { sql, tablesUsed: lastTablesUsed },
        });
      }

      // Local pre-check: sqlGuard (D-01) then LocalQuerySafetyGate.
      // No MCP call happens past this point on failure.
      const guard = await sqlGuard(sql, catalog);
      if (!guard.ok) {
        lastError = guard.error;
        if (isRepairable(guard.error.code) && attempt < this.maxAttempts) {
          repairFeedback = feedbackFor(lastError);
          this.span({
            node: "repair",
            type: "node_done",
            attempt,
            payload: { code: lastError.code, nextAttempt: attempt + 1 },
          });
          continue;
        }
        return {
          status: statusForError(guard.error.code),
          error: guard.error,
          sql,
          attempts: attempt,
        };
      }
      const gate = localQuerySafetyGate(sql, guard, catalog);
      if (gate.verdict === "deny") {
        lastError = gate.error;
        if (isRepairable(gate.error.code) && attempt < this.maxAttempts) {
          repairFeedback = feedbackFor(lastError);
          this.span({
            node: "repair",
            type: "node_done",
            attempt,
            payload: { code: lastError.code, nextAttempt: attempt + 1 },
          });
          continue;
        }
        return { status: "restricted", error: gate.error, sql, attempts: attempt };
      }
      if (gate.verdict === "needs_clarification") {
        return {
          status: "needs_clarification",
          reason: gate.reason,
          table: gate.table,
          sql,
          attempts: attempt,
        };
      }
      const finalSql = gate.sql;

      // explain_query before run_query (both budget-checked).
      {
        const check = checkBudget(budget);
        if (check.tripped) return budgetTrip(check.reason, attempt);
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
            attempts: attempt,
          };
        }
        this.span({
          node: "explain",
          type: "tool_call",
          attempt,
          durationMs: Date.now() - explainStarted,
          payload: {
            tool: "explain_query",
            estimatedCost: parsedExplain.data.estimatedCost,
          },
        });
      } catch (thrown) {
        const error = asDbToolError("explain_query", thrown);
        const routed = this.routeMcpError(error, {
          attempt,
          sql: finalSql,
          timeoutSimplified,
        });
        if (routed.retry) {
          lastError = error;
          timeoutSimplified = routed.timeoutSimplified;
          forcedSql = routed.forcedSql;
          repairFeedback = routed.feedback;
          continue;
        }
        return {
          status: statusForError(error.code),
          error,
          sql: finalSql,
          attempts: attempt,
        };
      }

      // run_query: rows pass through untouched (D-19).
      {
        const check = checkBudget(budget);
        if (check.tripped) return budgetTrip(check.reason, attempt);
      }
      const runStarted = Date.now();
      let columns: string[];
      let rows: Record<string, unknown>[];
      let maskedColumns: string[];
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
            attempts: attempt,
          };
        }
        columns = parsedRun.data.columns;
        rows = parsedRun.data.rows;
        maskedColumns = parsedRun.data.maskedColumns;
        partials.rowsFetched = rows.length;
        this.span({
          node: "run",
          type: "tool_call",
          attempt,
          durationMs: Date.now() - runStarted,
          payload: { tool: "run_query", rowCount: parsedRun.data.rowCount },
        });
      } catch (thrown) {
        const error = asDbToolError("run_query", thrown);
        const routed = this.routeMcpError(error, {
          attempt,
          sql: finalSql,
          timeoutSimplified,
        });
        if (routed.retry) {
          lastError = error;
          timeoutSimplified = routed.timeoutSimplified;
          forcedSql = routed.forcedSql;
          repairFeedback = routed.feedback;
          continue;
        }
        return {
          status: statusForError(error.code),
          error,
          sql: finalSql,
          attempts: attempt,
        };
      }

      if (rows.length === 0) {
        // Single-pass zero-row diagnostic: on an empty result at attempt 1
        // with filters present, issue at most one capped probe before
        // concluding no_data. Unfiltered or aggregate empties conclude
        // immediately with zero probes.
        if (attempt === 1 && hasWhereFilter(guard.ast)) {
          const diagnostic = await this.zeroRowProbe(
            guard.tables[0] ?? input.candidateTables[0],
            identity,
            budget,
            attempt,
          );
          if (diagnostic.budgetTripped) {
            return budgetTrip(diagnostic.budgetTripped, attempt);
          }
          return {
            status: "no_data",
            sql: finalSql,
            tablesUsed: lastTablesUsed,
            columns,
            rows: [],
            maskedColumns,
            attempts: attempt,
            diagnostic: diagnostic.note,
          };
        }
        return {
          status: "no_data",
          sql: finalSql,
          tablesUsed: lastTablesUsed,
          columns,
          rows: [],
          maskedColumns,
          attempts: attempt,
        };
      }
      return {
        status: "ok",
        sql: finalSql,
        tablesUsed: lastTablesUsed,
        columns,
        rows,
        maskedColumns,
        attempts: attempt,
      };
    }

    // Loop exhausted: every attempt failed repairable — surface the last.
    const terminal =
      lastError ??
      dbToolError("INTERNAL_ERROR", "repair loop exhausted without an error");
    return {
      status: statusForError(terminal.code),
      error: terminal,
      sql: partials.lastSql,
      attempts: attemptNo,
    };
  }

  /**
   * Route an MCP-stage DbToolError: TIMEOUT gets exactly one simplification
   * rewrite, other REPAIRABLE_CODES retry with feedback, everything else
   * (hard security codes, SCOPE_DENIED, INTERNAL_ERROR) aborts.
   */
  private routeMcpError(
    error: DbToolError,
    ctx: { attempt: number; sql: string; timeoutSimplified: boolean },
  ): {
    retry: true;
    forcedSql: string | null;
    feedback: string | null;
    timeoutSimplified: boolean;
  } | { retry: false } {
    if (error.code === "TIMEOUT" && !ctx.timeoutSimplified) {
      this.span({
        node: "repair",
        type: "node_done",
        attempt: ctx.attempt,
        payload: { code: "TIMEOUT", strategy: "simplify", nextAttempt: ctx.attempt + 1 },
      });
      return {
        retry: true,
        forcedSql: simplifyForTimeout(ctx.sql),
        feedback: null,
        timeoutSimplified: true,
      };
    }
    if (isRepairable(error.code) && ctx.attempt < this.maxAttempts) {
      this.span({
        node: "repair",
        type: "node_done",
        attempt: ctx.attempt,
        payload: { code: error.code, nextAttempt: ctx.attempt + 1 },
      });
      return {
        retry: true,
        forcedSql: null,
        feedback: feedbackFor(error),
        timeoutSimplified: ctx.timeoutSimplified,
      };
    }
    return { retry: false };
  }

  /**
   * The single zero-row probe: sample_rows (server cap n <= 5) against the
   * first scanned table. Never a full-table rescan; probe failure still
   * concludes no_data.
   */
  private async zeroRowProbe(
    table: string | undefined,
    identity: { runId: string; userId: string; roleScope: string },
    budget: BudgetState,
    attempt: number,
  ): Promise<{ note: string; budgetTripped?: BudgetTripReason }> {
    const target = table ?? "unknown";
    const check = checkBudget(budget);
    if (check.tripped) {
      return { note: "", budgetTripped: check.reason };
    }
    const started = Date.now();
    try {
      const raw = await this.mcp.call("sample_rows", {
        ...identity,
        table: target,
        n: 5,
      });
      const parsed = SampleRowsOutputSchema.safeParse(raw);
      const rowCount = parsed.success ? parsed.data.rowCount : -1;
      this.span({
        node: "diagnose",
        type: "tool_call",
        attempt,
        durationMs: Date.now() - started,
        payload: { tool: "sample_rows", table: target, rowCount },
      });
      return {
        note: `zero-row diagnostic: sample_rows ${target} n=5 returned ${rowCount} rows; filters match nothing, concluding no_data`,
      };
    } catch (thrown) {
      const error = asDbToolError("sample_rows", thrown);
      this.span({
        node: "diagnose",
        type: "tool_call",
        attempt,
        durationMs: Date.now() - started,
        payload: { tool: "sample_rows", table: target, probeError: error.code },
      });
      return {
        note: `zero-row diagnostic: sample_rows ${target} probe failed (${error.code}), concluding no_data`,
      };
    }
  }
}

function feedbackFor(error: DbToolError): string {
  const position =
    error.cursorPosition === undefined
      ? "unknown position"
      : `position ${error.cursorPosition}`;
  return `${error.code} at ${position}: ${error.message}`;
}
