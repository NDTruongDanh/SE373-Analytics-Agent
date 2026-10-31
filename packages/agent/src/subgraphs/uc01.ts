import * as z from "zod";
import { createChatModel, withStructured } from "../models/factory.js";
import { checkBudget, createBudgetState } from "../queryExecutor/budgets.js";
import {
  type ExecutorResult,
  type ExecutorRunInput,
} from "../queryExecutor/executor.js";
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
    return { intent, budget: { llmCalls: 1 } };
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
    if (!deps.executor) {
      return {
        status: "error",
        answerText: "UC-01 query executor is not configured.",
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
    return updateFromExecutor(
      await deps.executor.run({
        question: state.question,
        candidateTables,
        principal: identity,
      }),
    );
  };

  return { understand, entry };
}

// Hosts/tests may override this handler via RootGraphDeps.uc01 without
// changing the registry or root graph topology.
registerUC(UC01_ID, createUc01Runtime().entry);
