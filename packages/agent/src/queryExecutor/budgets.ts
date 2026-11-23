import { BUDGET_LIMITS } from "../constants.js";

export { BUDGET_LIMITS } from "../constants.js";

export interface BudgetState {
  llmCalls: number;
  tokensUsed: number;
  deadlineMs: number;
  maxLlmCalls: number;
  maxTokens: number;
}

export interface BudgetOverrides {
  maxLlmCalls?: number;
  maxTokens?: number;
  runDeadlineMs?: number;
  nowMs?: number;
}

export function createBudgetState(
  overrides: BudgetOverrides = {},
): BudgetState {
  const maxLlmCalls = overrides.maxLlmCalls ?? BUDGET_LIMITS.maxLlmCalls;
  const maxTokens = overrides.maxTokens ?? BUDGET_LIMITS.maxTokens;
  const windowMs = overrides.runDeadlineMs ?? BUDGET_LIMITS.runDeadlineMs;
  const now = overrides.nowMs ?? Date.now();
  return {
    llmCalls: 0,
    tokensUsed: 0,
    deadlineMs: now + windowMs,
    maxLlmCalls,
    maxTokens,
  };
}

export type BudgetTripReason = "llm-calls" | "tokens" | "deadline";

export type BudgetCheck =
  | { tripped: false }
  | { tripped: true; reason: BudgetTripReason; state: BudgetState };

/** Fail-closed guard: call before every LLM/MCP call; snapshots state so partial findings survive. */
export function checkBudget(
  state: BudgetState,
  nowMs: number = Date.now(),
): BudgetCheck {
  if (state.llmCalls >= state.maxLlmCalls) {
    return { tripped: true, reason: "llm-calls", state: { ...state } };
  }
  if (state.tokensUsed >= state.maxTokens) {
    return { tripped: true, reason: "tokens", state: { ...state } };
  }
  if (nowMs >= state.deadlineMs) {
    return { tripped: true, reason: "deadline", state: { ...state } };
  }
  return { tripped: false };
}

export function recordLlmCall(state: BudgetState, tokensUsed = 0): void {
  state.llmCalls += 1;
  state.tokensUsed += tokensUsed;
}

export function estimateTokens(...texts: string[]): number {
  return Math.max(1, Math.ceil(texts.join("").length / 4));
}
