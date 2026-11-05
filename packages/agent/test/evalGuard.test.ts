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
import {
  buildLiveAdapter,
  prepareEvalEnv,
} from "../../../evals/run.js";

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
