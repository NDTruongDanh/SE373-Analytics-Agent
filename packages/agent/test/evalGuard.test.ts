// Eval LangSmith guard (Phase 3, plan 03-02, D-04/T-03-06): `pnpm eval`
// must never export to LangSmith, even with the env set. `prepareEvalEnv`
// scrubs every tracing flag in-process before any graph is built; this
// suite proves the scrub on a fake env and through the real
// `buildLiveAdapter` entry (which throws its infra error before any
// DB/gateway work, so the test stays DB-free).
//
// Imports the eval entry from source, the same precedent as
// packages/agent/test/safety.test.ts importing evals/safety.ts.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildLiveAdapter,
  createEvalEmitter,
  prepareEvalEnv,
} from "../../../evals/run.js";
import { isLangSmithEnabled } from "../src/telemetry/langsmith.js";

const FLAGS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

describe("prepareEvalEnv", () => {
  it("deletes all four tracing flags and drops the live model key", () => {
    const env = {
      LANGSMITH_TRACING: "true",
      LANGSMITH_TRACING_V2: "true",
      LANGCHAIN_TRACING: "true",
      LANGCHAIN_TRACING_V2: "true",
      AGENT_MODEL_API_KEY: "sk-live-should-be-dropped",
      MCP_TOKEN_SALES_SOUTH: "keep-me",
    } as unknown as NodeJS.ProcessEnv;
    prepareEvalEnv(env);
    for (const flag of FLAGS) {
      expect(flag in env).toBe(false);
    }
    expect("AGENT_MODEL_API_KEY" in env).toBe(false);
    expect(env["MCP_TOKEN_SALES_SOUTH"]).toBe("keep-me");
  });

  it("keeps the live model key when explicitly opted in", () => {
    const env = {
      EVAL_USE_LIVE_MODEL: "1",
      AGENT_MODEL_API_KEY: "sk-live-opted-in",
    } as unknown as NodeJS.ProcessEnv;
    prepareEvalEnv(env);
    expect(env["AGENT_MODEL_API_KEY"]).toBe("sk-live-opted-in");
  });
});

describe("buildLiveAdapter env guard", () => {
  it("scrubs tracing flags before failing on missing DB env", async () => {
    const saved = new Map<string, string | undefined>();
    for (const key of [...FLAGS, "AGENT_RO_DATABASE_URL", "EVAL_USE_LIVE_MODEL"] as const) {
      saved.set(key, process.env[key]);
    }
    try {
      for (const flag of FLAGS) process.env[flag] = "true";
      delete process.env["AGENT_RO_DATABASE_URL"];
      delete process.env["EVAL_USE_LIVE_MODEL"];
      // Throws before any DB/gateway work (missing role URL); the scrub
      // already ran, so the flags stay deleted on the way out.
      await expect(buildLiveAdapter(process.cwd())).rejects.toThrow();
      for (const flag of FLAGS) {
        expect(flag in process.env).toBe(false);
      }
    } finally {
      for (const [key, prior] of saved) {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
    }
  });
});

describe("createEvalEmitter (B6)", () => {
  it("writes a reconciling run_done through the real redacted writer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-emitter-"));
    const emit = createEvalEmitter(dir, {
      runId: "run-eval-1",
      threadId: "thread-eval-1",
      userId: "user-eval-1",
      role: "hr",
    });
    emit.emitLlmCall("propose", {
      model: "openai/gpt-oss-120b",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0,
      pricingKnown: true,
    });
    emit.emitToolCall("run", "run_query", { rowCount: 1 });
    emit.emitRunDone("error");
    const lines = readFileSync(path.join(dir, "run-eval-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    const done = JSON.parse(lines[2] as string) as {
      type?: unknown;
      role?: unknown;
      payload?: unknown;
    };
    expect(done.type).toBe("run_done");
    expect(done.role).toBe("hr");
    expect(done.payload).toMatchObject({
      status: "error",
      llmCalls: 1,
      toolCalls: 1,
      sqlAttempts: 1,
      sqlFailures: 0,
    });
  });

  it("redacts PII through the eval emitter before anything reaches disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-emitter-pii-"));
    const emit = createEvalEmitter(dir, {
      runId: "run-eval-2",
      threadId: "thread-eval-2",
      userId: "user-eval-2",
      role: "sales_south",
    });
    emit({
      node: "run",
      type: "tool_call",
      durationMs: 1,
      payload: { tool: "run_query", note: "lien he 0912345678 nhe" },
    });
    const content = readFileSync(path.join(dir, "run-eval-2.jsonl"), "utf8");
    expect(content).not.toContain("0912345678");
    expect(content).toContain("[MASKED_PHONE]");
  });

  it("keeps eval export-disabled even with every tracing flag and key set", () => {
    const env = {
      LANGSMITH_TRACING: "true",
      LANGSMITH_TRACING_V2: "true",
      LANGCHAIN_TRACING: "true",
      LANGCHAIN_TRACING_V2: "true",
      LANGSMITH_API_KEY: "sk-test-not-real",
      LANGSMITH_PROJECT: "se373-analytics-agent",
      EVAL_USE_LIVE_MODEL: "1",
      AGENT_MODEL_API_KEY: "sk-live-opted-in",
    } as unknown as NodeJS.ProcessEnv;
    // The env as given WOULD enable export through the product gate...
    expect(isLangSmithEnabled(env)).toBe(true);
    // ...but the eval guard scrubs first, so no eval run can export.
    prepareEvalEnv(env);
    expect(isLangSmithEnabled(env)).toBe(false);
    for (const flag of FLAGS) {
      expect(flag in env).toBe(false);
    }
    expect(env["AGENT_MODEL_API_KEY"]).toBe("sk-live-opted-in");
  });
});
