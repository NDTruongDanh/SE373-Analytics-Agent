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
  type RowScopeApplied,
  type SchemaCatalog,
} from "@shared/contracts";
import { sqlGuard } from "@shared/access-policy";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import * as z from "zod";
import {
  checkBudget,
  createBudgetState,
  estimateTokens,
  recordLlmCall,
  type BudgetState,
  type BudgetTripReason,
} from "./budgets.js";
import {
  estimateCostUsd,
  invokeWithUsage,
  type LlmUsage,
} from "../telemetry/usage.js";
import {
  clampLimit,
  hasWhereFilter,
  localQuerySafetyGate,
} from "./safetyGate.js";
import { MAX_ATTEMPTS, TIMEOUT_RETRY_LIMIT } from "../constants.js";

export { MAX_ATTEMPTS, TIMEOUT_RETRY_LIMIT } from "../constants.js";

/** Rows retained for in-process validation; checkpoint state keeps only 50. */
export const TRANSIENT_ROW_BUFFER_MAX = 1000;
const DIAGNOSTIC_DISTINCT_LIMIT = 20;
const MAX_DIAGNOSTIC_FILTER_PROBES = 3;

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
    opts?: { name?: string; includeRaw?: boolean },
  ): {
    invoke(input: string, config?: { callbacks?: Callbacks }): Promise<SqlProposal>;
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
   * LangSmith callbacks from the enclosing graph run (same tracer object
   * the graph.invoke site passed). Optional: absent in unit/eval drivers,
   * which stay untraced by construction.
   */
  callbacks?: Callbacks;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

type FilterLiteral = {
  table: string;
  column: string;
  literal: string;
};

function stringField(value: unknown): string | undefined {
  const record = asRecord(value);
  const string = record ? asRecord(record["String"]) : undefined;
  const text = string?.["sval"];
  return typeof text === "string" ? text : undefined;
}

function columnRef(value: unknown): { qualifier?: string; column: string } | undefined {
  const inner = asRecord(asRecord(value)?.["ColumnRef"]);
  const fields = inner?.["fields"];
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  const names = fields.map(stringField);
  if (names.some((name) => name === undefined)) return undefined;
  const column = names[names.length - 1];
  if (column === undefined) return undefined;
  return {
    ...(names.length >= 2 && names[names.length - 2] !== undefined
      ? { qualifier: names[names.length - 2] }
      : {}),
    column,
  };
}

function stringConstant(value: unknown): string | undefined {
  const constant = asRecord(asRecord(value)?.["A_Const"]);
  if (!constant) return undefined;
  const scalar = constant["sval"];
  if (typeof scalar === "string") return scalar;
  const text = asRecord(scalar)?.["sval"];
  return typeof text === "string" ? text : stringField(scalar);
}

function tableAliases(ast: unknown, catalog: SchemaCatalog): Map<string, string> {
  const catalogNames = new Map(
    catalog.tables.map((table) => [table.name.toLowerCase(), table.name]),
  );
  const aliases = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    const rangeVar = asRecord(record["RangeVar"]);
    if (rangeVar) {
      const relname = rangeVar["relname"];
      const table =
        typeof relname === "string"
          ? catalogNames.get(relname.toLowerCase())
          : undefined;
      if (table) {
        aliases.set(table.toLowerCase(), table);
        const alias = asRecord(rangeVar["alias"])?.["aliasname"];
        if (typeof alias === "string" && alias.length > 0) {
          aliases.set(alias.toLowerCase(), table);
        }
      }
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(ast);
  return aliases;
}

function resolveFilterTable(
  ref: { qualifier?: string; column: string },
  aliases: Map<string, string>,
  catalog: SchemaCatalog,
  scannedTables: readonly string[],
): string | undefined {
  if (ref.qualifier) return aliases.get(ref.qualifier.toLowerCase());
  const scanned = new Set(scannedTables.map((table) => table.toLowerCase()));
  const matches = catalog.tables.filter(
    (table) =>
      scanned.has(table.name.toLowerCase()) &&
      table.columns.some((column) => column.name.toLowerCase() === ref.column.toLowerCase()),
  );
  return matches.length === 1 ? matches[0]?.name : undefined;
}

/**
 * Extract only direct WHERE comparisons between a real column and a string
 * literal. Each value stays paired to its table/alias-qualified column; this
 * avoids guessing from unrelated numeric predicates, SELECT expressions, or
 * comments.
 */
function stringFilterPredicates(
  ast: unknown,
  catalog: SchemaCatalog,
  scannedTables: readonly string[],
): FilterLiteral[] {
  const whereClauses: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    for (const [key, value] of Object.entries(record)) {
      if (key === "whereClause" && value !== undefined && value !== null) {
        whereClauses.push(value);
      }
      visit(value);
    }
  };
  visit(ast);

  const aliases = tableAliases(ast, catalog);
  const predicates = new Map<string, FilterLiteral>();
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    const expression = asRecord(record["A_Expr"]);
    if (expression) {
      const leftRef = columnRef(expression["lexpr"]);
      const rightRef = columnRef(expression["rexpr"]);
      const leftLiteral = stringConstant(expression["lexpr"]);
      const rightLiteral = stringConstant(expression["rexpr"]);
      const ref = leftRef && rightLiteral !== undefined
        ? leftRef
        : rightRef && leftLiteral !== undefined
          ? rightRef
          : undefined;
      const literal = leftRef && rightLiteral !== undefined
        ? rightLiteral
        : rightRef && leftLiteral !== undefined
          ? leftLiteral
          : undefined;
      if (ref && literal !== undefined) {
        const table = resolveFilterTable(ref, aliases, catalog, scannedTables);
        if (table) {
          const catalogTable = catalog.tables.find(
            (entry) => entry.name.toLowerCase() === table.toLowerCase(),
          );
          const column = catalogTable?.columns.find(
            (entry) => entry.name.toLowerCase() === ref.column.toLowerCase(),
          )?.name;
          if (column) {
            const predicate = { table, column, literal };
            predicates.set(`${table}\u0000${column}\u0000${literal}`, predicate);
          }
        }
      }
    }
    for (const value of Object.values(record)) collect(value);
  };
  for (const where of whereClauses) collect(where);
  return [...predicates.values()].slice(0, MAX_DIAGNOSTIC_FILTER_PROBES);
}

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function normalizeDiagnosticValue(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll("đ", "d")
    .replace(/[^a-z0-9]/g, "");
}

/** Detect a bounded synonym signal such as "Mien Nam" versus "Nam". */
function diagnosticMismatch(
  predicate: FilterLiteral,
  rows: Record<string, unknown>[],
): string | undefined {
  const values = rows
    .map((row) => row[predicate.column])
    .filter((value): value is string => typeof value === "string")
    .slice(0, DIAGNOSTIC_DISTINCT_LIMIT);
  const normalizedRequested = normalizeDiagnosticValue(predicate.literal);
  if (normalizedRequested.length < 2) return undefined;
  for (const actual of values) {
    const normalizedActual = normalizeDiagnosticValue(actual);
    if (
      normalizedActual.length >= 2 &&
      normalizedActual !== normalizedRequested &&
      (normalizedActual.includes(normalizedRequested) ||
        normalizedRequested.includes(normalizedActual))
    ) {
      return [
        "Zero-row diagnostic found one likely filter-value mismatch. Use only the evidence below to repair the SQL.",
        "<untrusted-diagnostic-data>",
        `table: ${predicate.table}`,
        `column: ${predicate.column}`,
        `requested: ${JSON.stringify(predicate.literal)}`,
        `observed: ${JSON.stringify(actual)}`,
        "</untrusted-diagnostic-data>",
      ].join("\n");
    }
  }
  return undefined;
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
        let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
        let usageModel: string | undefined;
        const prompt =
          repairFeedback === null
            ? input.question
            : `${input.question}\n\nPrevious attempt ${attempt - 1} failed with ${repairFeedback}. Propose corrected read-only SQL.`;
        try {
          const out = await invokeWithUsage(this.model, SqlProposalSchema, prompt, {
            name: "sql_proposal",
            callbacks: input.callbacks,
          });
          proposal = out.parsed;
          usage = { inputTokens: out.inputTokens, outputTokens: out.outputTokens };
          usageModel = out.model;
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
        // Real provider counts feed the budget when present; fakes and
        // usage-less adapters fall back to the conservative local estimate
        // so maxTokens remains a real circuit breaker instead of an inert
        // counter.
        const realTokens = usage.inputTokens + usage.outputTokens;
        recordLlmCall(
          budget,
          realTokens > 0
            ? realTokens
            : estimateTokens(prompt, JSON.stringify(proposal)),
        );
        const proposalDurationMs = Date.now() - proposalStarted;
        const { estimatedCostUsd, pricingKnown } = estimateCostUsd(
          usageModel,
          usage.inputTokens,
          usage.outputTokens,
        );
        this.span({
          node: "propose",
          type: "llm_call",
          attempt,
          durationMs: proposalDurationMs,
          payload: {
            model: usageModel ?? "unknown",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimatedCostUsd,
            pricingKnown,
          },
        });
        partials.lastSql = proposal.sql;
        sql = proposal.sql;
        lastTablesUsed = proposal.tablesUsed;
        this.span({
          node: "propose",
          type: "node_done",
          attempt,
          durationMs: proposalDurationMs,
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

      // run_query retains a bounded transient validation buffer; values pass
      // through untouched (D-19). Every attempt emits its own tool_call span:
      // ok:true on success, ok:false plus the contract code (never
      // message/PII) on failure, so run_done can derive attempt/failure counts.
      {
        const check = checkBudget(budget);
        if (check.tripped) return budgetTrip(check.reason, attempt);
      }
      const runStarted = Date.now();
      let columns: string[];
      let rows: Record<string, unknown>[];
      let maskedColumns: string[];
      let rowScopeApplied: RowScopeApplied[];
      try {
        const rawRun = await this.mcp.call("run_query", {
          ...identity,
          sql: finalSql,
          maxRows: TRANSIENT_ROW_BUFFER_MAX,
        });
        const parsedRun = RunQueryOutputSchema.safeParse(rawRun);
        if (!parsedRun.success) {
          this.span({
            node: "run",
            type: "tool_call",
            attempt,
            durationMs: Date.now() - runStarted,
            payload: { tool: "run_query", ok: false, code: "INTERNAL_ERROR" },
          });
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
        rows = parsedRun.data.rows.slice(0, TRANSIENT_ROW_BUFFER_MAX);
        maskedColumns = parsedRun.data.maskedColumns;
        rowScopeApplied = parsedRun.data.rowScopeApplied;
        partials.rowsFetched = rows.length;
        this.span({
          node: "run",
          type: "tool_call",
          attempt,
          durationMs: Date.now() - runStarted,
          payload: {
            tool: "run_query",
            ok: true,
            rowCount: parsedRun.data.rowCount,
            maskedColumns,
            rowScopeApplied,
          },
        });
      } catch (thrown) {
        const error = asDbToolError("run_query", thrown);
        this.span({
          node: "run",
          type: "tool_call",
          attempt,
          durationMs: Date.now() - runStarted,
          payload: { tool: "run_query", ok: false, code: error.code },
        });
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
            identity,
            budget,
            attempt,
            catalog,
            guard.ast,
            guard.tables,
          );
          if (diagnostic.budgetTripped) {
            return budgetTrip(diagnostic.budgetTripped, attempt);
          }
          if (diagnostic.repairFeedback && attempt < this.maxAttempts) {
            repairFeedback = diagnostic.repairFeedback;
            this.span({
              node: "repair",
              type: "node_done",
              attempt,
              payload: { strategy: "zero_row_diagnostic", nextAttempt: attempt + 1 },
            });
            continue;
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
   * One bounded zero-row diagnostic pass. It resolves direct string-literal
   * filters to their table/column pairs, re-describes and samples each relevant
   * table once, then runs guarded DISTINCT probes capped at 20 rows. Only a
   * concrete near-match may trigger attempt 2.
   */
  private async zeroRowProbe(
    identity: { runId: string; userId: string; roleScope: string },
    budget: BudgetState,
    attempt: number,
    catalog: SchemaCatalog,
    ast: unknown,
    scannedTables: readonly string[],
  ): Promise<{
    note: string;
    repairFeedback?: string;
    budgetTripped?: BudgetTripReason;
  }> {
    const predicates = stringFilterPredicates(ast, catalog, scannedTables);
    if (predicates.length === 0) {
      return {
        note:
          "zero-row diagnostic: no direct string-literal filter could be " +
          "safely resolved, concluding no_data",
      };
    }

    const described = new Set<string>();
    const sampled = new Set<string>();
    const notes: string[] = [];
    for (const predicate of predicates) {
      const tableKey = predicate.table.toLowerCase();
      if (!described.has(tableKey)) {
        const check = checkBudget(budget);
        if (check.tripped) return { note: "", budgetTripped: check.reason };
        try {
          const started = Date.now();
          const raw = await this.mcp.call("describe_table", {
            ...identity,
            table: predicate.table,
          });
          const parsed = DescribeTableOutputSchema.safeParse(raw);
          if (!parsed.success) {
            notes.push(`describe_table ${predicate.table} returned an unexpected shape`);
            continue;
          }
          described.add(tableKey);
          this.span({
            node: "diagnose",
            type: "tool_call",
            attempt,
            durationMs: Date.now() - started,
            payload: { tool: "describe_table", table: predicate.table },
          });
        } catch (thrown) {
          const error = asDbToolError("describe_table", thrown);
          notes.push(`describe_table ${predicate.table} probe failed (${error.code})`);
          this.span({
            node: "diagnose",
            type: "tool_call",
            attempt,
            payload: { tool: "describe_table", table: predicate.table, probeError: error.code },
          });
          continue;
        }
      }

      let sampleNote = "sample_rows was unavailable";
      if (!sampled.has(tableKey)) {
        const check = checkBudget(budget);
        if (check.tripped) return { note: "", budgetTripped: check.reason };
        try {
          const started = Date.now();
          const raw = await this.mcp.call("sample_rows", {
            ...identity,
            table: predicate.table,
            n: 5,
          });
          const parsed = SampleRowsOutputSchema.safeParse(raw);
          sampleNote = parsed.success
            ? `sample_rows ${predicate.table} n=5 returned ${parsed.data.rowCount} rows`
            : `sample_rows ${predicate.table} returned an unexpected shape`;
          sampled.add(tableKey);
          this.span({
            node: "diagnose",
            type: "tool_call",
            attempt,
            durationMs: Date.now() - started,
            payload: {
              tool: "sample_rows",
              table: predicate.table,
              ...(parsed.success ? { rowCount: parsed.data.rowCount } : {}),
            },
          });
        } catch (thrown) {
          const error = asDbToolError("sample_rows", thrown);
          sampleNote = `sample_rows ${predicate.table} probe failed (${error.code})`;
          sampled.add(tableKey);
          this.span({
            node: "diagnose",
            type: "tool_call",
            attempt,
            payload: { tool: "sample_rows", table: predicate.table, probeError: error.code },
          });
        }
      }

      const distinctSql =
        `SELECT DISTINCT ${quotedIdentifier(predicate.column)} ` +
        `FROM ${quotedIdentifier(predicate.table)} LIMIT ${DIAGNOSTIC_DISTINCT_LIMIT}`;
      const distinctGuard = await sqlGuard(distinctSql, catalog);
      if (!distinctGuard.ok) {
        notes.push(`guarded distinct ${predicate.table}.${predicate.column} was denied`);
        continue;
      }

      const explainCheck = checkBudget(budget);
      if (explainCheck.tripped) return { note: "", budgetTripped: explainCheck.reason };
      try {
        const started = Date.now();
        const raw = await this.mcp.call("explain_query", {
          ...identity,
          sql: distinctSql,
        });
        const parsed = ExplainQueryOutputSchema.safeParse(raw);
        if (!parsed.success) {
          notes.push(`distinct ${predicate.table}.${predicate.column} explain returned an unexpected shape`);
          continue;
        }
        this.span({
          node: "diagnose",
          type: "tool_call",
          attempt,
          durationMs: Date.now() - started,
          payload: {
            tool: "explain_query",
            table: predicate.table,
            column: predicate.column,
            estimatedCost: parsed.data.estimatedCost,
          },
        });
      } catch (thrown) {
        const error = asDbToolError("explain_query", thrown);
        notes.push(`distinct ${predicate.table}.${predicate.column} explain failed (${error.code})`);
        this.span({
          node: "diagnose",
          type: "tool_call",
          attempt,
          payload: {
            tool: "explain_query",
            table: predicate.table,
            column: predicate.column,
            probeError: error.code,
          },
        });
        continue;
      }

      const runCheck = checkBudget(budget);
      if (runCheck.tripped) return { note: "", budgetTripped: runCheck.reason };
      try {
        const started = Date.now();
        const raw = await this.mcp.call("run_query", {
          ...identity,
          sql: distinctSql,
          maxRows: DIAGNOSTIC_DISTINCT_LIMIT,
        });
        const parsed = RunQueryOutputSchema.safeParse(raw);
        if (!parsed.success) {
          notes.push(`distinct ${predicate.table}.${predicate.column} returned an unexpected shape`);
          continue;
        }
        this.span({
          node: "diagnose",
          type: "tool_call",
          attempt,
          durationMs: Date.now() - started,
          payload: {
            tool: "run_query",
            table: predicate.table,
            column: predicate.column,
            rowCount: parsed.data.rowCount,
          },
        });
        const repairFeedback = diagnosticMismatch(predicate, parsed.data.rows);
        const resultNote =
          `${sampleNote}; distinct ${predicate.table}.${predicate.column} ` +
          `returned ${parsed.data.rowCount} values`;
        if (repairFeedback) {
          return {
            note: `zero-row diagnostic: ${resultNote}; attempting one repair`,
            repairFeedback,
          };
        }
        notes.push(resultNote);
      } catch (thrown) {
        const error = asDbToolError("run_query", thrown);
        notes.push(`distinct ${predicate.table}.${predicate.column} probe failed (${error.code})`);
        this.span({
          node: "diagnose",
          type: "tool_call",
          attempt,
          payload: {
            tool: "run_query",
            table: predicate.table,
            column: predicate.column,
            probeError: error.code,
          },
        });
      }
    }
    return {
      note: `zero-row diagnostic: ${notes.join("; ")}; concluding no_data`,
    };
  }
}

function feedbackFor(error: DbToolError): string {
  const position =
    error.cursorPosition === undefined
      ? "unknown position"
      : `position ${error.cursorPosition}`;
  return `${error.code} at ${position}: ${error.message}`;
}
