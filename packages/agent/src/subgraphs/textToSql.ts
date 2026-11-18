import {
  dbToolError,
  ListTablesOutputSchema,
} from "@shared/contracts";
import { z } from "zod";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { createChatModel } from "../models/factory.js";
import {
  estimateCostUsd,
  invokeWithUsage,
} from "../telemetry/usage.js";
import {
  isRateLimitFailure,
  toModelDbToolError,
} from "../telemetry/retry.js";
import { checkBudget, createBudgetState, estimateTokens, type BudgetState } from "../queryExecutor/budgets.js";
import {
  ValidatedQueryExecutor,
  type ChatModelLike,
  type ExecutorResult,
  type ExecutorRunInput,
  type McpToolCaller,
} from "../queryExecutor/executor.js";
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
import { registerUC } from "./registry.js";
import { BUDGET_LIMITS, TEXT_TO_SQL_UC_ID } from "../constants.js";

export { TEXT_TO_SQL_UC_ID } from "../constants.js";

/** The intent profile returns only the serializable state intent shape. */
export const IntentProposalSchema = IntentSchema;
export type IntentProposal = z.infer<typeof IntentProposalSchema>;

/** Narrow model seam so unit tests never need an API key. */
export interface IntentModelLike {
  withStructuredOutput(
    schema: typeof IntentProposalSchema,
    opts?: { name?: string; includeRaw?: boolean },
  ): {
    invoke(input: string, config?: { callbacks?: Callbacks }): Promise<IntentProposal>;
  };
}

/** Narrow executor seam; text-to-SQL never opens a database connection directly. */
export interface TextToSqlExecutorLike {
  run(input: ExecutorRunInput): Promise<ExecutorResult>;
  timeRangeOptions?(input: {
    principal: ExecutorRunInput["principal"];
    budget: BudgetState;
  }): Promise<string[]>;
}

export interface TextToSqlRuntimeDeps {
  intentModel?: IntentModelLike;
  /** SQL model seam; omitted in production to use the configured profile. */
  sqlModel?: ChatModelLike;
  executor?: TextToSqlExecutorLike;
  /** Optional catalog table discovery override for tests; production calls MCP list_tables. */
  listTables?: (rt: RootRuntime) => Promise<CatalogTable[]>;
  /** Optional semantic search override for pre-intent retrieval in tests. */
  semanticSearch?: SemanticSearchFn;
}

/** Root-entry guard: initialize one persistent deadline and stop before I/O. */
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
      status: "cannot_answer",
      answerText: `Run budget exceeded (${check.reason}); no model or query was called.`,
      budget: { deadlineMs: budget.deadlineMs },
    };
  }
  return { budget: { deadlineMs: budget.deadlineMs } };
}

function readRunContext(rt: RootRuntime): {
  identity: { runId: string; userId: string; roleScope: string } | null;
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
  const identity = runId && userId && roleScope ? { runId, userId, roleScope } : null;
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
    sql: result.sql,
    tablesUsed: result.tablesUsed,
    columns: result.columns,
    resultPreview: result.rows.slice(0, 50),
  }),
  no_data: (result) => ({
    status: "no_data",
    sql: result.sql,
    tablesUsed: result.tablesUsed,
    columns: result.columns,
    resultPreview: [],
    answerText: result.diagnostic ?? "No matching data was found.",
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
  error: (result) => ({
    status: "error",
    sql: result.sql,
    answerText: result.error.message,
  }),
  cannot_answer: (result) => ({
    status: "cannot_answer",
    sql: result.sql,
    answerText: result.reason,
  }),
};

function updateFromExecutor(result: ExecutorResult, state: AgentState): AgentUpdate {
  const handler = EXECUTOR_UPDATE_MAP[result.status] as (
    r: ExecutorResult,
  ) => AgentUpdate;
  const update = handler(result);
  if ((result.status === "ok" || result.status === "no_data") && typeof update.sql === "string") {
    const headed = withCitationHeader(state, update.sql);
    if (headed === null) {
      // Persistent K7 failure (e.g. citation_missing_metric): fail closed
      // rather than shipping an unverified header.
      return {
        status: "cannot_answer",
        sql: result.sql,
        answerText:
          "Citation check failed (metric queries must cite at least one retrieved metric:* chunk); cannot answer without verified citations.",
      };
    }
    return { ...update, sql: headed };
  }
  return update;
}

/** Definition fast-path (RT->SYN): answer from retrieved semantic chunks, no executor/models/MCP. */
function handleDefinitionLookup(state: AgentState): AgentUpdate | null {
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
  const lines = chunks.slice(0, 5).map((chunk) => {
    const snippet = (chunk.text ?? "").slice(0, 300);
    if (snippet && chunk.score !== undefined) return `${chunk.chunkId} (score: ${chunk.score}): ${snippet}`;
    if (snippet) return `${chunk.chunkId}: ${snippet}`;
    if (chunk.score !== undefined) return `${chunk.chunkId} (score: ${chunk.score})`;
    return `${chunk.chunkId}`;
  });
  const citations = chunks
    .filter((chunk) => chunk.chunkId.startsWith("metric:"))
    .map((chunk) => chunk.chunkId)
    .slice(0, 5);
  const citationLine =
    citations.length > 0 ? `\nCitations: ${citations.join(", ")}.` : "";
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

/** Unknown-term short-circuit (two-tier gate): fail before any MCP when retrieval ran but grounds nothing. */
function handleUnknownTerm(state: AgentState): AgentUpdate | null {
  const metrics = state.intent.requestedMetrics;
  const chunks = state.semanticChunks;
  if (metrics.length === 0) return null;
  // Fail closed: metrics present but no retrieved chunks means nothing is
  // grounded — never let the executor run ungrounded.
  if (chunks.length === 0) return buildCannotAnswer(metrics, []);
  const { ungrounded } = checkUnknownTerms(metrics, chunks);
  if (ungrounded.length === 0) return null;
  return buildCannotAnswer(ungrounded, chunks);
}

/**
 * K7 citation header (UC-02): derive citations from the retrieved turn
 * context and prepend `-- @citations: ...` to executor SQL. Never changes
 * status on success — the unknown-term gate owns cannot_answer; this seam
 * only guarantees dual (JSON + SQL header) citation formatting. Returns
 * null on persistent K7 failure so the caller can fail closed to
 * cannot_answer instead of shipping an unverified header.
 *
 * No fake catalog: the runtime turn has only retrieved IDs, so catalog
 * membership is enforced in eval/grader (full catalog) and validator unit
 * tests — here we enforce retrieved-this-turn + metric:* coverage, with a
 * <= 2 repair loop before failing.
 */
function withCitationHeader(state: AgentState, sql: string | null): string | null {
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
  };
  const checked = validateCitations(input);
  if (checked.ok) return checked.sql;
  const repaired = repairCitations(input, 2);
  if (repaired.ok) return repaired.sql;
  // Persistent failure (e.g. citation_missing_metric for column-only
  // retrieval on a metric query): signal the caller to fail closed.
  return null;
}

/** MCP tool names the executor reports via span payloads. */
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

/** Ask only when intent extraction has identified multiple candidate KPIs. */
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

function clarificationSelection(
  state: AgentState,
  request: PendingClarification,
): string | undefined {
  for (let attempt = clarificationAttemptsOf(state); attempt < 2; attempt += 1) {
    const pending = { ...request, attempts: attempt };
    const value = pauseForClarification(pending);
    if (isClarificationOption(pending, value)) return value;
  }
  return undefined;
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
  | { ok: false; reason: "interrupt_unavailable" | "invalid_selection" };

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
      tripReason: string;
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
    // Check budget/deadline before every follow-up semantic MCP call (#89).
    const budgetCheck = checkBudget(budget);
    if (budgetCheck.tripped) {
      rt.emit({
        node: "describe",
        type: "node_done",
        durationMs: 0,
        payload: {
          budgetExceeded: true,
          tripReason: budgetCheck.reason,
          followUpCompleted: completedCalls,
        },
      });
      return {
        ok: false,
        budgetExceeded: true,
        tripReason: budgetCheck.reason,
        calledTool,
        chunks: merged,
        answerText: `Run budget exceeded (${budgetCheck.reason}) before semantic follow-up search; stopped without issuing more MCP calls.`,
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

/**
 * Builds the text-to-SQL understanding node and entry handler. The root graph owns
 * dispatch; this module owns model, skill, and executor wiring for the UC.
 */
export function createTextToSqlRuntime(deps: TextToSqlRuntimeDeps = {}): {
  understand: (state: AgentState, rt: RootRuntime) => Promise<AgentUpdate>;
  entry: UcEntryHandler;
} {
  const understand = async (
    state: AgentState,
    rt: RootRuntime,
  ): Promise<AgentUpdate> => {
    const startCalls = state.budget?.llmCalls ?? 0;
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
        status: "cannot_answer",
        answerText: `Run budget exceeded (${preCheck.reason}); no model or query was called.`,
        budget: { deadlineMs: budget.deadlineMs },
      };
    }

    const skill = loadSkill("text-to-sql", { emit: rt.emit });
    const { transport } = readRunContext(rt);
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
      out = deps.intentModel
        ? await invokeWithUsage(deps.intentModel, IntentProposalSchema, prompt, invokeOpts)
        : await invokeWithUsage(
            createChatModel("intent"),
            IntentProposalSchema,
            prompt,
            invokeOpts,
          );
    } catch (error) {
      if (isRateLimitFailure(error)) {
        const toolErr = toModelDbToolError(error, "Intent extraction failed");
        return {
          status: "error",
          answerText: toolErr.message,
          budget: {
            llmCalls: budget.llmCalls - startCalls,
            tokensUsed: 0,
            deadlineMs: budget.deadlineMs,
          },
        };
      }
      if (error instanceof Error && /^Run budget exceeded/i.test(error.message)) {
        return {
          status: "cannot_answer",
          answerText: `${error.message}; no model or query was called.`,
          budget: {
            llmCalls: budget.llmCalls - startCalls,
            tokensUsed: 0,
            deadlineMs: budget.deadlineMs,
          },
        };
      }
      throw error;
    }
    const intent = out.parsed;
    const intentDurationMs = Date.now() - intentStarted;
    // Real provider counts feed the budget when present; fakes fall back to
    // the conservative local estimate.
    const realTokens = out.inputTokens + out.outputTokens;
    const { estimatedCostUsd, pricingKnown } = estimateCostUsd(
      out.model,
      out.inputTokens,
      out.outputTokens,
    );
    rt.emit({
      node: "understand",
      type: "llm_call",
      durationMs: intentDurationMs,
      payload: {
        model: out.model ?? "unknown",
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        estimatedCostUsd,
        pricingKnown,
      },
    });
    const failedCalls = budget.llmCalls - startCalls;
    return {
      ...(state.status === "error" ? { status: "no_data" as const, answerText: "" } : {}),
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
          realTokens > 0
            ? realTokens
            : estimateTokens(prompt, JSON.stringify(intent)),
      },
    };
  };

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
    let clarificationUpdate: AgentUpdate = {};
    const definition = handleDefinitionLookup(activeState);
    if (definition) return definition;
    const unknownTerm = handleUnknownTerm(activeState);
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
      if (!selected) {
        return {
          status: "needs_clarification",
          pendingClarification: null,
          answerText: "The requested KPI could not be disambiguated after two responses.",
        };
      }
      const applied = applyClarification(activeState, ambiguousMetric, selected);
      activeState = applied.state;
      clarificationUpdate = applied.update;
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
              status: "cannot_answer",
              pendingClarification: null,
              toolsCalled: dedupeTools([...activeState.toolsCalled, ...entryPreTools]),
              answerText: followUp.answerText,
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
        model: deps.sqlModel ?? (createChatModel("sql") as unknown as ChatModelLike),
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
      references,
      principal: identity,
      budget,
      callbacks: rt.config.callbacks,
    });
    if (result.status === "needs_clarification") {
      if (activeState.intent.timeRange !== null || activeState.clarificationAttempts >= 2) {
        return {
          ...clarificationUpdate,
          ...updateFromExecutor(result, state),
          pendingClarification: null,
          answerText: "The query still needs clarification after two responses.",
        };
      }
      const options = await executor.timeRangeOptions?.({ principal: identity, budget });
      if (!options || options.length < 2 || options.length > 4) {
        return {
          ...clarificationUpdate,
          ...updateFromExecutor(result, state),
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
      if (!selected) {
        return {
          status: "needs_clarification",
          pendingClarification: null,
          answerText: "The time range could not be resolved after two responses.",
        };
      }
      const applied = applyClarification(activeState, clarification.pendingClarification, selected);
      activeState = applied.state;
      clarificationUpdate = { ...clarificationUpdate, ...applied.update };
      result = await executor.run({
        question: activeState.question,
        timeRange: activeState.intent.timeRange,
        candidateTables,
        references,
        principal: identity,
        budget,
        callbacks: rt.config.callbacks,
      });
    }
    const update = updateFromExecutor(result, activeState);
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

// Hosts/tests may override this handler via RootGraphDeps.textToSql
// without changing the registry or root graph topology.
registerUC(TEXT_TO_SQL_UC_ID, createTextToSqlRuntime().entry);
