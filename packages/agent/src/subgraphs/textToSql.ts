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
  isClarificationOption,
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
  resolveCandidateTables,
  selectSqlReferences,
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
      ? { mcpUrl, token, runId: identity.runId, userId: identity.userId, roleScope: identity.roleScope }
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

function clarificationSelection(
  state: AgentState,
  request: PendingClarification,
): string | undefined {
  for (let attempt = state.clarificationAttempts; attempt < 2; attempt += 1) {
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
): { state: AgentState; update: AgentUpdate } {
  const intent = { ...state.intent };
  if (request.field === "metric") {
    intent.metric = value;
    intent.requestedMetrics = [value];
  } else if (request.field === "timeRange") {
    intent.timeRange = value;
  } else if (request.field === "scope") {
    intent.filters = [...intent.filters, { field: "scope", operator: "=", value }];
  } else {
    intent.filters = [...intent.filters, { field: "filterValue", operator: "=", value }];
  }
  const question = `${state.question}\nClarification (${request.field}): ${value}`;
  const update: AgentUpdate = {
    intent,
    question,
    pendingClarification: null,
    clarificationAttempts: state.clarificationAttempts + 1,
  };
  return {
    state: {
      ...state,
      intent,
      question,
      pendingClarification: null,
      clarificationAttempts: state.clarificationAttempts + 1,
    },
    update,
  };
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
    const resolved = resolveCandidateTables({
      question: activeState.question,
      schemaEntities: activeState.intent.schemaEntities,
      requestedMetrics: activeState.intent.requestedMetrics,
      filterValues: activeState.intent.filters.map((f) => String(f.value ?? "")),
      catalogTables: effectiveCatalogTables,
      catalogLoaded: effectiveCatalogStatus === "ready",
      semanticChunks: activeState.semanticChunks,
    });
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
      const missing =
        resolved.unmappedEntities.length > 0
          ? ` (${resolved.unmappedEntities.join(", ")})`
          : "";
      const available =
        effectiveCatalogTables.length > 0
          ? ` Available tables: ${effectiveCatalogTables.map((t) => t.name).join(", ")}.`
          : "";
      return {
        ...clarificationUpdate,
        status: "cannot_answer",
        answerText: `No candidate data tables were identified for this question${missing}.${available}`,
      };
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
      },
    });
    const references = selectSqlReferences(activeState.semanticChunks, candidateTables);
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
    const update = updateFromExecutor(result, state);
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
