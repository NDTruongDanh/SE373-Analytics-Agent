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
import { z } from "zod";
import {
  checkBudget,
  createBudgetState,
  estimateTokens,
  recordLlmCall,
  type BudgetState,
  type BudgetTripReason,
} from "./budgets.js";
import { buildSqlProposalPrompt, type DescribedTable } from "./prompt.js";
import {
  estimateCostUsd,
  extractFencedSqlProposal,
  invokeJsonWithUsage,
  invokeWithUsage,
  type LlmUsage,
} from "../telemetry/usage.js";
import {
  isRateLimitFailure,
  toModelDbToolError,
} from "../telemetry/retry.js";
import {
  clampLimit,
  hasWhereFilter,
  largeScannedTables,
  localQuerySafetyGate,
} from "./safetyGate.js";
import {
  ceilingsFor,
  costBreach,
  defaultQueryCostPolicy,
  type QueryCostPolicy,
} from "./costPolicy.js";
import { escapeUntrustedText, serializeUntrusted } from "../untrusted.js";
import { MAX_ATTEMPTS, TIMEOUT_RETRY_LIMIT } from "../constants.js";

export { MAX_ATTEMPTS, TIMEOUT_RETRY_LIMIT } from "../constants.js";

/** Rows retained for in-process validation; checkpoint state keeps only 50. */
export const TRANSIENT_ROW_BUFFER_MAX = 1000;
const DIAGNOSTIC_DISTINCT_LIMIT = 20;
const DIAGNOSTIC_MAX_OBSERVED_VALUES = 10;
const DIAGNOSTIC_MAX_VALUE_CHARS = 200;
const MAX_DIAGNOSTIC_FILTER_PROBES = 3;

/** Model SQL proposal (untrusted until gated). */
export const SqlProposalSchema = z.object({
  sql: z.string().min(1),
  tablesUsed: z.array(z.string()),
});

export type SqlProposal = z.infer<typeof SqlProposalSchema>;

export interface ChatModelLike {
  invoke(input: string, config?: { callbacks?: Callbacks }): Promise<unknown>;
  stream(
    input: string,
    config?: { callbacks?: Callbacks; signal?: AbortSignal; runName?: string },
  ): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  withStructuredOutput(
    schema: typeof SqlProposalSchema,
    opts?: { name?: string; includeRaw?: boolean },
  ): {
    invoke(input: string, config?: { callbacks?: Callbacks }): Promise<SqlProposal>;
  };
}

/** Run identity travels inside args so both fakes and header-injecting callers observe it. */
export interface McpToolCaller {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

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

export const noopSpanSink: SpanSink = () => "";

export interface ExecutorPrincipal {
  runId: string;
  userId: string;
  roleScope: string;
}

export interface ExecutorRunInput {
  question: string;
  /** Trusted SQL still passes describe, sqlGuard, LocalQuerySafetyGate, explain, and repair. */
  initialSql?: string;
  timeRange?: string | null;
  /** Only these tables are described — never a full-schema sweep. */
  candidateTables: string[];
  /** Trusted semantic-layer snippets (metric definitions, join rules, enum anchors); never row data. */
  references?: string[];
  principal: ExecutorPrincipal;
  /** LangSmith callbacks from the enclosing run; omitted in untraced unit/eval runs. */
  callbacks?: Callbacks;
  /** Authoritative catalog override carrying large-table flags absent from describe_table output. */
  catalog?: SchemaCatalog;
  budget?: BudgetState;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface TimeRangeOptionsInput {
  principal: ExecutorPrincipal;
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
      truncated?: boolean;
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
  maxAttempts?: number;
  costPolicy?: QueryCostPolicy;
}

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

/** Unknown failures fail closed as non-repairable INTERNAL_ERROR; preserves cursorPosition for repair feedback. */
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

/** Single-rewrite TIMEOUT simplification; result re-passes sqlGuard and safety gate so bad strips fail closed. */
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
      large?: boolean;
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
        large: column.large ?? false,
      })),
    })),
  };
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function quarterStart(date: string): Date {
  const value = new Date(`${date}T00:00:00.000Z`);
  return new Date(Date.UTC(value.getUTCFullYear(), Math.floor(value.getUTCMonth() / 3) * 3, 1));
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function quarterOptions(minDate: string, maxDate: string): string[] {
  const minimum = quarterStart(minDate);
  const maximum = quarterStart(maxDate);
  const quarters: string[] = [];
  for (let current = maximum; current >= minimum && quarters.length < 4; ) {
    const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 3, 1));
    quarters.push(`${formatIsoDate(current)}/${formatIsoDate(end)}`);
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 3, 1));
  }
  return quarters.reverse();
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

/** Direct WHERE string-literal filters only; avoids guessing from numeric predicates, projections, or comments. */
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

function canonicalTableSet(tables: readonly string[]): string {
  const unique = new Set(tables.map((t) => t.toLowerCase()));
  return JSON.stringify([...unique].sort());
}

function stripAstLocations(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => stripAstLocations(item));
  }
  const record = asRecord(node);
  if (!record) return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === "location") continue;
    out[key] = stripAstLocations(record[key]);
  }
  return out;
}

function canonicalSelectProjection(ast: unknown): string {
  const projections: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    const selectStmt = asRecord(record["SelectStmt"]);
    if (selectStmt) {
      projections.push(stripAstLocations(selectStmt["targetList"] ?? null));
    }
    for (const key of Object.keys(record).sort()) {
      visit(record[key]);
    }
  };
  visit(ast);
  return JSON.stringify(projections);
}

function diagnosticMismatch(
  predicate: FilterLiteral,
  rows: Record<string, unknown>[],
): string | undefined {
  const values = rows
    .map((row) => row[predicate.column])
    .filter((value): value is string => typeof value === "string")
    .slice(0, DIAGNOSTIC_MAX_OBSERVED_VALUES)
    .map((value) => value.slice(0, DIAGNOSTIC_MAX_VALUE_CHARS));
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
        "Zero-row diagnostic found one likely filter-value mismatch. Use only the evidence below to repair ONLY the filter literal; keep the tables and SELECT projection unchanged.",
        "<untrusted-diagnostic-data>",
        `table: ${escapeUntrustedText(predicate.table)}`,
        `column: ${escapeUntrustedText(predicate.column)}`,
        `requested: ${serializeUntrusted(predicate.literal)}`,
        `observed: ${serializeUntrusted(actual)}`,
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
  private readonly costPolicy: QueryCostPolicy | undefined;

  constructor(deps: ExecutorDeps) {
    this.model = deps.model;
    this.mcp = deps.mcp;
    this.emitSpan = deps.emitSpan ?? noopSpanSink;
    this.maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
    this.costPolicy = deps.costPolicy;
  }

  private span(
    event: Omit<ExecutorSpan, "spanId" | "parentSpanId"> & {
      parentSpanId?: string;
    },
  ): string {
    return this.emitSpan({ ...event });
  }

  /** Queries orders date bounds for quarter options without entering checkpoint state or synthesis prompts. */
  async timeRangeOptions(input: TimeRangeOptionsInput): Promise<string[]> {
    const budget = input.budget ?? createBudgetState();
    const sql =
      'SELECT MIN("purchase_date") AS min_date, MAX("purchase_date") AS max_date ' +
      'FROM "orders" WHERE "purchase_date" IS NOT NULL';
    let check = checkBudget(budget);
    if (check.tripped) return [];
    const explainStarted = Date.now();
    try {
      const rawExplain = await this.mcp.call("explain_query", {
        ...input.principal,
        sql,
      });
      const parsedExplain = ExplainQueryOutputSchema.safeParse(rawExplain);
      if (!parsedExplain.success) return [];
      this.span({
        node: "clarify",
        type: "tool_call",
        attempt: 0,
        durationMs: Date.now() - explainStarted,
        payload: {
          tool: "explain_query",
          purpose: "time_range_options",
          estimatedCost: parsedExplain.data.estimatedCost,
        },
      });
    } catch (thrown) {
      const error = asDbToolError("explain_query", thrown);
      this.span({
        node: "clarify",
        type: "tool_call",
        attempt: 0,
        durationMs: Date.now() - explainStarted,
        payload: { tool: "explain_query", purpose: "time_range_options", probeError: error.code },
      });
      return [];
    }

    check = checkBudget(budget);
    if (check.tripped) return [];
    const runStarted = Date.now();
    try {
      const raw = await this.mcp.call("run_query", {
        ...input.principal,
        sql,
        maxRows: 1,
      });
      const parsed = RunQueryOutputSchema.safeParse(raw);
      if (!parsed.success) return [];
      this.span({
        node: "clarify",
        type: "tool_call",
        attempt: 0,
        durationMs: Date.now() - runStarted,
        payload: { tool: "run_query", purpose: "time_range_options", rowCount: parsed.data.rowCount },
      });
      const row = parsed.data.rows[0];
      const minDate = isoDate(row?.["min_date"]);
      const maxDate = isoDate(row?.["max_date"]);
      return minDate && maxDate ? quarterOptions(minDate, maxDate) : [];
    } catch (thrown) {
      const error = asDbToolError("run_query", thrown);
      this.span({
        node: "clarify",
        type: "tool_call",
        attempt: 0,
        durationMs: Date.now() - runStarted,
        payload: { tool: "run_query", purpose: "time_range_options", probeError: error.code },
      });
      return [];
    }
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

    // Describe failures abort immediately because the resulting catalog is the repair loop's ground truth.
    const described: DescribedTable[] = [];
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
      described.push({
        table: parsed.data.table,
        columns: parsed.data.columns,
        primaryKey: parsed.data.primaryKey,
        foreignKeys: parsed.data.foreignKeys,
      });
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

    const effectiveMaxAttempts =
      typeof input.maxAttempts === "number" && input.maxAttempts > 0
        ? Math.min(input.maxAttempts, this.maxAttempts)
        : this.maxAttempts;
    let attemptNo = 0;
    let lastError: DbToolError | null = null;
    let repairFeedback: string | null = null;
    let forcedSql: string | null = input.initialSql ?? null;
    let lastTablesUsed: string[] = [];
    let timeoutSimplified = false;
    let diagnosticBaseline: { tables: string; projection: string } | null = null;

    while (attemptNo < effectiveMaxAttempts) {
      attemptNo += 1;
      const attempt = attemptNo;

      let sql: string;
      if (forcedSql !== null) {
        sql = forcedSql;
        forcedSql = null;
        partials.lastSql = sql;
      } else {
        const check = checkBudget(budget);
        if (check.tripped) return budgetTrip(check.reason, attempt);
        const proposalStarted = Date.now();
        let proposal: SqlProposal;
        let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
        let usageModel: string | undefined;
        const prompt = buildSqlProposalPrompt({
          question: input.question,
          timeRange: input.timeRange,
          described,
          references: input.references,
          repair:
            repairFeedback === null
              ? null
              : { attempt: attempt - 1, feedback: repairFeedback },
        });
        try {
          // Avoid response_format on the wire because the provider's strict json_schema path hits timeouts;
          // schema validation still fails closed, and withStructuredOutput remains for legacy fakes.
          const callOpts = {
            name: "sql_proposal",
            callbacks: input.callbacks,
            node: "propose",
            budget,
            deadlineMs: budget.deadlineMs,
            signal: input.signal,
            outerAttempt: attempt,
            emit: (event: {
              node: string;
              type: string;
              attempt?: number;
              durationMs: number;
              payload?: unknown;
            }) =>
              this.span({
                node: event.node,
                type: event.type,
                attempt: event.attempt ?? attempt,
                durationMs: event.durationMs,
                payload: event.payload,
              }),
          };
          const hasPlainTransport =
            typeof this.model.stream === "function" ||
            typeof this.model.invoke === "function";
          const out =
            !hasPlainTransport &&
            typeof this.model.withStructuredOutput === "function"
              ? await invokeWithUsage(
                  this.model,
                  SqlProposalSchema,
                  prompt,
                  callOpts,
                )
              : await invokeJsonWithUsage(
                  this.model,
                  SqlProposalSchema,
                  prompt,
                  { ...callOpts, fallbackParse: extractFencedSqlProposal },
                );
          proposal = out.parsed;
          usage = { inputTokens: out.inputTokens, outputTokens: out.outputTokens };
          usageModel = out.model;
        } catch (thrown) {
          if (isRateLimitFailure(thrown)) {
            return {
              status: "error",
              error: toModelDbToolError(thrown, "SQL proposal failed"),
              sql: partials.lastSql,
              attempts: attempt,
            };
          }
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
        // Fall back to estimated tokens when provider usage is absent so maxTokens still trips.
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

      const guard = await sqlGuard(sql, catalog);
      if (!guard.ok) {
        lastError = guard.error;
        if (isRepairable(guard.error.code) && attempt < effectiveMaxAttempts) {
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
      if (diagnosticBaseline !== null) {
        const tablesMatch =
          canonicalTableSet(guard.tables) === diagnosticBaseline.tables;
        const projectionMatch =
          canonicalSelectProjection(guard.ast) === diagnosticBaseline.projection;
        if (!tablesMatch || !projectionMatch) {
          this.span({
            node: "repair",
            type: "node_done",
            attempt,
            payload: {
              code: "FORBIDDEN_STATEMENT",
              strategy: "zero_row_diagnostic_rejected",
              tablesMatch,
              projectionMatch,
            },
          });
          return {
            status: "restricted",
            error: dbToolError(
              "FORBIDDEN_STATEMENT",
              "Diagnostic-driven SQL repair may only change filter literals; table set and SELECT projection must match attempt 1",
            ),
            sql,
            attempts: attempt,
          };
        }
      }
      const gate = localQuerySafetyGate(sql, guard, catalog);
      if (gate.verdict === "deny") {
        lastError = gate.error;
        if (isRepairable(gate.error.code) && attempt < effectiveMaxAttempts) {
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
        if (input.timeRange?.trim() && attempt < effectiveMaxAttempts) {
          repairFeedback = [
            "The user already supplied a time range, but the SQL did not include a valid conjunctive orders.purchase_date range predicate.",
            "Use the selected range exactly as a [start, end) bound and preserve the requested metric.",
          ].join(" ");
          this.span({
            node: "repair",
            type: "node_done",
            attempt,
            payload: { strategy: "selected_time_range", nextAttempt: attempt + 1 },
          });
          continue;
        }
        return {
          status: "needs_clarification",
          reason: gate.reason,
          table: gate.table,
          sql,
          attempts: attempt,
        };
      }
      const finalSql = gate.sql;
      lastTablesUsed = guard.tables;

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
        const ceilings = ceilingsFor(
          this.costPolicy ?? defaultQueryCostPolicy(),
          input.principal.roleScope,
        );
        const breach = costBreach(parsedExplain.data, ceilings);
        if (breach) {
          const table =
            largeScannedTables(guard, catalog)[0] ?? guard.tables[0];
          this.span({
            node: "explain",
            type: "node_done",
            attempt,
            payload: { strategy: "cost_ceiling", ...breach },
          });
          return {
            status: "needs_clarification",
            reason:
              `The query plan is too expensive (${breach.metric} ${Math.round(breach.estimate)} ` +
              `exceeds the ${breach.ceiling} ceiling); choose a narrower time range before running it.`,
            ...(table ? { table } : {}),
            sql: finalSql,
            attempts: attempt,
          };
        }
      } catch (thrown) {
        const error = asDbToolError("explain_query", thrown);
        const routed = this.routeMcpError(error, {
          attempt,
          sql: finalSql,
          timeoutSimplified,
          maxAttempts: effectiveMaxAttempts,
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

      // Emit ok/code only (never message/PII) per attempt so run_done can derive attempt/failure counts.
      {
        const check = checkBudget(budget);
        if (check.tripped) return budgetTrip(check.reason, attempt);
      }
      const runStarted = Date.now();
      let columns: string[];
      let rows: Record<string, unknown>[];
      let truncated = false;
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
        truncated = parsedRun.data.truncated;
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
            truncated,
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
          maxAttempts: effectiveMaxAttempts,
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
          if (diagnostic.repairFeedback && attempt < effectiveMaxAttempts) {
            diagnosticBaseline = {
              tables: canonicalTableSet(guard.tables),
              projection: canonicalSelectProjection(guard.ast),
            };
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
        truncated,
        maskedColumns,
        attempts: attempt,
      };
    }

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

  private routeMcpError(
    error: DbToolError,
    ctx: { attempt: number; sql: string; timeoutSimplified: boolean; maxAttempts?: number },
  ): {
    retry: true;
    forcedSql: string | null;
    feedback: string | null;
    timeoutSimplified: boolean;
  } | { retry: false } {
    const maxAttempts = ctx.maxAttempts ?? this.maxAttempts;
    if (error.code === "TIMEOUT" && !ctx.timeoutSimplified && ctx.attempt < maxAttempts) {
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
    if (isRepairable(error.code) && ctx.attempt < maxAttempts) {
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
