// D-13 budget breaker matrix (01-11). Pure and DB-free: deterministic clock
// via nowMs, no API key, no MCP, no pg.
import { describe, expect, it } from "vitest";
import {
  checkBudget,
  createBudgetState,
  formatBudgetTripTemplate,
  recordLlmCall,
} from "../src/queryExecutor/budgets.js";
import { BUDGET_LIMITS } from "../src/constants.js";

describe("budget breaker", () => {
  it("seeds the locked D-13 defaults", () => {
    expect(BUDGET_LIMITS).toEqual({
      maxLlmCalls: 20,
      maxTokens: 60000,
      runDeadlineMs: 120000,
    });
    const state = createBudgetState({ nowMs: 1000 });
    expect(state).toEqual({
      llmCalls: 0,
      tokensUsed: 0,
      deadlineMs: 121000,
      maxLlmCalls: 20,
      maxTokens: 60000,
    });
  });

  it("lets under-budget calls proceed", () => {
    const state = createBudgetState({ nowMs: 0 });
    for (let i = 0; i < 19; i += 1) recordLlmCall(state, 100);
    expect(checkBudget(state, 1000)).toEqual({ tripped: false });
  });

  it("trips on the LLM-call budget and preserves a state snapshot", () => {
    const state = createBudgetState({ nowMs: 0, maxLlmCalls: 2 });
    recordLlmCall(state);
    recordLlmCall(state);
    const before = { ...state };
    const trip = checkBudget(state, 10);
    expect(trip.tripped).toBe(true);
    if (!trip.tripped) return;
    expect(trip.reason).toBe("llm-calls");
    expect(trip.state).toEqual(before);
    // The check itself never mutates the counters.
    expect(state).toEqual(before);
  });

  it("trips on the token budget", () => {
    const state = createBudgetState({ nowMs: 0, maxTokens: 100 });
    recordLlmCall(state, 100);
    const trip = checkBudget(state, 10);
    expect(trip.tripped).toBe(true);
    if (!trip.tripped) return;
    expect(trip.reason).toBe("tokens");
  });

  it("trips on the run deadline", () => {
    const state = createBudgetState({ nowMs: 0, runDeadlineMs: 1000 });
    expect(checkBudget(state, 999)).toEqual({ tripped: false });
    const trip = checkBudget(state, 1000);
    expect(trip.tripped).toBe(true);
    if (!trip.tripped) return;
    expect(trip.reason).toBe("deadline");
  });

  it("honours constructor overrides for tests", () => {
    const state = createBudgetState({
      nowMs: 500,
      maxLlmCalls: 3,
      maxTokens: 700,
      runDeadlineMs: 5000,
    });
    expect(state).toMatchObject({
      maxLlmCalls: 3,
      maxTokens: 700,
      deadlineMs: 5500,
    });
    expect(checkBudget(state, 600)).toEqual({ tripped: false });
  });

  it("formats a deterministic budget caveat with verified findings and remaining work", () => {
    const message = formatBudgetTripTemplate({
      reason: "tokens",
      budget: {
        llmCalls: 4,
        tokensUsed: 110,
        maxLlmCalls: 20,
        maxTokens: 100,
      },
      completed: ["Described table orders", "Validated baseline value"],
      verifiedSql: "SELECT COUNT(*) AS total FROM public.orders",
      rowCount: 1,
      verifiedFigures: { baselineVal: 42 },
      remaining: ["Execute current-period query", "Build the analysis plan"],
    });

    expect(message).toContain("budget_exceeded (maxTokens)");
    expect(message).toContain("llmCalls=4/20; tokensUsed=110/100");
    expect(message).toContain("Described table orders");
    expect(message).toContain("Verified SQL: SELECT COUNT(*) AS total FROM public.orders");
    expect(message).toContain("Verified row count: 1");
    expect(message).toContain("Verified baselineVal: 42");
    expect(message).toContain("Execute current-period query");
    expect(message).toContain("Build the analysis plan");
    expect(message).toContain("No additional model calls or database queries");
  });

  it("redacts PII from verified text before returning a budget template", () => {
    const message = formatBudgetTripTemplate({
      reason: "deadline",
      budget: { llmCalls: 1, tokensUsed: 2, maxLlmCalls: 20, maxTokens: 60000 },
      completed: ["Contact 0912 345 678"],
    });

    expect(message).not.toContain("0912 345 678");
    expect(message).toContain("[MASKED_PHONE]");
  });
});
