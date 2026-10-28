// D-13 budget breaker (01-11). Pure, DB-free, no network: the executor calls
// checkBudget before every LLM and MCP call, and a trip stops further calls
// so the run degrades to synthesis with partial findings. Limits duplicate
// the locked D-13 values (also exported as BUDGET_DEFAULTS from the 01-10
// state module, which this file must NOT import per the plan boundary).

/** Locked D-13 run-level budget limits. */
export const BUDGET_LIMITS = {
  maxLlmCalls: 20,
  maxTokens: 60000,
  runDeadlineMs: 120000,
} as const;

/** Mutable per-run counters plus the absolute deadline epoch. */
export interface BudgetState {
  llmCalls: number;
  tokensUsed: number;
  /** Absolute epoch-ms deadline: creation time plus runDeadlineMs. */
  deadlineMs: number;
  maxLlmCalls: number;
  maxTokens: number;
}

export interface BudgetOverrides {
  maxLlmCalls?: number;
  maxTokens?: number;
  /** Deadline window in ms from creation (default: D-13 120000). */
  runDeadlineMs?: number;
  /** Injectable clock for deterministic tests. */
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

/**
 * Fail-closed guard: call before every LLM and MCP call. Pure — it never
 * mutates the state; the trip carries a snapshot so the caller preserves
 * partial findings (tables described so far, last SQL, rows fetched).
 */
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

/** Record a completed LLM call (call count plus token usage). */
export function recordLlmCall(state: BudgetState, tokensUsed = 0): void {
  state.llmCalls += 1;
  state.tokensUsed += tokensUsed;
}
