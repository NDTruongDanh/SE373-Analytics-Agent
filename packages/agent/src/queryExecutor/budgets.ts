import { BUDGET_LIMITS } from "../constants.js";
import { redactPII } from "@shared/access-policy";

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

export function budgetLimitName(reason: BudgetTripReason): string {
  switch (reason) {
    case "llm-calls":
      return "maxLlmCalls";
    case "tokens":
      return "maxTokens";
    case "deadline":
      return "runDeadlineMs";
  }
}

export interface BudgetTripTemplateInput {
  reason: BudgetTripReason;
  budget: Pick<BudgetState, "llmCalls" | "tokensUsed" | "maxLlmCalls" | "maxTokens">;
  completed?: readonly string[];
  verifiedSql?: string | null;
  rowCount?: number;
  verifiedFigures?: Readonly<Record<string, number>>;
  remaining?: readonly string[];
}

function safeTemplateText(value: string, maxLength = 300): string {
  const normalized = value.replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim();
  return redactPII(normalized).redacted.slice(0, maxLength);
}

export function formatBudgetTripTemplate(input: BudgetTripTemplateInput): string {
  const { budget, reason } = input;
  const limit = budgetLimitName(reason);
  const completed = (input.completed ?? [])
    .map((item) => safeTemplateText(item))
    .filter(Boolean)
    .slice(0, 20);
  const remaining = (input.remaining ?? [])
    .map((item) => safeTemplateText(item))
    .filter(Boolean)
    .slice(0, 20);
  const lines = [
    `Caveat: budget_exceeded (${limit}); llmCalls=${budget.llmCalls}/${budget.maxLlmCalls}; tokensUsed=${budget.tokensUsed}/${budget.maxTokens}.`,
    "Completed:",
    ...(completed.length > 0 ? completed.map((item) => `- ${item}`) : ["- No verified steps completed."]),
  ];

  if (input.verifiedSql?.trim()) {
    lines.push(`- Verified SQL: ${safeTemplateText(input.verifiedSql, 500)}`);
  }
  if (Number.isSafeInteger(input.rowCount) && (input.rowCount ?? -1) >= 0) {
    lines.push(`- Verified row count: ${input.rowCount}`);
  }
  for (const [label, value] of Object.entries(input.verifiedFigures ?? {}).slice(0, 10)) {
    if (!Number.isFinite(value)) continue;
    lines.push(`- Verified ${safeTemplateText(label, 80)}: ${value}`);
  }

  lines.push("Remaining:");
  lines.push(...(remaining.length > 0 ? remaining.map((item) => `- ${item}`) : ["- No additional steps were scheduled."]));
  lines.push("No additional model calls or database queries were issued after the budget trip.");
  return lines.join("\n");
}

export function budgetTripReasonFromError(error: unknown): BudgetTripReason | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { budgetTripped?: unknown; tripReason?: unknown; message?: unknown };
  if (
    record.budgetTripped === true &&
    (record.tripReason === "llm-calls" || record.tripReason === "tokens" || record.tripReason === "deadline")
  ) {
    return record.tripReason;
  }
  if (typeof record.message !== "string") return undefined;
  const match = /^Run budget exceeded\s*\((llm-calls|tokens|deadline)\)/i.exec(record.message);
  return match?.[1] as BudgetTripReason | undefined;
}

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
