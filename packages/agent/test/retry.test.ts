// Deterministic unit tests for model rate-limit classification, backoff/jitter,
// Retry-After handling, budget/deadline enforcement, abort cleanup, and trace
// hygiene (issue #91). Uses controlled clocks, random, and AbortSignal.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dbToolError } from "@shared/contracts";
import {
  budgetTripReasonFromError,
  createBudgetState,
} from "../src/queryExecutor/budgets.js";
import {
  ModelRetryError,
  classifyModelError,
  classifyModelReaskFailure,
  parseRetryAfterHeaderMs,
  parseRetryAfterMessageMs,
  planRetryDelay,
  resolveModelRetryConfig,
  retryModelCall,
  sleepWithAbort,
  toModelDbToolError,
} from "../src/telemetry/retry.js";

describe("resolveModelRetryConfig", () => {
  it("uses safe defaults when env vars are unset", () => {
    expect(resolveModelRetryConfig({} as NodeJS.ProcessEnv)).toEqual({
      maxRetries: 3,
      baseMs: 1000,
      maxWaitMs: 30000,
    });
  });

  it("parses valid env overrides and allows 0 retries", () => {
    expect(
      resolveModelRetryConfig({
        AGENT_MODEL_MAX_RETRIES: "5",
        AGENT_MODEL_RETRY_BASE_MS: "250",
        AGENT_MODEL_RETRY_MAX_WAIT_MS: "15000",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      maxRetries: 5,
      baseMs: 250,
      maxWaitMs: 15000,
    });

    expect(
      resolveModelRetryConfig({
        AGENT_MODEL_MAX_RETRIES: "0",
      } as unknown as NodeJS.ProcessEnv).maxRetries,
    ).toBe(0);
  });

  it("falls back on invalid/negative env values and clamps upper bounds", () => {
    expect(
      resolveModelRetryConfig({
        AGENT_MODEL_MAX_RETRIES: "-2",
        AGENT_MODEL_RETRY_BASE_MS: "not-a-number",
        AGENT_MODEL_RETRY_MAX_WAIT_MS: "1.5",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      maxRetries: 3,
      baseMs: 1000,
      maxWaitMs: 30000,
    });

    expect(
      resolveModelRetryConfig({
        AGENT_MODEL_MAX_RETRIES: "999",
        AGENT_MODEL_RETRY_BASE_MS: "999999",
        AGENT_MODEL_RETRY_MAX_WAIT_MS: "999999",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      maxRetries: 10,
      baseMs: 60000,
      maxWaitMs: 120000,
    });
  });
});

describe("Retry-After parsing", () => {
  it("parses numeric seconds and HTTP-dates deterministically", () => {
    const now = Date.UTC(2026, 10, 17, 10, 0, 0);
    expect(parseRetryAfterHeaderMs("5", now)).toBe(5000);
    expect(parseRetryAfterHeaderMs("1.5", now)).toBe(1500);
    expect(parseRetryAfterHeaderMs("0", now)).toBe(0);
    expect(parseRetryAfterHeaderMs("Wed, 17 Nov 2026 10:00:08 GMT", now)).toBe(8000);
    // Clock skew / date in the past clamps cleanly to 0ms.
    expect(parseRetryAfterHeaderMs("Wed, 17 Nov 2026 09:59:50 GMT", now)).toBe(0);
    // Invalid values return undefined.
    expect(parseRetryAfterHeaderMs("-3", now)).toBeUndefined();
    expect(parseRetryAfterHeaderMs("not-a-date", now)).toBeUndefined();
    expect(parseRetryAfterHeaderMs("", now)).toBeUndefined();
  });

  it("parses explicit message wait hints and ignores ambiguous unitless numbers", () => {
    expect(parseRetryAfterMessageMs("Rate limit reached. Please try again in 2.5s.")).toBe(2500);
    expect(parseRetryAfterMessageMs("Please try again in 250ms.")).toBe(250);
    expect(parseRetryAfterMessageMs("Please try again in 1m30s.")).toBe(90_000);
    expect(parseRetryAfterMessageMs("Retry after 2 minutes")).toBe(120_000);
    expect(parseRetryAfterMessageMs("Wait 1 hour before retrying")).toBe(3_600_000);
    // Ambiguous unitless text must not be guessed.
    expect(parseRetryAfterMessageMs("Try again in 5")).toBeUndefined();
  });
});

describe("classifyModelError", () => {
  it("classifies 429 errors across Web Headers, plain objects, and LangChain wrappers", () => {
    const now = 1_700_000_000_000;
    const webHeadersErr = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      headers: new Headers({ "Retry-After": "4" }),
    });
    expect(classifyModelError(webHeadersErr, now)).toEqual({
      kind: "rate_limit",
      retryable: true,
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 4000,
      reason: "rate_limit_429",
    });

    const nestedPlainErr = {
      message: "wrapped failure",
      cause: {
        response: {
          status: 429,
          headers: { "retry-after-ms": "1250" },
        },
      },
    };
    expect(classifyModelError(nestedPlainErr, now)).toEqual({
      kind: "rate_limit",
      retryable: true,
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 1250,
      reason: "rate_limit_429",
    });

    const lcErr = Object.assign(new Error("Please try again in 3s"), {
      lc_error_code: "MODEL_RATE_LIMIT",
    });
    expect(classifyModelError(lcErr, now)).toEqual({
      kind: "rate_limit",
      retryable: true,
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 3000,
      reason: "rate_limit_429",
    });
  });

  it("classifies HTTP 503 overload responses as retryable RATE_LIMITED", () => {
    const err503 = Object.assign(new Error("Service Unavailable"), {
      status: 503,
      headers: { "Retry-After": "2" },
    });
    expect(classifyModelError(err503)).toEqual({
      kind: "rate_limit",
      retryable: true,
      code: "RATE_LIMITED",
      status: 503,
      retryAfterMs: 2000,
      reason: "overload_503",
    });
  });

  it("never retries JSON/schema, auth, bad request, policy/SQL, timeout, abort, or insufficient_quota", () => {
    expect(classifyModelError(new SyntaxError("Model output is not valid JSON"))).toMatchObject({
      kind: "non_retryable",
      retryable: false,
    });
    const zodErr = z.object({ a: z.string() }).safeParse({});
    if (!zodErr.success) {
      expect(classifyModelError(zodErr.error)).toMatchObject({
        kind: "non_retryable",
        retryable: false,
      });
    }
    expect(classifyModelError({ status: 401, message: "Unauthorized" })).toMatchObject({
      kind: "non_retryable",
      retryable: false,
      status: 401,
    });
    expect(classifyModelError({ status: 400, message: "Bad request" })).toMatchObject({
      kind: "non_retryable",
      retryable: false,
      status: 400,
    });
    expect(classifyModelError(dbToolError("INVALID_SQL", "syntax near 429"))).toMatchObject({
      kind: "non_retryable",
      retryable: false,
    });
    expect(classifyModelError(new Error('column "err_429" does not exist'))).toMatchObject({
      kind: "non_retryable",
      retryable: false,
    });
    const timeoutErr = new Error("Model stream stalled");
    timeoutErr.name = "TimeoutError";
    expect(classifyModelError(timeoutErr)).toMatchObject({
      kind: "non_retryable",
      retryable: false,
    });
    const quotaErr = Object.assign(new Error("You exceeded your current quota"), {
      status: 429,
      code: "insufficient_quota",
    });
    expect(classifyModelError(quotaErr)).toEqual({
      kind: "rate_limit",
      retryable: false,
      code: "RATE_LIMITED",
      status: 429,
      reason: "insufficient_quota",
    });
  });
});

describe("classifyModelReaskFailure", () => {
  it("allows one format re-ask for syntax, schema, and output parser failures", () => {
    expect(classifyModelReaskFailure(new SyntaxError("invalid JSON"))).toEqual({
      code: "syntax_error",
      formatFailure: true,
    });
    const invalid = z.object({ value: z.string() }).safeParse({});
    if (invalid.success) throw new Error("expected a Zod failure");
    expect(classifyModelReaskFailure(invalid.error)).toEqual({
      code: "zod_error",
      formatFailure: true,
    });
    const parserError = Object.assign(new Error("Could not parse result"), {
      name: "OutputParserException",
    });
    expect(classifyModelReaskFailure(parserError)).toEqual({
      code: "output_parse_error",
      formatFailure: true,
    });
  });

  it("allows provider 5xx except 503 and excludes auth, rate limits, aborts, timeouts, and budget failures", () => {
    for (const status of [500, 502, 504, 599]) {
      expect(classifyModelReaskFailure(Object.assign(new Error("provider error"), { status }))).toEqual({
        code: "provider_5xx",
        formatFailure: false,
        status,
      });
    }
    for (const status of [400, 401, 402, 403, 404, 408, 429, 503]) {
      expect(classifyModelReaskFailure(Object.assign(new Error("provider error"), { status }))).toBeNull();
    }
    for (const name of ["AbortError", "TimeoutError", "ContextOverflowError"]) {
      expect(classifyModelReaskFailure(Object.assign(new Error("stopped"), { name }))).toBeNull();
    }
    expect(classifyModelReaskFailure(new ModelRetryError({
      message: "budget stopped",
      attempts: 1,
      reason: "budget_llm-calls",
      budgetTripped: true,
      tripReason: "llm-calls",
    }))).toBeNull();
  });
});

describe("planRetryDelay", () => {
  it("computes capped exponential backoff with deterministic jitter", () => {
    expect(
      planRetryDelay({ retryIndex: 1, baseMs: 1000, maxWaitMs: 30000, nowMs: 0, random: () => 0 }),
    ).toEqual({ shouldRetry: true, delayMs: 500 });
    expect(
      planRetryDelay({ retryIndex: 1, baseMs: 1000, maxWaitMs: 30000, nowMs: 0, random: () => 0.9999 }),
    ).toEqual({ shouldRetry: true, delayMs: 1000 });
    expect(
      planRetryDelay({ retryIndex: 3, baseMs: 1000, maxWaitMs: 30000, nowMs: 0, random: () => 0.5 }),
    ).toEqual({ shouldRetry: true, delayMs: 3000 });
    // Capped at maxWaitMs.
    expect(
      planRetryDelay({ retryIndex: 6, baseMs: 1000, maxWaitMs: 5000, nowMs: 0, random: () => 0.9999 }),
    ).toEqual({ shouldRetry: true, delayMs: 5000 });
  });

  it("honors Retry-After when within limits and stops when exceeding maxWaitMs or deadlineMs", () => {
    expect(
      planRetryDelay({
        retryIndex: 1,
        retryAfterMs: 4000,
        baseMs: 1000,
        maxWaitMs: 10000,
        deadlineMs: 20000,
        nowMs: 1000,
        random: () => 0.5,
      }),
    ).toEqual({ shouldRetry: true, delayMs: 4000 });

    expect(
      planRetryDelay({
        retryIndex: 1,
        retryAfterMs: 15000,
        baseMs: 1000,
        maxWaitMs: 10000,
        deadlineMs: 60000,
        nowMs: 1000,
      }),
    ).toEqual({ shouldRetry: false, stopReason: "retry_after_exceeds_max_wait" });

    expect(
      planRetryDelay({
        retryIndex: 1,
        retryAfterMs: 4000,
        baseMs: 1000,
        maxWaitMs: 10000,
        deadlineMs: 4500,
        nowMs: 1000,
      }),
    ).toEqual({ shouldRetry: false, stopReason: "retry_after_exceeds_deadline" });

    expect(
      planRetryDelay({
        retryIndex: 2,
        baseMs: 1000,
        maxWaitMs: 10000,
        deadlineMs: 1500,
        nowMs: 1000,
        random: () => 0.5,
      }),
    ).toEqual({ shouldRetry: false, stopReason: "deadline_exceeded" });
  });
});

describe("retryModelCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries twice on 429 then succeeds, accounting budget and redacted retry traces", async () => {
    let clock = 10_000;
    const waits: number[] = [];
    const spans: { node: string; type: string; durationMs: number; attempt?: number; payload?: unknown }[] = [];
    const budget = createBudgetState({ nowMs: clock, maxLlmCalls: 10, runDeadlineMs: 60_000 });
    let calls = 0;

    const outcome = await retryModelCall(
      async () => {
        calls += 1;
        if (calls <= 2) {
          throw Object.assign(
            new Error("429 Rate limit reached: Authorization Bearer sk-should-never-appear"),
            {
              status: 429,
              headers: { "Retry-After": "1", "x-api-key": "sk-top-secret" },
            },
          );
        }
        return "ok-result";
      },
      {
        node: "propose",
        modelName: "test-model",
        config: { maxRetries: 3, baseMs: 200, maxWaitMs: 5000 },
        budget,
        emit: (e) => {
          spans.push(e);
          return `span-${spans.length}`;
        },
        now: () => clock,
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      },
    );

    expect(outcome).toEqual({ value: "ok-result", attempts: 3, failedAttempts: 2 });
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 1000]);
    // 2 failed requests counted in budget with 0 tokens (caller records the 3rd on success).
    expect(budget.llmCalls).toBe(2);
    expect(budget.tokensUsed).toBe(0);

    const failedLlmSpans = spans.filter((s) => s.type === "llm_call");
    const retrySpans = spans.filter((s) => s.type === "retry");
    expect(failedLlmSpans).toHaveLength(2);
    expect(retrySpans).toHaveLength(2);
    expect(retrySpans[0]?.payload).toMatchObject({
      target: "llm",
      code: "RATE_LIMITED",
      status: 429,
      attempt: 1,
      nextAttempt: 2,
      waitMs: 1000,
      retryAfterMs: 1000,
    });
    const serialized = JSON.stringify(spans);
    expect(serialized).not.toContain("sk-should-never-appear");
    expect(serialized).not.toContain("sk-top-secret");
  });

  it("stops with RATE_LIMITED within deadline when 429 persists", async () => {
    let clock = 10_000;
    const budget = createBudgetState({ nowMs: clock, maxLlmCalls: 20, runDeadlineMs: 2500 });
    let calls = 0;

    const err = await retryModelCall(
      async () => {
        calls += 1;
        throw Object.assign(new Error("429 Too Many Requests"), {
          status: 429,
          headers: { "Retry-After": "1" },
        });
      },
      {
        node: "understand",
        config: { maxRetries: 5, baseMs: 200, maxWaitMs: 5000 },
        budget,
        now: () => clock,
        random: () => 0,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelRetryError);
    const retryErr = err as ModelRetryError;
    expect(retryErr.code).toBe("RATE_LIMITED");
    expect(retryErr.retryable).toBe(true);
    expect(clock - 10_000).toBeLessThan(2500);
    expect(calls).toBe(3); // 1000ms + 1000ms = 2000ms elapsed; next 1000ms >= 500ms left -> stopped
    expect(budget.llmCalls).toBe(3);
    expect(toModelDbToolError(retryErr).code).toBe("RATE_LIMITED");
  });

  it("stops immediately when maxLlmCalls budget is exhausted by retries", async () => {
    let clock = 1_000;
    const budget = createBudgetState({ nowMs: clock, maxLlmCalls: 2, runDeadlineMs: 60_000 });
    let calls = 0;

    const err = await retryModelCall(
      async () => {
        calls += 1;
        throw Object.assign(new Error("503 Service Unavailable"), { status: 503 });
      },
      {
        node: "propose",
        config: { maxRetries: 5, baseMs: 100, maxWaitMs: 5000 },
        budget,
        now: () => clock,
        random: () => 0,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelRetryError);
    expect((err as ModelRetryError).code).toBe("RATE_LIMITED");
    expect((err as ModelRetryError).budgetTripped).toBe(true);
    expect((err as ModelRetryError).tripReason).toBe("llm-calls");
    expect(calls).toBe(2);
    expect(budget.llmCalls).toBe(2);
  });

  it("redacts secrets from ModelRetryError messages", async () => {
    const err = await retryModelCall(
      async () => {
        throw Object.assign(
          new Error("429 error from https://user:secretpass@gateway/v1 with Bearer sk-live-999"),
          { status: 429 },
        );
      },
      {
        node: "propose",
        config: { maxRetries: 0, baseMs: 10, maxWaitMs: 100 },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelRetryError);
    expect((err as Error).message).toContain("RATE_LIMITED");
    expect((err as Error).message).not.toContain("secretpass");
    expect((err as Error).message).not.toContain("sk-live-999");
  });

  it("cancels pending retry sleep cleanly via AbortSignal without timer leaks", async () => {
    const controller = new AbortController();
    const pending = sleepWithAbort(10_000, controller.signal);
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow("user cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tags mid-call TimeoutError as budget deadline trip once budget deadline has elapsed", async () => {
    let clock = 1_000;
    const budget = createBudgetState({ nowMs: clock, maxLlmCalls: 10, runDeadlineMs: 500 });

    const err = await retryModelCall(
      async () => {
        clock = 1_600;
        const timeoutErr = new Error("attempt timed out");
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      },
      {
        node: "propose",
        config: { maxRetries: 2, baseMs: 10, maxWaitMs: 100 },
        budget,
        now: () => clock,
      },
    ).catch((e: unknown) => e);

    expect(budgetTripReasonFromError(err)).toBe("deadline");
    expect(budget.llmCalls).toBe(1);
  });
});
