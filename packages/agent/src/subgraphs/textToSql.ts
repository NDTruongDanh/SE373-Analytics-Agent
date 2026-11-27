import {
  dbToolError,
  ListTablesOutputSchema,
} from "@shared/contracts";
import { z } from "zod";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import {
  createChatModel,
  createSemanticCacheContext,
} from "../models/factory.js";
import {
  estimateCostUsd,
  invokeJsonWithUsage,
  invokeWithUsage,
  unaccountedUsage,
  type PlainJsonModelLike,
} from "../telemetry/usage.js";
import {
  isRateLimitFailure,
  toModelDbToolError,
} from "../telemetry/retry.js";
import {
  budgetTripReasonFromError,
  checkBudget,
  createBudgetState,
  estimateTokens,
  formatBudgetTripTemplate,
  type BudgetState,
  type BudgetTripReason,
} from "../queryExecutor/budgets.js";
import {
  TRANSIENT_ROW_BUFFER_MAX,
  ValidatedQueryExecutor,
  type ChatModelLike,
  type ExecutorResult,
  type ExecutorRunInput,
  type McpToolCaller,
} from "../queryExecutor/executor.js";
import { setTransientQueryBuffer } from "../queryExecutor/transientBuffer.js";
import {
  callMcpTool,
  parseMcpToolError,
  toNormalizedMcpError,
  type TracerRunConfig,
} from "../mcpClient.js";
import { loadSkill } from "../skills/loader.js";
import {
  classifyTableClarificationValue,
  isClarificationOption,
  isGraphInterrupt,
  pauseForClarification,
  requestClarification,
} from "../hitl.js";
import {
  IntentSchema,
  type AgentState,
  type AgentUpdate,
  type CatalogTable,
  type RootRuntime,
  type UcEntryHandler,
  type PendingClarification,
} from "../state.js";
import { loadSemanticCatalogIds, loadSemanticJoinEdges } from "../semantic/catalog.js";
import {
  buildCannotAnswer,
  checkUnknownTerms,
  fetchSemanticChunks,
  RETRIEVE_TOP_K,
  toStateChunk,
  type SemanticSearchFn,
} from "../semantic/retrieveSemantic.js";
import {
  buildIntentPrompt,
  entityCoverage,
  foldAscii,
  matchEntityInCatalog,
  resolveCandidateTables,
  selectSqlReferences,
  suggestClarificationTables,
  type ResolveCandidateTablesResult,
} from "./tableResolver.js";
import {
  deriveCitations,
  repairCitations,
  validateCitations,
} from "../validators/citationValidator.js";
import { BUDGET_LIMITS } from "../constants.js";


export const IntentProposalSchema = IntentSchema;
export type IntentProposal = z.infer<typeof IntentProposalSchema>;

export interface IntentModelLike {
  withStructuredOutput(
    schema: typeof IntentProposalSchema,
    opts?: { name?: string; includeRaw?: boolean },
  ): {
    invoke(input: string, config?: { callbacks?: Callbacks }): Promise<IntentProposal>;
  };
}

export interface TextToSqlExecutorLike {
  run(input: ExecutorRunInput): Promise<ExecutorResult>;
  timeRangeOptions?(input: {
    principal: ExecutorRunInput["principal"];
    budget: BudgetState;
  }): Promise<string[]>;
}

export interface TextToSqlRuntimeDeps {
  intentModel?: IntentModelLike;
  intentJsonModel?: PlainJsonModelLike;
  sqlModel?: ChatModelLike;
  executor?: TextToSqlExecutorLike;
  catalogIds?: string[] | ReadonlySet<string>;
  listTables?: (rt: RootRuntime) => Promise<CatalogTable[]>;
  semanticSearch?: SemanticSearchFn;
}

export function guardTextToSqlBudget(state: AgentState): AgentUpdate {
  const fresh = createBudgetState({
    maxLlmCalls: state.budget.maxLlmCalls,
    maxTokens: state.budget.maxTokens,
  });
  const budget = {
    ...fresh,
    llmCalls: state.budget.llmCalls,
    tokensUsed: state.budget.tokensUsed,
    deadlineMs: state.budget.deadlineMs > 0 ? state.budget.deadlineMs : fresh.deadlineMs,
  };
  const check = checkBudget(budget);
  if (check.tripped) {
    return {
      status: "error",
      budgetExceeded: true,
      answerText: formatBudgetTripTemplate({
        reason: check.reason,
        budget,
        completed: [
          ...state.tablesUsed.map((table) => `Queried table ${table}`),
          ...(state.rowCount !== null ? [`Verified query returned ${state.rowCount} rows`] : []),
        ],
        verifiedSql: state.status === "ok" || state.status === "no_data" ? state.sql : null,
        rowCount: state.rowCount ?? undefined,
        remaining: ["Understand the question, plan SQL, and retrieve the requested result"],
      }),
      budget: { deadlineMs: budget.deadlineMs },
    };
  }
  return { budgetExceeded: false, budget: { deadlineMs: budget.deadlineMs } };
}

function readRunContext(rt: RootRuntime): {
  identity: { runId: string; userId: string; roleScope: string; rowScope?: unknown } | null;
  transport: TracerRunConfig | null;
} {
  const config = (rt.config.configurable ?? {}) as Record<string, unknown>;
  const read = (key: string): string | null => {
    const value = config[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const runId = read("runId");
  const userId = read("userId");
  const roleScope = read("roleScope");
  const rowScope = Object.hasOwn(config, "rowScope") ? config["rowScope"] : undefined;
  const identity = runId && userId && roleScope
    ? { runId, userId, roleScope, ...(rowScope !== undefined ? { rowScope } : {}) }
    : null;
  const mcpUrl = read("mcpUrl");
  const token = read("token");
  const transport =
    mcpUrl && token && identity
      ? {
          mcpUrl,
          token,
          runId: identity.runId,
          userId: identity.userId,
          roleScope: identity.roleScope,
          ...(identity.rowScope !== undefined ? { rowScope: identity.rowScope as TracerRunConfig["rowScope"] } : {}),
          callbacks: rt.config.callbacks,
        }
      : null;
  return { identity, transport };
}

/** MCP adapter for the shared executor. Identity stays in transport headers. */
function createRuntimeMcpCaller(config: TracerRunConfig): McpToolCaller {
  return {
    call: async (tool, args) => {
      const toolArgs = { ...args };
      delete toolArgs.runId;
      delete toolArgs.userId;
      delete toolArgs.roleScope;
      const result = await callMcpTool(config, tool, toolArgs);
      if (result.isError) throw parseMcpToolError(tool, result.text);
      try {
        return JSON.parse(result.text) as unknown;
      } catch {
        throw dbToolError(
          "INTERNAL_ERROR",
          `MCP tool ${tool} returned invalid JSON`,
        );
      }
    },
  };
}

async function fetchCatalogTables(transport: TracerRunConfig): Promise<CatalogTable[]> {
  const result = await callMcpTool(transport, "list_tables", {});
  if (result.isError) throw parseMcpToolError("list_tables", result.text);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.text);
  } catch {
    throw dbToolError("INTERNAL_ERROR", "MCP tool list_tables returned invalid JSON");
  }
  const validated = ListTablesOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw dbToolError(
      "INTERNAL_ERROR",
      "MCP tool list_tables returned an unexpected shape",
    );
  }
  return validated.data.tables;
}

type CatalogLoadResult =
  | { ok: true; tables: CatalogTable[]; calledTool: boolean }
  | {
      ok: false;
      catalogStatus: "empty" | "error";
      status: "error" | "restricted";
      answerText: string;
    };

async function loadCatalogForRun(
  deps: TextToSqlRuntimeDeps,
  rt: RootRuntime,
  transport: TracerRunConfig | null,
  node: string,
): Promise<CatalogLoadResult> {
  if (!deps.listTables && (deps.executor || !transport)) {
    if (!deps.executor && !transport) {
      return {
        ok: false,
        catalogStatus: "error",
        status: "error",
        answerText: "text-to-SQL MCP transport identity is incomplete.",
      };
    }
    return { ok: true, tables: [], calledTool: false };
  }
  const started = Date.now();
  try {
    const tables = deps.listTables
      ? await deps.listTables(rt)
      : await fetchCatalogTables(transport!);
    rt.emit({
      node,
      type: "tool_call",
      durationMs: Date.now() - started,
      payload: {
        tool: "list_tables",
        ok: true,
        tableCount: tables.length,
        tables: tables.map((t) => t.name),
      },
    });
    if (tables.length === 0) {
      return {
        ok: false,
        catalogStatus: "empty",
        status: "error",
        answerText:
          "Schema catalog is empty (list_tables returned no tables); cannot determine query tables.",
      };
    }
    return { ok: true, tables, calledTool: true };
  } catch (thrown) {
    const err = toNormalizedMcpError("list_tables", thrown);
    rt.emit({
      node,
      type: "tool_call",
      durationMs: Date.now() - started,
      payload: { tool: "list_tables", ok: false, code: err.code },
    });
    return {
      ok: false,
      catalogStatus: "error",
      status:
        err.code === "SCOPE_DENIED" || err.code === "UNAUTHORIZED"
          ? "restricted"
          : "error",
      answerText: `Schema catalog lookup failed (${err.code}): ${err.message}`,
    };
  }
}

function dedupeTools(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tool of tools) {
    if (tool && !seen.has(tool)) {
      seen.add(tool);
      out.push(tool);
    }
  }
  return out;
}

type ExecutorStatus = ExecutorResult["status"];

const EXECUTOR_UPDATE_MAP: {
  [K in ExecutorStatus]: (result: Extract<ExecutorResult, { status: K }>) => AgentUpdate;
} = {
  ok: (result) => ({
    status: "ok",
    answerText: "",
    sql: result.sql,
    tablesUsed: result.tablesUsed,
    columns: result.columns,
    resultPreview: result.rows.slice(0, 50),
    resultTruncated: Boolean(result.truncated),
    rowCount: result.truncated ? null : result.rows.length,
  }),
  no_data: (result) => ({
    status: "no_data",
    sql: result.sql,
    tablesUsed: result.tablesUsed,
    columns: result.columns,
    resultPreview: [],
    resultTruncated: false,
    rowCount: 0,
    answerText: "",
  }),
  needs_clarification: (result) => ({
    status: "needs_clarification",
    sql: result.sql,
    answerText: result.reason,
  }),
  restricted: (result) => ({
    status: "restricted",
    sql: result.sql,
    answerText: result.error.message,
  }),
  error: (result) => {
    const budgetTrip = "budgetExceeded" in result && result.budgetExceeded;
    return {
      status: "error",
      budgetExceeded: Boolean(budgetTrip),
      sql: result.sql,
      answerText: budgetTrip ? result.reason : result.error.message,
    };
  },
};

function updateFromExecutor(
  result: ExecutorResult,
  state: AgentState,
  catalogIds: string[] | ReadonlySet<string>,
): AgentUpdate {
  const handler = EXECUTOR_UPDATE_MAP[result.status] as (
    r: ExecutorResult,
  ) => AgentUpdate;
  const update = handler(result);
  if (result.status === "ok" && state.runId) {
    setTransientQueryBuffer(state.runId, {
      columns: result.columns,
      rows: result.rows.slice(0, TRANSIENT_ROW_BUFFER_MAX),
      truncated: Boolean(result.truncated),
    });
  }
  if ((result.status === "ok" || result.status === "no_data") && typeof update.sql === "string") {
    const headed = withCitationHeader(state, update.sql, catalogIds);
    if (headed === null) {
      // Fail closed on persistent citation failure rather than shipping an unverified SQL header.
      return {
        status: "cannot_answer",
        sql: result.sql,
        answerText:
          "Citation check failed (metric queries must cite at least one retrieved metric:* chunk in the semantic catalog); cannot answer without verified citations.",
      };
    }
    return { ...update, sql: headed };
  }
  return update;
}

function handleDefinitionLookup(
  state: AgentState,
  catalogIds: string[] | ReadonlySet<string>,
): AgentUpdate | null {
  if (state.intent.queryMode !== "definition_lookup") return null;
  const metrics = state.intent.requestedMetrics;
  const metricsLabel = metrics.length > 0 ? metrics.join(", ") : "the requested term";
  const chunks = state.semanticChunks;
  if (chunks.length === 0) {
    return {
      status: "cannot_answer",
      answerText: `No semantic definitions were retrieved for this question; cannot define ${metricsLabel}.`,
    };
  }
  const retrievedIds = chunks.map((chunk) => chunk.chunkId);
  const metricCitations = chunks
    .filter((chunk) => chunk.chunkId.startsWith("metric:"))
    .map((chunk) => chunk.chunkId)
    .slice(0, 5);
  const candidateCitations =
    metricCitations.length > 0 ? metricCitations : deriveCitations(retrievedIds);
  const citationInput = {
    citations: candidateCitations,
    sql: null,
    requestedMetrics: metrics,
    retrievedChunkIds: retrievedIds,
    catalogIds,
  };
  const checked = validateCitations(citationInput);
  const verified = checked.ok ? checked : repairCitations(citationInput, 2);
  if (!verified.ok) {
    return {
      status: "cannot_answer",
      answerText:
        `Citation check failed for definition lookup (${verified.issue.message}); cannot define ${metricsLabel} without verified catalog citations.`,
    };
  }
  const lines = chunks.slice(0, 5).map((chunk) => {
    const snippet = (chunk.text ?? "").slice(0, 300);
    // Fixed 2 decimals prevents raw floats like 0.0327868852 from triggering the phone-number PII tripwire.
    const score = chunk.score !== undefined ? chunk.score.toFixed(2) : undefined;
    if (snippet && score !== undefined) return `${chunk.chunkId} (score: ${score}): ${snippet}`;
    if (snippet) return `${chunk.chunkId}: ${snippet}`;
    if (score !== undefined) return `${chunk.chunkId} (score: ${score})`;
    return `${chunk.chunkId}`;
  });
  const citations = verified.citations.filter((id) => id.startsWith("metric:"));
  const displayedCitations = citations.length > 0 ? citations : verified.citations;
  const citationLine =
    displayedCitations.length > 0 ? `\nCitations: ${displayedCitations.join(", ")}.` : "";
  const prefix =
    metrics.length > 0 ? `Definitions for ${metrics.join(", ")}:\n` : "Definitions:\n";
  return {
    status: "ok",
    sql: null,
    tablesUsed: [],
    columns: [],
    resultPreview: [],
    answerText: `${prefix}${lines.map((line) => `- ${line}`).join("\n")}${citationLine}`,
  };
}

function handleUnknownTerm(
  state: AgentState,
  catalogIds: string[] | ReadonlySet<string>,
): AgentUpdate | null {
  const metrics = state.intent.requestedMetrics;
  const chunks = state.semanticChunks;
  if (metrics.length === 0) return null;
  // Fail closed: metrics present but no retrieved chunks means nothing is grounded — never let the executor run ungrounded.
  if (chunks.length === 0) return buildCannotAnswer(metrics, [], catalogIds);
  const { ungrounded } = checkUnknownTerms(metrics, chunks);
  if (ungrounded.length === 0) return null;
  return buildCannotAnswer(ungrounded, chunks, catalogIds);
}

function withCitationHeader(
  state: AgentState,
  sql: string | null,
  catalogIds: string[] | ReadonlySet<string>,
): string | null {
  if (sql === null || sql === undefined) return sql;
  const retrievedIds = state.semanticChunks.map((chunk) => chunk.chunkId);
  if (retrievedIds.length === 0) return sql;
  const citations = deriveCitations(retrievedIds);
  if (citations.length === 0) return sql;
  const input = {
    citations,
    sql,
    requestedMetrics: state.intent.requestedMetrics,
    retrievedChunkIds: retrievedIds,
    catalogIds,
  };
  const checked = validateCitations(input);
  if (checked.ok) return checked.sql;
  const repaired = repairCitations(input, 2);
  if (repaired.ok) return repaired.sql;
  return null;
}

const KNOWN_TOOL_NAMES = new Set([
  "describe_table",
  "explain_query",
  "run_query",
  "sample_rows",
]);

function clarificationForLargeQuery(table: string | undefined, options: string[], attempts: number) {
  return requestClarification({
    field: "timeRange",
    question:
      `Truy vấn bảng lớn ${table ?? "này"} cần một khoảng thời gian theo orders.purchase_date. ` +
      "Bạn muốn xem khoảng nào? Mỗi lựa chọn có dạng [bắt_đầu/kết_thúc).",
    options,
    attempts,
    ...(table ? { table } : {}),
  });
}

function clarificationForAmbiguousMetric(
  state: AgentState,
): PendingClarification | "exhausted" | null {
  if (state.intent.metric !== null || state.intent.queryMode !== "standard_query") return null;
  const options = [...new Set(state.intent.requestedMetrics.map((metric) => metric.trim()))]
    .filter((metric) => metric.length > 0);
  if (options.length < 2 || options.length > 4) return null;
  if (state.clarificationAttempts >= 2) {
    return "exhausted";
  }
  const clarification = requestClarification({
    field: "metric",
    question: `Bạn muốn xem chỉ số nào: ${options.join(", ")}?`,
    options,
    attempts: state.clarificationAttempts,
  });
  return clarification.pendingClarification;
}

function clarificationAttemptsOf(state: AgentState): number {
  const n = state.clarificationAttempts;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

function isTimeoutResumeValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { action?: unknown }).action === "timeout" ||
      (value as { reason?: unknown }).reason === "HITL_APPROVAL_TIMEOUT")
  );
}

function isTimeoutResumeInScratchpad(rt: RootRuntime): boolean {
  const conf = (rt.config?.configurable ?? {}) as Record<string, unknown>;
  const scratch = conf["__pregel_scratchpad"] as
    | { nullResume?: unknown; resume?: unknown[] }
    | undefined;
  if (!scratch) return false;
  if (isTimeoutResumeValue(scratch.nullResume)) return true;
  return Array.isArray(scratch.resume) && scratch.resume.some(isTimeoutResumeValue);
}

type ClarificationSelectionResult =
  | { ok: true; value: string }
  | { ok: false; reason: "timeout" | "exhausted" };

function clarificationSelection(
  state: AgentState,
  request: PendingClarification,
): ClarificationSelectionResult {
  for (let attempt = clarificationAttemptsOf(state); attempt < 2; attempt += 1) {
    const pending = { ...request, attempts: attempt };
    const value = pauseForClarification(pending);
    if (isTimeoutResumeValue(value)) {
      return { ok: false, reason: "timeout" };
    }
    if (isClarificationOption(pending, value)) {
      return { ok: true, value };
    }
  }
  return { ok: false, reason: "exhausted" };
}

function applyClarification(
  state: AgentState,
  request: PendingClarification,
  value: string,
  targetUnmappedEntity?: string,
): { state: AgentState; update: AgentUpdate } {
  const intent = { ...state.intent };
  if (request.field === "metric") {
    intent.metric = value;
    intent.requestedMetrics = [value];
  } else if (request.field === "timeRange") {
    intent.timeRange = value;
  } else if (request.field === "scope") {
    intent.filters = [...intent.filters, { field: "scope", operator: "=", value }];
  } else if (request.field === "table") {
    const remaining = targetUnmappedEntity
      ? intent.schemaEntities.filter((entity) => entity !== targetUnmappedEntity)
      : [...intent.schemaEntities];
    if (!remaining.some((entity) => entity.toLowerCase() === value.toLowerCase())) {
      remaining.push(value);
    }
    intent.schemaEntities = remaining;
  } else {
    intent.filters = [...intent.filters, { field: "filterValue", operator: "=", value }];
  }
  const suffix =
    request.field === "table" && targetUnmappedEntity
      ? `\nClarification (table for ${targetUnmappedEntity}): ${value}`
      : `\nClarification (${request.field}): ${value}`;
  const question = `${state.question}${suffix}`;
  const nextAttempts = clarificationAttemptsOf(state) + 1;
  const update: AgentUpdate = {
    intent,
    question,
    pendingClarification: null,
    clarificationAttempts: nextAttempts,
  };
  return {
    state: {
      ...state,
      intent,
      question,
      pendingClarification: null,
      clarificationAttempts: nextAttempts,
    },
    update,
  };
}

function clarificationForUnmappedTable(
  unresolved: Extract<ResolveCandidateTablesResult, { ok: false }>,
  options: string[],
  attempts: number,
) {
  const target = unresolved.unmappedEntities[0];
  const prefix =
    unresolved.partialTables.length > 0
      ? `Đã xác định bảng ${unresolved.partialTables.join(", ")}, `
      : "";
  const question = target
    ? `${prefix}chưa xác định được bảng dữ liệu cho "${target}". Bạn muốn truy vấn bảng nào cho phần này?`
    : `${prefix}chưa xác định được bảng dữ liệu phù hợp cho câu hỏi. Bạn muốn truy vấn bảng nào?`;
  return requestClarification({
    field: "table",
    question,
    options,
    attempts,
  });
}

type SafeTableClarificationSelection =
  | { ok: true; kind: "table"; table: string; attemptsUsed: number }
  | { ok: true; kind: "abort_rephrase"; attemptsUsed: number }
  | { ok: false; reason: "interrupt_unavailable" | "invalid_selection" | "timeout" };

function tryTableClarificationSelection(
  state: AgentState,
  request: PendingClarification,
  catalogTables: readonly CatalogTable[],
): SafeTableClarificationSelection {
  const allowedNames = catalogTables.map((t) => t.name);
  try {
    for (let attempt = clarificationAttemptsOf(state); attempt < 2; attempt += 1) {
      const pending = { ...request, attempts: attempt };
      const rawValue = pauseForClarification(pending);
      if (
        typeof rawValue === "object" &&
        rawValue !== null &&
        (rawValue as { action?: unknown }).action === "timeout"
      ) {
        return { ok: false, reason: "timeout" };
      }
      const verdict = classifyTableClarificationValue(pending, rawValue, allowedNames);
      if (verdict.kind === "abort_rephrase") {
        return { ok: true, kind: "abort_rephrase", attemptsUsed: attempt + 1 };
      }
      if (verdict.kind === "table") {
        return {
          ok: true,
          kind: "table",
          table: verdict.table,
          attemptsUsed: attempt + 1,
        };
      }
      if (typeof rawValue === "string") {
        const catalogHit = matchEntityInCatalog(rawValue, catalogTables);
        if (catalogHit) {
          return {
            ok: true,
            kind: "table",
            table: catalogHit.name,
            attemptsUsed: attempt + 1,
          };
        }
      }
    }
    return { ok: false, reason: "invalid_selection" };
  } catch (error) {
    if (isGraphInterrupt(error)) {
      throw error;
    }
    return { ok: false, reason: "interrupt_unavailable" };
  }
}

const MAX_ENTITY_FOLLOWUP_SEARCHES = 2;

function mergeStateChunks(
  existing: AgentState["semanticChunks"],
  incoming: AgentState["semanticChunks"],
): AgentState["semanticChunks"] {
  const byId = new Map<string, AgentState["semanticChunks"][number]>();
  for (const chunk of existing) {
    byId.set(chunk.chunkId, chunk);
  }
  for (const chunk of incoming) {
    const prev = byId.get(chunk.chunkId);
    if (!prev || (chunk.score ?? 0) > (prev.score ?? 0)) {
      byId.set(chunk.chunkId, chunk);
    }
  }
  return [...byId.values()];
}

type FollowUpSearchResult =
  | { ok: true; chunks: AgentState["semanticChunks"]; addedCount: number; calledTool: boolean }
  | {
      ok: false;
      budgetExceeded: true;
      tripReason: BudgetTripReason;
      calledTool: boolean;
      chunks: AgentState["semanticChunks"];
      answerText: string;
    }
  | {
      ok: false;
      budgetExceeded?: false;
      status: "restricted" | "error";
      errorCode: string;
      calledTool: boolean;
      answerText: string;
    };

async function searchForUnmappedEntities(
  deps: TextToSqlRuntimeDeps,
  transport: TracerRunConfig | null,
  question: string,
  unmappedEntities: readonly string[],
  existingChunks: AgentState["semanticChunks"],
  budget: BudgetState,
  rt: RootRuntime,
): Promise<FollowUpSearchResult> {
  if (!deps.semanticSearch && (deps.executor || !transport)) {
    return { ok: true, chunks: existingChunks, addedCount: 0, calledTool: false };
  }
  const seenQueries = new Set<string>([foldAscii(question)]);
  const queries: string[] = [];
  for (const entity of unmappedEntities) {
    const trimmed = entity.trim();
    const folded = foldAscii(trimmed);
    if (!trimmed || !folded || seenQueries.has(folded)) continue;
    seenQueries.add(folded);
    queries.push(trimmed);
    if (queries.length >= MAX_ENTITY_FOLLOWUP_SEARCHES) break;
  }
  if (queries.length === 0) {
    return { ok: true, chunks: existingChunks, addedCount: 0, calledTool: false };
  }

  let merged = [...existingChunks];
  let calledTool = false;
  let completedCalls = 0;
  for (const entityQuery of queries) {
    const budgetCheck = checkBudget(budget);
    if (budgetCheck.tripped) {
      rt.emit({
        node: "describe",
        type: "node_done",
        durationMs: 0,
        payload: {
          budgetExceeded: true,
          tripReason: budgetCheck.reason,
          caveat: "budget_exceeded",
          followUpCompleted: completedCalls,
        },
      });
      return {
        ok: false,
        budgetExceeded: true,
        tripReason: budgetCheck.reason,
        calledTool,
        chunks: merged,
        answerText: "",
      };
    }

    const started = Date.now();
    try {
      const raw = deps.semanticSearch
        ? await deps.semanticSearch(entityQuery, RETRIEVE_TOP_K)
        : await fetchSemanticChunks(transport!, entityQuery, RETRIEVE_TOP_K);
      calledTool = true;
      completedCalls += 1;
      rt.emit({
        node: "retrieve",
        type: "tool_call",
        durationMs: Date.now() - started,
        payload: {
          tool: "search_semantic_layer",
          ok: true,
          chunkCount: raw.length,
          phase: "entity_follow_up",
        },
      });
      merged = mergeStateChunks(merged, raw.map(toStateChunk));
    } catch (error) {
      const normalized = toNormalizedMcpError("search_semantic_layer", error);
      rt.emit({
        node: "retrieve",
        type: "tool_call",
        durationMs: Date.now() - started,
        payload: {
          tool: "search_semantic_layer",
          ok: false,
          code: normalized.code,
          phase: "entity_follow_up",
        },
      });
      return {
        ok: false,
        status:
          normalized.code === "SCOPE_DENIED" || normalized.code === "UNAUTHORIZED"
            ? "restricted"
            : "error",
        errorCode: normalized.code,
        calledTool,
        answerText: `Semantic lookup failed (${normalized.code}): ${normalized.message}`,
      };
    }
  }
  return {
    ok: true,
    chunks: merged,
    addedCount: merged.length - existingChunks.length,
    calledTool,
  };
}

function buildTooManyTablesMessage(
  unresolved: Extract<ResolveCandidateTablesResult, { ok: false }>,
): string {
  return (
    `Câu hỏi cần tới ${unresolved.requiredTables.length} bảng dữ liệu chính ` +
    `(${unresolved.requiredTables.join(", ")}), vượt giới hạn tối đa ${unresolved.maxTables} bảng cho một truy vấn. ` +
    `Vui lòng thu hẹp phạm vi hoặc tách thành các câu hỏi nhỏ hơn thay vì tự động bỏ bớt bảng.`
  );
}

function buildAskNewQuestionMessage(
  unresolved: Extract<ResolveCandidateTablesResult, { ok: false }>,
  catalogTables: readonly CatalogTable[],
  reason: "unavailable" | "exhausted" | "insufficient_options" | "user_rejected",
): string {
  const available =
    catalogTables.length > 0
      ? ` Available tables: ${catalogTables.map((t) => t.name).join(", ")}.`
      : "";
  const partial =
    unresolved.partialTables.length > 0
      ? ` Identified relevant table(s): ${unresolved.partialTables.join(", ")}.`
      : "";
  const missing =
    unresolved.unmappedEntities.length > 0
      ? ` Unresolved part(s): ${unresolved.unmappedEntities.join(", ")}.`
      : "";
  if (reason === "user_rejected") {
    return (
      `No suitable table matched your confirmation.${partial}${missing} ` +
      `Please ask a new question with more specific table names or metrics.${available}`
    );
  }
  if (reason === "exhausted") {
    return (
      `Clarification limit reached without resolving all required data tables.${partial}${missing} ` +
      `Please ask a new question with more specific table names or data details.${available}`
    );
  }
  if (reason === "insufficient_options") {
    return (
      `Could not find enough candidate table options to continue interactively.${partial}${missing} ` +
      `Please ask a new question with clearer table or data details.${available}`
    );
  }
  return (
    `Interactive resume is unavailable in this runtime context, so this run cannot continue safely.${partial}${missing} ` +
    `Please ask a new question specifying the exact table(s) to query.${available}`
  );
}

export function createTextToSqlRuntime(deps: TextToSqlRuntimeDeps = {}): {
  understand: (state: AgentState, rt: RootRuntime) => Promise<AgentUpdate>;
  entry: UcEntryHandler;
} {
  const understand = async (
    state: AgentState,
    rt: RootRuntime,
  ): Promise<AgentUpdate> => {
    const startCalls = state.budget?.llmCalls ?? 0;
    const startTokens = state.budget?.tokensUsed ?? 0;
    const budget: BudgetState = {
      llmCalls: startCalls,
      tokensUsed: state.budget?.tokensUsed ?? 0,
      maxLlmCalls: state.budget?.maxLlmCalls ?? BUDGET_LIMITS.maxLlmCalls,
      maxTokens: state.budget?.maxTokens ?? BUDGET_LIMITS.maxTokens,
      deadlineMs:
        state.budget?.deadlineMs && state.budget.deadlineMs > 0
          ? state.budget.deadlineMs
          : Date.now() + BUDGET_LIMITS.runDeadlineMs,
    };
    const preCheck = checkBudget(budget);
    if (preCheck.tripped) {
      return {
        status: "error",
        budgetExceeded: true,
        answerText: formatBudgetTripTemplate({
          reason: preCheck.reason,
          budget,
          remaining: ["Extract intent, resolve tables, generate SQL, and verify the query result"],
        }),
        budget: { deadlineMs: budget.deadlineMs },
      };
    }

    const skill = loadSkill("text-to-sql", { emit: rt.emit });
    const { identity, transport } = readRunContext(rt);
    const understandTools: string[] = [];

    const catalogLoad = await loadCatalogForRun(deps, rt, transport, "understand");
    if (!catalogLoad.ok) {
      return {
        catalogTables: [],
        catalogStatus: catalogLoad.catalogStatus,
        status: catalogLoad.status,
        answerText: catalogLoad.answerText,
        budget: { deadlineMs: budget.deadlineMs },
      };
    }
    const catalogTables = catalogLoad.tables;
    const catalogStatus: AgentState["catalogStatus"] = catalogLoad.calledTool
      ? "ready"
      : state.catalogStatus;
    if (catalogLoad.calledTool && !deps.listTables) {
      understandTools.push("list_tables");
    } else if (catalogLoad.calledTool) {
      understandTools.push("list_tables");
    }

    let preStateChunks: AgentState["semanticChunks"] = [];
    let semanticQuery: string | null = null;
    let semanticRetrieveStatus: AgentState["semanticRetrieveStatus"] = "unloaded";
    let semanticErrorCode: string | null = null;

    if (deps.semanticSearch || (!deps.executor && transport)) {
      const searchStarted = Date.now();
      try {
        const rawChunks = deps.semanticSearch
          ? await deps.semanticSearch(state.question, RETRIEVE_TOP_K)
          : await fetchSemanticChunks(transport!, state.question, RETRIEVE_TOP_K);
        rt.emit({
          node: "retrieve",
          type: "tool_call",
          durationMs: Date.now() - searchStarted,
          payload: {
            tool: "search_semantic_layer",
            ok: true,
            chunkCount: rawChunks.length,
            phase: "pre_understand",
          },
        });
        understandTools.push("search_semantic_layer");
        preStateChunks = rawChunks.map(toStateChunk);
        semanticQuery = state.question;
        semanticRetrieveStatus = "ok";
      } catch (error) {
        const normalized = toNormalizedMcpError("search_semantic_layer", error);
        rt.emit({
          node: "retrieve",
          type: "tool_call",
          durationMs: Date.now() - searchStarted,
          payload: {
            tool: "search_semantic_layer",
            ok: false,
            code: normalized.code,
            phase: "pre_understand",
          },
        });
        semanticRetrieveStatus = "error";
        semanticErrorCode = normalized.code;
      }
    }

    const prompt = buildIntentPrompt({
      question: state.question,
      skillContract: skill.contract,
      catalogTables,
      semanticChunks: preStateChunks,
    });
    const intentStarted = Date.now();
    let out;
    try {
      const invokeOpts = {
        name: "intent_proposal",
        callbacks: rt.config.callbacks,
        node: "understand",
        budget,
        deadlineMs: budget.deadlineMs,
        emit: rt.emit,
      };
      out = deps.intentModel && !deps.intentJsonModel
        ? await invokeWithUsage(deps.intentModel, IntentProposalSchema, prompt, invokeOpts)
        : await invokeJsonWithUsage(
            deps.intentJsonModel ?? createChatModel("intent", {
              semanticCacheContext: createSemanticCacheContext({
                analysisState: {
                  question: state.question,
                  intent: state.intent,
                  catalogTables,
                },
                semanticChunks: preStateChunks,
                role: identity?.roleScope,
                rowScope: identity?.rowScope,
              }),
            }),
            IntentProposalSchema,
            prompt,
            invokeOpts,
          );
    } catch (error) {
      const budgetCheck = checkBudget(budget);
      const tripReason =
        budgetTripReasonFromError(error) ??
        (budgetCheck.tripped ? budgetCheck.reason : undefined);
      if (tripReason) {
        const answerText = formatBudgetTripTemplate({
          reason: tripReason,
          budget,
          completed: [
            ...(catalogTables.length > 0 ? [`Loaded ${catalogTables.length} catalog tables`] : []),
            ...(preStateChunks.length > 0 ? [`Retrieved ${preStateChunks.length} semantic entries`] : []),
          ],
          remaining: ["Finish intent extraction, SQL execution, and result verification"],
        });
        rt.emit({
          node: "understand",
          type: "node_done",
          durationMs: Date.now() - intentStarted,
          payload: { budgetExceeded: true, tripReason, caveat: "budget_exceeded" },
        });
        return {
          status: "error",
          budgetExceeded: true,
          answerText,
          budget: {
            llmCalls: budget.llmCalls - startCalls,
            tokensUsed: budget.tokensUsed - startTokens,
            deadlineMs: budget.deadlineMs,
          },
        };
      }
      if (isRateLimitFailure(error)) {
        const toolErr = toModelDbToolError(error, "Intent extraction failed");
        return {
          status: "error",
          answerText: toolErr.message,
          budget: {
            llmCalls: budget.llmCalls - startCalls,
            tokensUsed: budget.tokensUsed - startTokens,
            deadlineMs: budget.deadlineMs,
          },
        };
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return {
          status: "error",
          answerText: "The model returned an invalid intent response; please try again.",
          budget: {
            llmCalls: budget.llmCalls - startCalls,
            tokensUsed: budget.tokensUsed - startTokens,
            deadlineMs: budget.deadlineMs,
          },
        };
      }
      throw error;
    }
    const intent = out.parsed;
    const successfulUsage = unaccountedUsage(out);
    const intentDurationMs = Date.now() - intentStarted;
    const realTokens = successfulUsage.inputTokens + successfulUsage.outputTokens;
    const { estimatedCostUsd, pricingKnown } = estimateCostUsd(
      out.model,
      successfulUsage.inputTokens,
      successfulUsage.outputTokens,
    );
    rt.emit({
      node: "understand",
      type: "llm_call",
      durationMs: intentDurationMs,
      payload: {
        model: out.model ?? "unknown",
        inputTokens: successfulUsage.inputTokens,
        outputTokens: successfulUsage.outputTokens,
        estimatedCostUsd,
        pricingKnown,
      },
    });
    const failedCalls = budget.llmCalls - startCalls;
    return {
      ...(state.status === "error" ? { status: "no_data" as const, answerText: "" } : {}),
      budgetExceeded: false,
      intent,
      ...(catalogStatus === "ready" ? { catalogTables, catalogStatus } : {}),
      ...(semanticRetrieveStatus === "ok"
        ? {
            semanticChunks: preStateChunks,
            semanticQuery,
            semanticRetrieveStatus,
            semanticErrorCode: null,
          }
        : semanticRetrieveStatus === "error"
          ? {
              semanticRetrieveStatus,
              semanticErrorCode,
            }
          : {}),
      ...(understandTools.length > 0
        ? { toolsCalled: dedupeTools([...state.toolsCalled, ...understandTools]) }
        : {}),
      budget: {
        llmCalls: failedCalls + 1,
        tokensUsed:
          budget.tokensUsed - startTokens +
          (realTokens > 0
            ? realTokens
            : estimateTokens(prompt, JSON.stringify(intent))),
      },
    };
  };

  const catalogIds = deps.catalogIds ?? loadSemanticCatalogIds();
  const entry: UcEntryHandler = async (
    state: AgentState,
    rt: RootRuntime,
  ): Promise<AgentUpdate> => {
    if (
      state.status === "error" ||
      state.status === "restricted" ||
      state.status === "cannot_answer"
    ) {
      return {};
    }
    let activeState = state;
    if (activeState.status === "cannot_answer" || activeState.status === "error") {
      return {};
    }
    let clarificationUpdate: AgentUpdate = {};
    const definition = handleDefinitionLookup(activeState, catalogIds);
    if (definition) return definition;
    const unknownTerm = handleUnknownTerm(activeState, catalogIds);
    if (unknownTerm) return unknownTerm;
    const ambiguousMetric = clarificationForAmbiguousMetric(activeState);
    if (ambiguousMetric === "exhausted") {
      return {
        status: "needs_clarification",
        pendingClarification: null,
        answerText: "The requested KPI could not be disambiguated after two responses.",
      };
    }
    if (ambiguousMetric) {
      const selected = clarificationSelection(activeState, ambiguousMetric);
      if (!selected.ok) {
        if (selected.reason === "timeout") {
          return {
            status: "error",
            errorCode: "HITL_APPROVAL_TIMEOUT",
            pendingClarification: null,
            answerText: "Clarification request timed out (HITL_APPROVAL_TIMEOUT).",
          };
        }
        return {
          status: "needs_clarification",
          pendingClarification: null,
          answerText: "The requested KPI could not be disambiguated after two responses.",
        };
      }
      const applied = applyClarification(activeState, ambiguousMetric, selected.value);
      activeState = applied.state;
      clarificationUpdate = applied.update;
    }
    if (isTimeoutResumeInScratchpad(rt)) {
      return {
        ...clarificationUpdate,
        status: "error",
        errorCode: "HITL_APPROVAL_TIMEOUT",
        pendingClarification: null,
        answerText: "Clarification request timed out (HITL_APPROVAL_TIMEOUT).",
      };
    }
    const { identity, transport } = readRunContext(rt);
    if (!deps.executor && !transport) {
      return {
        status: "error",
        answerText: "text-to-SQL MCP transport identity is incomplete.",
      };
    }
    if (!identity) {
      return {
        status: "error",
        answerText: "text-to-SQL run identity is incomplete.",
      };
    }
    let effectiveCatalogTables = activeState.catalogTables;
    let effectiveCatalogStatus = activeState.catalogStatus;
    const entryPreTools: string[] = [];
    if (
      effectiveCatalogStatus === "unloaded" &&
      (deps.listTables || (!deps.executor && transport))
    ) {
      const catalogLoad = await loadCatalogForRun(deps, rt, transport, "describe");
      if (!catalogLoad.ok) {
        return {
          ...clarificationUpdate,
          catalogTables: [],
          catalogStatus: catalogLoad.catalogStatus,
          status: catalogLoad.status,
          answerText: catalogLoad.answerText,
        };
      }
      if (catalogLoad.calledTool) {
        effectiveCatalogTables = catalogLoad.tables;
        effectiveCatalogStatus = "ready";
        entryPreTools.push("list_tables");
      }
    }
    const budget: BudgetState = {
      llmCalls: activeState.budget.llmCalls,
      tokensUsed: activeState.budget.tokensUsed,
      deadlineMs:
        activeState.budget.deadlineMs > 0
          ? activeState.budget.deadlineMs
          : Date.now() + BUDGET_LIMITS.runDeadlineMs,
      maxLlmCalls: activeState.budget.maxLlmCalls,
      maxTokens: activeState.budget.maxTokens,
    };

    const resolveCurrent = (
      targetState: AgentState,
      chunks: AgentState["semanticChunks"],
    ) =>
      resolveCandidateTables({
        question: targetState.question,
        schemaEntities: targetState.intent.schemaEntities,
        requestedMetrics: targetState.intent.requestedMetrics,
        filterValues: targetState.intent.filters.map((f) => String(f.value ?? "")),
        catalogTables: effectiveCatalogTables,
        catalogLoaded: effectiveCatalogStatus === "ready",
        semanticChunks: chunks,
        ...(effectiveCatalogStatus === "ready" ? { joinEdges: loadSemanticJoinEdges() } : {}),
      });

    const catalogUpdate =
      effectiveCatalogStatus === "ready" && activeState.catalogStatus === "unloaded"
        ? {
            catalogTables: effectiveCatalogTables,
            catalogStatus: effectiveCatalogStatus,
          }
        : {};

    let workingChunks = activeState.semanticChunks;
    let resolved = resolveCurrent(activeState, workingChunks);
    if (!resolved.ok) {
      if (activeState.semanticRetrieveStatus === "error") {
        const code = activeState.semanticErrorCode ?? "INTERNAL_ERROR";
        return {
          ...clarificationUpdate,
          status:
            code === "SCOPE_DENIED" || code === "UNAUTHORIZED"
              ? "restricted"
              : "error",
          answerText: `Semantic retrieval failed (${code}); cannot determine candidate tables safely.`,
        };
      }
      if (resolved.reason !== "too_many_required_tables" && resolved.unmappedEntities.length > 0) {
        const followUp = await searchForUnmappedEntities(
          deps,
          transport,
          activeState.question,
          resolved.unmappedEntities,
          workingChunks,
          budget,
          rt,
        );
        if (followUp.calledTool) {
          entryPreTools.push("search_semantic_layer");
        }
        if (!followUp.ok) {
          if (followUp.budgetExceeded) {
            return {
              ...clarificationUpdate,
              ...catalogUpdate,
              ...(followUp.chunks !== state.semanticChunks
                ? { semanticChunks: followUp.chunks }
                : {}),
              status: "error",
              budgetExceeded: true,
              pendingClarification: null,
              toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
              answerText: formatBudgetTripTemplate({
                reason: followUp.tripReason,
                budget,
                completed: [
                  ...resolved.partialTables.map((table) => `Resolved table ${table}`),
                  ...(workingChunks.length > 0 ? [`Retrieved ${workingChunks.length} semantic entries`] : []),
                ],
                remaining: ["Resolve the remaining entities, generate SQL, and verify query results"],
              }),
              budget: {
                llmCalls: budget.llmCalls - state.budget.llmCalls,
                tokensUsed: budget.tokensUsed - state.budget.tokensUsed,
                deadlineMs: budget.deadlineMs,
              },
            };
          }
          return {
            ...clarificationUpdate,
            ...catalogUpdate,
            status: followUp.status,
            semanticRetrieveStatus: "error",
            semanticErrorCode: followUp.errorCode,
            toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
            answerText: followUp.answerText,
          };
        }
        if (followUp.addedCount > 0 || followUp.chunks !== workingChunks) {
          workingChunks = followUp.chunks;
          activeState = { ...activeState, semanticChunks: workingChunks };
          resolved = resolveCurrent(activeState, workingChunks);
        }
      }
    }

    while (!resolved.ok) {
      const semanticUpdate =
        workingChunks !== state.semanticChunks
          ? { semanticChunks: workingChunks }
          : {};
      const coverage = entityCoverage(resolved.entities);
      const clearlyUnsupported = resolved.unmappedEntities.some((entity) =>
        /\b(nps|ton kho|nha cung cap|weather|stock market)\b/.test(foldAscii(entity)),
      );
      if (resolved.unmappedEntities.length > 0 &&
        ((coverage.totalEntities > 0 && coverage.matchedCount === 0 && resolved.partialTables.length === 0) || clearlyUnsupported)) {
        rt.emit({
          node: "describe",
          type: "node_done",
          durationMs: 0,
          payload: { resolution: "out_of_domain", coverage, entities: resolved.entities },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "cannot_answer",
          sql: null,
          pendingClarification: null,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: `Không có bảng hoặc chỉ số phù hợp cho: ${resolved.unmappedEntities.join(", ")}. ` +
            `Các bảng hiện có: ${effectiveCatalogTables.slice(0, 8).map((table) => table.name).join(", ")}.`,
        };
      }
      if (resolved.reason === "too_many_required_tables") {
        rt.emit({
          node: "describe",
          type: "node_done",
          durationMs: 0,
          payload: {
            clarificationReason: resolved.reason,
            requiredTables: resolved.requiredTables,
            maxTables: resolved.maxTables,
            entities: resolved.entities,
          },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "needs_clarification",
          pendingClarification: null,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: buildTooManyTablesMessage(resolved),
        };
      }

      if (resolved.reason === "disconnected_required_tables") {
        rt.emit({
          node: "describe", type: "node_done", durationMs: 0,
          payload: { clarificationReason: resolved.reason, requiredTables: resolved.requiredTables },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "needs_clarification",
          sql: null,
          pendingClarification: null,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: `Không tìm thấy đường nối dữ liệu được xác thực giữa các bảng ${resolved.requiredTables.join(", ")}. ` +
            "Vui lòng thu hẹp câu hỏi hoặc chỉ rõ mối liên hệ cần dùng.",
        };
      }

      if (clarificationAttemptsOf(activeState) >= 2) {
        rt.emit({
          node: "describe",
          type: "node_done",
          durationMs: 0,
          payload: {
            clarificationReason: "clarification_exhausted",
            partialTables: resolved.partialTables,
            unmappedEntities: resolved.unmappedEntities,
          },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "needs_clarification",
          pendingClarification: null,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: buildAskNewQuestionMessage(
            resolved,
            effectiveCatalogTables,
            "exhausted",
          ),
        };
      }

      const tableOptions = suggestClarificationTables({
        catalogTables: effectiveCatalogTables,
        semanticChunks: workingChunks,
        excludeTables: resolved.partialTables,
        hints: [...resolved.unmappedEntities, activeState.question],
      });
      if (tableOptions.length < 2) {
        rt.emit({
          node: "describe",
          type: "node_done",
          durationMs: 0,
          payload: {
            clarificationReason: "insufficient_options",
            partialTables: resolved.partialTables,
            unmappedEntities: resolved.unmappedEntities,
          },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "needs_clarification",
          pendingClarification: null,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: buildAskNewQuestionMessage(
            resolved,
            effectiveCatalogTables,
            "insufficient_options",
          ),
        };
      }

      const clarification = clarificationForUnmappedTable(
        resolved,
        tableOptions,
        clarificationAttemptsOf(activeState),
      );
      const selection = tryTableClarificationSelection(
        activeState,
        clarification.pendingClarification,
        effectiveCatalogTables,
      );
      if (!selection.ok) {
        if (selection.reason === "timeout") {
          rt.emit({
            node: "describe",
            type: "node_done",
            durationMs: 0,
            payload: {
              clarificationReason: "timeout",
              partialTables: resolved.partialTables,
              unmappedEntities: resolved.unmappedEntities,
              entities: resolved.entities,
            },
          });
          return {
            ...clarificationUpdate,
            ...catalogUpdate,
            ...semanticUpdate,
            status: "error",
            errorCode: "HITL_APPROVAL_TIMEOUT",
            pendingClarification: null,
            toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
            answerText: "Clarification request timed out (HITL_APPROVAL_TIMEOUT).",
          };
        }
        rt.emit({
          node: "describe",
          type: "node_done",
          durationMs: 0,
          payload: {
            clarificationReason: selection.reason,
            partialTables: resolved.partialTables,
            unmappedEntities: resolved.unmappedEntities,
            entities: resolved.entities,
          },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "needs_clarification",
          pendingClarification:
            selection.reason === "interrupt_unavailable"
              ? clarification.pendingClarification
              : null,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: buildAskNewQuestionMessage(
            resolved,
            effectiveCatalogTables,
            selection.reason === "interrupt_unavailable"
              ? "unavailable"
              : "exhausted",
          ),
        };
      }

      if (selection.kind === "abort_rephrase") {
        rt.emit({
          node: "describe",
          type: "node_done",
          durationMs: 0,
          payload: {
            clarificationReason: "user_rejected_tables",
            partialTables: resolved.partialTables,
            unmappedEntities: resolved.unmappedEntities,
          },
        });
        return {
          ...clarificationUpdate,
          ...catalogUpdate,
          ...semanticUpdate,
          status: "needs_clarification",
          pendingClarification: null,
          clarificationAttempts: selection.attemptsUsed,
          toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
          answerText: buildAskNewQuestionMessage(
            resolved,
            effectiveCatalogTables,
            "user_rejected",
          ),
        };
      }

      const applied = applyClarification(
        activeState,
        clarification.pendingClarification,
        selection.table,
        resolved.unmappedEntities[0],
      );
      applied.state.clarificationAttempts = selection.attemptsUsed;
      applied.update.clarificationAttempts = selection.attemptsUsed;
      activeState = applied.state;
      clarificationUpdate = { ...clarificationUpdate, ...applied.update };
      resolved = resolveCurrent(activeState, workingChunks);
    }

    const candidateTables = resolved.tables;
    rt.emit({
      node: "describe",
      type: "node_done",
      durationMs: 0,
      payload: {
        candidateTables,
        candidateCount: candidateTables.length,
        sources: resolved.sources,
        entities: resolved.entities,
      },
    });
    const references = selectSqlReferences(workingChunks, candidateTables, {
      question: activeState.question,
      requestedMetrics: activeState.intent.requestedMetrics,
    });
    const collectedTools: string[] = [];
    const seenTools = new Set<string>();
    const executor =
      deps.executor ??
      new ValidatedQueryExecutor({
        model: deps.sqlModel ?? (createChatModel("sql", {
          semanticCacheContext: createSemanticCacheContext({
            analysisState: {
              question: activeState.question,
              intent: activeState.intent,
              candidateTables,
              tablesUsed: activeState.tablesUsed,
            },
            semanticChunks: workingChunks,
            role: identity?.roleScope,
            rowScope: identity?.rowScope,
          }),
        }) as unknown as ChatModelLike),
        mcp: createRuntimeMcpCaller(transport!),
        emitSpan: (event) => {
          const payload = (event as { payload?: unknown }).payload;
          if (
            payload !== null &&
            typeof payload === "object" &&
            "tool" in payload &&
            typeof (payload as { tool: unknown }).tool === "string"
          ) {
            const tool = (payload as { tool: string }).tool;
            if (KNOWN_TOOL_NAMES.has(tool) && !seenTools.has(tool)) {
              seenTools.add(tool);
              collectedTools.push(tool);
            }
          }
          return rt.emit({
            node: event.node,
            type: event.type,
            durationMs: event.durationMs ?? 0,
            payload: event.payload,
            attempt: event.attempt,
          });
        },
      });
    let result = await executor.run({
      question: activeState.question,
      timeRange: activeState.intent.timeRange,
      candidateTables,
      catalogTables: effectiveCatalogTables,
      references,
      principal: identity,
      budget,
      callbacks: rt.config.callbacks,
    });
    if (result.status === "needs_clarification") {
      if (activeState.intent.timeRange !== null || activeState.clarificationAttempts >= 2) {
        return {
          ...clarificationUpdate,
          ...updateFromExecutor(result, state, catalogIds),
          pendingClarification: null,
          answerText: "The query still needs clarification after two responses.",
        };
      }
      const options = await executor.timeRangeOptions?.({ principal: identity, budget });
      if (!options || options.length < 2 || options.length > 4) {
        return {
          ...clarificationUpdate,
          ...updateFromExecutor(result, state, catalogIds),
          pendingClarification: null,
          answerText: "A valid time range could not be derived from the available data.",
        };
      }
      const clarification = clarificationForLargeQuery(
        result.table,
        options,
        activeState.clarificationAttempts,
      );
      const selected = clarificationSelection(activeState, clarification.pendingClarification);
      if (!selected.ok) {
        if (selected.reason === "timeout") {
          return {
            ...clarificationUpdate,
            ...catalogUpdate,
            ...(workingChunks !== state.semanticChunks
              ? { semanticChunks: workingChunks }
              : {}),
            status: "error",
            errorCode: "HITL_APPROVAL_TIMEOUT",
            pendingClarification: null,
            answerText: "Clarification request timed out (HITL_APPROVAL_TIMEOUT).",
          };
        }
        return {
          status: "needs_clarification",
          pendingClarification: null,
          answerText: "The time range could not be resolved after two responses.",
        };
      }
      const applied = applyClarification(activeState, clarification.pendingClarification, selected.value);
      activeState = applied.state;
      clarificationUpdate = { ...clarificationUpdate, ...applied.update };
      result = await executor.run({
        question: activeState.question,
        timeRange: activeState.intent.timeRange,
        candidateTables,
        catalogTables: effectiveCatalogTables,
        references,
        principal: identity,
        budget,
        callbacks: rt.config.callbacks,
      });
    }
    const update = updateFromExecutor(result, activeState, catalogIds);
    const isOkLike = result.status === "ok" || result.status === "no_data";
    const observedTools =
      collectedTools.length > 0
        ? collectedTools
        : result.status === "ok"
          ? ["describe_table", "run_query"]
          : [];
    return {
      ...clarificationUpdate,
      ...update,
      ...(workingChunks !== state.semanticChunks
        ? { semanticChunks: workingChunks }
        : {}),
      ...(effectiveCatalogStatus === "ready" &&
      activeState.catalogStatus === "unloaded"
        ? {
            catalogTables: effectiveCatalogTables,
            catalogStatus: effectiveCatalogStatus,
          }
        : {}),
      ...(isOkLike
        ? {
            toolsCalled: dedupeTools([
              ...activeState.toolsCalled,
              ...entryPreTools,
              ...observedTools,
            ]),
          }
        : {}),
      budget: {
        llmCalls: budget.llmCalls - state.budget.llmCalls,
        tokensUsed: budget.tokensUsed - state.budget.tokensUsed,
        deadlineMs: budget.deadlineMs,
      },
    };
  };

  return { understand, entry };
}

