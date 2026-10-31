import { dbToolError, type DbToolError } from "@shared/contracts";
import * as z from "zod";
import { createChatModel, withStructured } from "../models/factory.js";
import { checkBudget, createBudgetState, type BudgetState } from "../queryExecutor/budgets.js";
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
import { registerUC } from "./registry.js";

/** Stable registry key for the UC-01 Text-to-SQL entry. */
export const UC01_ID = "uc01";

/** The intent profile returns only the serializable state intent shape. */
export const IntentProposalSchema = IntentSchema;
export type IntentProposal = z.infer<typeof IntentProposalSchema>;

/** Narrow model seam so unit tests never need an API key. */
export interface IntentModelLike {
  withStructuredOutput(
    schema: typeof IntentProposalSchema,
    opts?: { name?: string },
  ): { invoke(input: string): Promise<IntentProposal> };
}

/** Narrow executor seam; UC-01 never opens a database connection directly. */
export interface Uc01ExecutorLike {
  run(input: ExecutorRunInput): Promise<ExecutorResult>;
}

export interface Uc01RuntimeDeps {
  intentModel?: IntentModelLike;
  /** SQL model seam; omitted in production to use the configured profile. */
  sqlModel?: ChatModelLike;
  executor?: Uc01ExecutorLike;
}

/** Root-entry guard: initialize one persistent deadline and stop before I/O. */
export function guardUc01Budget(state: AgentState): AgentUpdate {
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

function configuredIdentity(rt: RootRuntime): {
  runId: string;
  userId: string;
  roleScope: string;
} | null {
  const config = (rt.config.configurable ?? {}) as Record<string, unknown>;
  const read = (key: string): string | null => {
    const value = config[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const runId = read("runId");
  const userId = read("userId");
  const roleScope = read("roleScope");
  return runId && userId && roleScope ? { runId, userId, roleScope } : null;
}

function configuredTransport(rt: RootRuntime): TracerRunConfig | null {
  const config = (rt.config.configurable ?? {}) as Record<string, unknown>;
  const read = (key: string): string | null => {
    const value = config[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const mcpUrl = read("mcpUrl");
  const token = read("token");
  const runId = read("runId");
  const userId = read("userId");
  const roleScope = read("roleScope");
  return mcpUrl && token && runId && userId && roleScope
    ? { mcpUrl, token, runId, userId, roleScope }
    : null;
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

function estimateTokens(...texts: string[]): number {
  return Math.max(1, Math.ceil(texts.join("").length / 4));
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

function updateFromExecutor(result: ExecutorResult): AgentUpdate {
  switch (result.status) {
    case "ok":
      return {
        status: "ok",
        sql: result.sql,
        tablesUsed: result.tablesUsed,
        columns: result.columns,
        resultPreview: result.rows.slice(0, 50),
      };
    case "no_data":
      return {
        status: "no_data",
        sql: result.sql,
        tablesUsed: result.tablesUsed,
        columns: result.columns,
        resultPreview: [],
        answerText: result.diagnostic ?? "No matching data was found.",
      };
    case "needs_clarification":
      return {
        status: "needs_clarification",
        sql: result.sql,
        answerText: result.reason,
      };
    case "restricted":
    case "error":
      return {
        status: result.status,
        sql: result.sql,
        answerText: result.error.message,
      };
    case "cannot_answer":
      return {
        status: "cannot_answer",
        sql: result.sql,
        answerText: result.reason,
      };
  }
}

/**
 * Builds the UC-01 understanding node and entry handler. The root graph owns
 * dispatch; this module owns model, skill, and executor wiring for the UC.
 */
export function createUc01Runtime(deps: Uc01RuntimeDeps = {}): {
  understand: (state: AgentState, rt: RootRuntime) => Promise<AgentUpdate>;
  entry: UcEntryHandler;
} {
  const understand = async (
    state: AgentState,
    rt: RootRuntime,
  ): Promise<AgentUpdate> => {
    const skill = loadSkill("text-to-sql", { emit: rt.emit });
    const prompt = intentPrompt(state.question, skill.contract);
    const proposal = deps.intentModel
      ? await deps.intentModel
          .withStructuredOutput(IntentProposalSchema, { name: "intent_proposal" })
          .invoke(prompt)
      : await withStructured(createChatModel("intent"), IntentProposalSchema, {
          name: "intent_proposal",
        }).invoke(prompt);
    const intent = IntentProposalSchema.parse(proposal);
    return {
      intent,
      budget: { llmCalls: 1, tokensUsed: estimateTokens(prompt, JSON.stringify(intent)) },
    };
  };

  const entry: UcEntryHandler = async (
    state: AgentState,
    rt: RootRuntime,
  ): Promise<AgentUpdate> => {
    if (state.intent.queryMode === "definition_lookup") {
      return {
        status: "cannot_answer",
        answerText: "Definition lookup is not configured for UC-01 yet.",
      };
    }
    const transport = deps.executor ? null : configuredTransport(rt);
    if (!deps.executor && !transport) {
      return {
        status: "error",
        answerText: "UC-01 MCP transport identity is incomplete.",
      };
    }
    const identity = configuredIdentity(rt);
    if (!identity) {
      return {
        status: "error",
        answerText: "UC-01 run identity is incomplete.",
      };
    }
    const candidateTables = [...new Set(state.intent.schemaEntities)]
      .map((entity) => entity.trim())
      .filter((entity) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entity));
    if (candidateTables.length === 0) {
      return {
        status: "cannot_answer",
        answerText: "No candidate data tables were identified for this question.",
      };
    }
    const executor =
      deps.executor ??
      new ValidatedQueryExecutor({
        model: deps.sqlModel ?? (createChatModel("sql") as unknown as ChatModelLike),
        mcp: createRuntimeMcpCaller(transport!),
        emitSpan: (event) =>
          rt.emit({
            node: event.node,
            type: event.type,
            durationMs: event.durationMs ?? 0,
            payload: event.payload,
            attempt: event.attempt,
          }),
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
    });
    const update = updateFromExecutor(result);
    return {
      ...update,
      ...(result.status === "ok" || result.status === "no_data"
        ? {
            toolsCalled: [
              ...state.toolsCalled,
              "describe_table",
              "explain_query",
              "run_query",
            ],
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

// Hosts/tests may override this handler via RootGraphDeps.uc01 without
// changing the registry or root graph topology.
registerUC(UC01_ID, createUc01Runtime().entry);
