import { dbToolError, type DbToolError } from "@shared/contracts";
import { z } from "zod";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { createChatModel } from "../models/factory.js";
import {
  estimateCostUsd,
  invokeWithUsage,
} from "../telemetry/usage.js";
import { checkBudget, createBudgetState, estimateTokens, type BudgetState } from "../queryExecutor/budgets.js";
import {
  ValidatedQueryExecutor,
  type ChatModelLike,
  type ExecutorResult,
  type ExecutorRunInput,
  type McpToolCaller,
} from "../queryExecutor/executor.js";
import { callMcpTool, type TracerRunConfig } from "../mcpClient.js";
import { loadSkill } from "../skills/loader.js";
import {
  IntentSchema,
  type AgentState,
  type AgentUpdate,
  type RootRuntime,
  type UcEntryHandler,
} from "../state.js";
import { checkUnknownTerms, buildCannotAnswer } from "../semantic/retrieveSemantic.js";
import {
  deriveCitations,
  ensureCitationHeader,
  validateCitations,
} from "../validators/citationValidator.js";
import { registerUC } from "./registry.js";
import { TEXT_TO_SQL_UC_ID } from "../constants.js";

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
}

export interface TextToSqlRuntimeDeps {
  intentModel?: IntentModelLike;
  /** SQL model seam; omitted in production to use the configured profile. */
  sqlModel?: ChatModelLike;
  executor?: TextToSqlExecutorLike;
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

function asMcpFailure(tool: string, text: string): DbToolError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      typeof (parsed as { code: unknown }).code === "string" &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
    ) {
      return parsed as DbToolError;
    }
  } catch {
    // A malformed gateway failure is deliberately normalized below.
  }
  return dbToolError("INTERNAL_ERROR", `MCP tool ${tool} failed: ${text.slice(0, 200)}`);
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
      if (result.isError) throw asMcpFailure(tool, result.text);
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

function intentPrompt(question: string, skillContract: string): string {
  return [
    "Extract a structured analytics intent from the user question.",
    "requestedMetrics contains business measures; schemaEntities contains candidate physical tables or columns.",
    "Use definition_lookup only when the user asks for a definition rather than data.",
    "Do not invent tables, columns, metrics, or filter values.",
    `Skill contract:\n${skillContract}`,
    `Question: ${question}`,
  ].join("\n\n");
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
    return { ...update, sql: withCitationHeader(state, update.sql) };
  }
  return update;
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Normalize schema entities to bare table names: trim, strip schema prefix, validate, lowercase, dedupe. */
function normalizeCandidateTables(entities: string[]): string[] {
  const seen = new Set<string>();
  const tables: string[] = [];
  for (const entity of entities) {
    const last = (entity.trim().split(".").pop() ?? "").trim().toLowerCase();
    if (!TABLE_NAME_RE.test(last) || seen.has(last)) continue;
    seen.add(last);
    tables.push(last);
  }
  return tables;
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
  if (metrics.length === 0 || chunks.length === 0) return null;
  const { ungrounded } = checkUnknownTerms(metrics, chunks);
  if (ungrounded.length === 0) return null;
  return buildCannotAnswer(ungrounded, chunks);
}

/**
 * K7 citation header (UC-02): derive citations from the retrieved turn
 * context and prepend `-- @citations: ...` to executor SQL. Never changes
 * status — the unknown-term gate owns cannot_answer; this seam only
 * guarantees dual (JSON + SQL header) citation formatting.
 */
function withCitationHeader(state: AgentState, sql: string | null): string | null {
  if (sql === null || sql === undefined) return sql;
  const retrievedIds = state.semanticChunks.map((chunk) => chunk.chunkId);
  if (retrievedIds.length === 0) return sql;
  const citations = deriveCitations(retrievedIds);
  if (citations.length === 0) return sql;
  const checked = validateCitations({
    citations,
    sql,
    requestedMetrics: state.intent.requestedMetrics,
    retrievedChunkIds: retrievedIds,
    catalogIds: retrievedIds,
  });
  if (checked.ok) return checked.sql;
  // Relaxed fallback (column-grounded metric with no metric:* retrieved):
  // still ship dual citations rather than blocking the answer.
  return ensureCitationHeader(sql, citations);
}

/** MCP tool names the executor reports via span payloads. */
const KNOWN_TOOL_NAMES = new Set([
  "describe_table",
  "explain_query",
  "run_query",
  "sample_rows",
]);

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
    const skill = loadSkill("text-to-sql", { emit: rt.emit });
    const prompt = intentPrompt(state.question, skill.contract);
    const intentStarted = Date.now();
    const out = deps.intentModel
      ? await invokeWithUsage(deps.intentModel, IntentProposalSchema, prompt, {
          name: "intent_proposal",
          callbacks: rt.config.callbacks,
        })
      : await invokeWithUsage(
          createChatModel("intent"),
          IntentProposalSchema,
          prompt,
          { name: "intent_proposal", callbacks: rt.config.callbacks },
        );
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
    return {
      intent,
      budget: {
        llmCalls: 1,
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
    const definition = handleDefinitionLookup(state);
    if (definition) return definition;
    const unknownTerm = handleUnknownTerm(state);
    if (unknownTerm) return unknownTerm;
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
    const candidateTables = normalizeCandidateTables(state.intent.schemaEntities);
    if (candidateTables.length === 0) {
      return {
        status: "cannot_answer",
        answerText: "No candidate data tables were identified for this question.",
      };
    }
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
      llmCalls: state.budget.llmCalls,
      tokensUsed: state.budget.tokensUsed,
      deadlineMs: state.budget.deadlineMs,
      maxLlmCalls: state.budget.maxLlmCalls,
      maxTokens: state.budget.maxTokens,
    };
    const result = await executor.run({
      question: state.question,
      candidateTables,
      principal: identity,
      budget,
      callbacks: rt.config.callbacks,
    });
    const update = updateFromExecutor(result, state);
    const isOkLike = result.status === "ok" || result.status === "no_data";
    const observedTools =
      collectedTools.length > 0
        ? collectedTools
        : result.status === "ok"
          ? ["describe_table", "run_query"]
          : [];
    return {
      ...update,
      ...(isOkLike
        ? { toolsCalled: [...state.toolsCalled, ...observedTools] }
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
