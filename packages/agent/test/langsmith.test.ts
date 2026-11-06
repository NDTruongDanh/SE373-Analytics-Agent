// D-03/D-04 captured-payload proofs (Phase 3, plan 03-02 tracer): the
// anonymizing client drops row arrays, redacts PII canaries, keeps
// counts/columns/metadata, fails closed on processor throw, and the
// explicit tracer suppresses the bare env auto-tracer by handler name.
// All DB-free with a stub fetch transport; never a live key or network.
//
// Canary literals below are invented for this proof (never seed data) so
// the DB-07 seed-hiding scan stays green.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { Client } from "langsmith";
import {
  buildLangSmithRunConfig,
  createLangSmithTracer,
  flushLangSmith,
  isLangSmithEnabled,
  langSmithClientCountForTests,
  LANGSMITH_ENV_FLAGS,
  piiSafeProcessor,
  resetLangSmithForTests,
  scrubLangSmithEnv,
  scrubSerialized,
} from "../src/telemetry/langsmith.js";

const CANARY_PHONE = "0912 345 678";
const CANARY_EMAIL = "canary.k27@example.vn";
const CANARY_SALARY = 987654321;

const ENABLED_ENV = {
  LANGSMITH_TRACING: "true",
  LANGSMITH_API_KEY: "test-key-not-real",
  LANGSMITH_PROJECT: "se373-test-project",
} as unknown as NodeJS.ProcessEnv;

interface CapturedCall {
  url: string;
  body: string;
}

/** Stub transport: records every outbound body, answers 200, never network. */
function stubTransport(captured: CapturedCall[]): typeof fetch {
  return (async (url: unknown, init?: { body?: unknown }) => {
    const body = (init as { body?: unknown } | undefined)?.body;
    let text = "";
    if (typeof body === "string") {
      text = body;
    } else if (body instanceof ReadableStream) {
      // Run upload posts multipart with a streaming body; consume it fully.
      const chunks: Buffer[] = [];
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
    captured.push({ url: String(url), body: text });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function canaryPayload(): Record<string, unknown> {
  return {
    question: `How many orders for ${CANARY_PHONE}?`,
    outputs: {
      columns: ["status", "n"],
      rows: [
        { status: "shipped", n: 3, phone: CANARY_PHONE, salary: CANARY_SALARY },
        { status: "pending", n: 1, email: CANARY_EMAIL },
      ],
      rowCount: 2,
      truncated: false,
      maskedColumns: ["customers.phone"],
      answerText: `Contact ${CANARY_EMAIL} about ${CANARY_PHONE}.`,
      resultPreview: [{ status: "shipped", phone: CANARY_PHONE }],
    },
    metadata: {
      runId: "run-proof-1",
      threadId: "chat:proof:1",
      userId: "proof-user",
      role: "sales_south",
      ucId: "tracer",
      maskedColumns: ["customers.phone"],
    },
  };
}

describe("isLangSmithEnabled", () => {
  it("is true only when all three vars are set", () => {
    expect(isLangSmithEnabled(ENABLED_ENV)).toBe(true);
  });

  it("is false when any var is missing or tracing is not enabled", () => {
    const base = { ...ENABLED_ENV } as Record<string, string>;
    for (const key of ["LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT"]) {
      const missing = { ...base };
      delete missing[key];
      expect(isLangSmithEnabled(missing as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(
      isLangSmithEnabled({ ...base, LANGSMITH_TRACING: "false" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(isLangSmithEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("scrubLangSmithEnv", () => {
  it("deletes all four tracing flags and leaves the rest", () => {
    const env = {
      LANGSMITH_TRACING: "true",
      LANGSMITH_TRACING_V2: "true",
      LANGCHAIN_TRACING: "true",
      LANGCHAIN_TRACING_V2: "true",
      AGENT_MODEL_API_KEY: "keep-me",
    } as unknown as NodeJS.ProcessEnv;
    scrubLangSmithEnv(env);
    for (const flag of LANGSMITH_ENV_FLAGS) {
      expect(flag in env).toBe(false);
    }
    expect(env["AGENT_MODEL_API_KEY"]).toBe("keep-me");
  });
});

describe("createLangSmithTracer", () => {
  it("returns undefined when the gate is closed", () => {
    resetLangSmithForTests();
    expect(createLangSmithTracer({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("builds a project-scoped tracer when enabled", () => {
    resetLangSmithForTests();
    const tracer = createLangSmithTracer(ENABLED_ENV, {
      apiKey: "test-key-not-real",
      fetchImplementation: stubTransport([]),
    });
    expect(tracer).toBeDefined();
    expect(tracer?.name).toBe("langchain_tracer");
    expect(tracer?.projectName).toBe("se373-test-project");
    resetLangSmithForTests();
  });

  it("shares one client per endpoint/transport across tracers", () => {
    resetLangSmithForTests();
    const fetch = stubTransport([]);
    const first = createLangSmithTracer(ENABLED_ENV, {
      apiKey: "test-key-not-real",
      fetchImplementation: fetch,
    });
    const second = createLangSmithTracer(ENABLED_ENV, {
      apiKey: "test-key-not-real",
      fetchImplementation: fetch,
    });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Same config: one shared Client, one tracked entry.
    expect(first?.client).toBe(second?.client);
    expect(langSmithClientCountForTests()).toBe(1);
    // A different apiUrl (or transport) gets its own client instead.
    const other = createLangSmithTracer(ENABLED_ENV, {
      apiKey: "test-key-not-real",
      apiUrl: "https://other.invalid",
      fetchImplementation: stubTransport([]),
    });
    expect(other).toBeDefined();
    expect(other?.client).not.toBe(first?.client);
    expect(langSmithClientCountForTests()).toBe(2);
    resetLangSmithForTests();
  });
});

describe("piiSafeProcessor", () => {
  it("drops row arrays but keeps rowCount, columns, truncated, maskedColumns", () => {
    const out = piiSafeProcessor(canaryPayload());
    const outputs = out["outputs"] as Record<string, unknown>;
    expect(outputs["rows"]).toEqual([]);
    expect(outputs["resultPreview"]).toEqual([]);
    expect(outputs["rowCount"]).toBe(2);
    expect(outputs["columns"]).toEqual(["status", "n"]);
    expect(outputs["truncated"]).toBe(false);
    expect(outputs["maskedColumns"]).toEqual(["customers.phone"]);
  });

  it("removes every canary and row value from a full LangGraph state shape", () => {
    const out = piiSafeProcessor(canaryPayload());
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(CANARY_PHONE);
    expect(serialized).not.toContain(CANARY_EMAIL);
    expect(serialized).not.toContain(String(CANARY_SALARY));
    // Metadata survives for UI filtering.
    const metadata = out["metadata"] as Record<string, unknown>;
    expect(metadata["runId"]).toBe("run-proof-1");
    expect(metadata["threadId"]).toBe("chat:proof:1");
    expect(metadata["maskedColumns"]).toEqual(["customers.phone"]);
  });

  it("collapses circular input to a marker and still redacts canaries", () => {
    const circular: Record<string, unknown> = { note: `call ${CANARY_PHONE}` };
    circular["self"] = circular;
    const out = piiSafeProcessor(circular);
    expect(out["self"]).toBe("[Circular]");
    expect(JSON.stringify(out)).not.toContain(CANARY_PHONE);
  });

  it("fails closed to {} on unserializable input instead of sending raw", () => {
    const big = { rows: [{ n: 1 }], marker: 10n as unknown as number };
    expect(piiSafeProcessor(big as Record<string, unknown>)).toEqual({});
  });
});

describe("scrubSerialized", () => {
  it("drops kwargs.configuration structurally so a live model key never uploads", () => {
    const out = scrubSerialized({
      lc: 1,
      type: "constructor",
      id: ["langchain", "chat_models", "openai", "ChatOpenAI"],
      kwargs: {
        model: "openai/gpt-oss-120b",
        temperature: 0,
        configuration: {
          baseURL: "https://example.invalid/v1",
          apiKey: "sk-live-not-real-but-shaped-like-a-secret",
        },
      },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sk-live-not-real-but-shaped-like-a-secret");
    expect(serialized).not.toContain("configuration");
    // Debuggable model identity survives.
    expect((out["kwargs"] as Record<string, unknown>)["model"]).toBe(
      "openai/gpt-oss-120b",
    );
  });

  it("redacts canary text inside fake-model canned responses", () => {
    const out = scrubSerialized({
      lc: 1,
      type: "constructor",
      id: ["langchain", "chat_models", "fake-list", "FakeListChatModel"],
      kwargs: { responses: [`Mail ${CANARY_EMAIL} about ${CANARY_PHONE}.`] },
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(CANARY_PHONE);
    expect(serialized).not.toContain(CANARY_EMAIL);
  });

  it("fails closed to {} on non-object input", () => {
    expect(scrubSerialized(null)).toEqual({});
    expect(scrubSerialized("model")).toEqual({});
  });
});

describe("anonymized client upload over a stub transport", () => {
  it("posts only sanitized run bodies with counts/columns/metadata intact", async () => {
    resetLangSmithForTests();
    const captured: CapturedCall[] = [];
    const client = new Client({
      apiKey: "test-key-not-real",
      anonymizer: piiSafeProcessor,
      omitTracedRuntimeInfo: true,
      fetchImplementation: stubTransport(captured),
    });
    const payload = canaryPayload();
    await client.createRun({
      id: randomUUID(),
      name: "proof-run",
      inputs: { question: payload["question"] },
      outputs: payload["outputs"] as Record<string, unknown>,
      extra: { metadata: payload["metadata"] },
      session_name: "se373-test-project",
      run_type: "chain",
      trace_id: randomUUID(),
      dotted_order: `${Date.now()}000000`,
      start_time: Date.now(),
    });
    await client.awaitPendingTraceBatches();

    expect(captured.length).toBeGreaterThan(0);
    const bodies = captured.map((call) => call.body).join("\n");
    expect(bodies).not.toContain(CANARY_PHONE);
    expect(bodies).not.toContain(CANARY_EMAIL);
    expect(bodies).not.toContain(String(CANARY_SALARY));
    expect(bodies).toContain("se373-test-project");
    expect(bodies).toContain("customers.phone");
    expect(bodies).toContain("run-proof-1");
  });

  it("redacts a traced fake-model invoke end to end", async () => {
    resetLangSmithForTests();
    const captured: CapturedCall[] = [];
    const tracer = createLangSmithTracer(ENABLED_ENV, {
      apiKey: "test-key-not-real",
      fetchImplementation: stubTransport(captured),
    });
    expect(tracer).toBeDefined();
    const model = new FakeListChatModel({
      responses: [`Mail ${CANARY_EMAIL} the total for ${CANARY_PHONE}.`],
    });
    await model.invoke(`Count orders (ref ${CANARY_PHONE})`, {
      callbacks: tracer ? [tracer] : undefined,
    });
    await flushLangSmith();

    expect(captured.length).toBeGreaterThan(0);
    const bodies = captured.map((call) => call.body).join("\n");
    expect(bodies).not.toContain(CANARY_PHONE);
    expect(bodies).not.toContain(CANARY_EMAIL);
    // The fake's canned responses travel in `serialized`, which the SDK
    // never passes through the client anonymizer: the tracer-level scrub
    // redacts them instead (masked markers prove the scrub path ran).
    expect(bodies).toContain("MASKED_EMAIL");
    expect(bodies).toContain("MASKED_PHONE");
    resetLangSmithForTests();
  });
});

describe("explicit tracer suppresses the bare env auto-tracer", () => {
  it("adds no second langchain_tracer when ours is already present", () => {
    resetLangSmithForTests();
    const saved = new Map<string, string | undefined>();
    for (const flag of LANGSMITH_ENV_FLAGS) {
      saved.set(flag, process.env[flag]);
      process.env[flag] = "true";
    }
    try {
      const tracer = createLangSmithTracer(
        {
          ...ENABLED_ENV,
          LANGSMITH_API_KEY: "test-key-not-real",
        } as NodeJS.ProcessEnv,
        { apiKey: "test-key-not-real", fetchImplementation: stubTransport([]) },
      );
      expect(tracer).toBeDefined();
      const withOurs = CallbackManager.configure(tracer ? [tracer] : []);
      const names = (withOurs?.handlers ?? []).map((handler) => handler.name);
      expect(names).toEqual(["langchain_tracer"]);
      expect(withOurs?.handlers[0]).toBe(tracer);

      // Contrast: env alone mints a bare tracer with no anonymizer, which is
      // exactly the leak path the explicit callbacks close.
      const bare = CallbackManager.configure(undefined, undefined);
      const bareNames = (bare?.handlers ?? []).map((handler) => handler.name);
      expect(bareNames).toContain("langchain_tracer");
    } finally {
      for (const flag of LANGSMITH_ENV_FLAGS) {
        const prior = saved.get(flag);
        if (prior === undefined) delete process.env[flag];
        else process.env[flag] = prior;
      }
      resetLangSmithForTests();
    }
  });
});

describe("buildLangSmithRunConfig", () => {
  it("carries runId, tags, and metadata with column names only", () => {
    const tracer = createLangSmithTracer(ENABLED_ENV, {
      apiKey: "test-key-not-real",
      fetchImplementation: stubTransport([]),
    });
    expect(tracer).toBeDefined();
    const masked = ["customers.phone"];
    const config = buildLangSmithRunConfig(tracer!, {
      runId: "run-cfg-1",
      threadId: "chat:u:run-cfg-1",
      userId: "u",
      role: "sales_south",
      ucId: "",
      maskedColumns: masked,
    });
    expect(config.runId).toBe("run-cfg-1");
    expect(config.callbacks).toEqual([tracer]);
    expect(config.tags).toContain("se373");
    expect(config.tags).toContain("uc:tracer");
    expect(config.metadata).toMatchObject({
      runId: "run-cfg-1",
      threadId: "chat:u:run-cfg-1",
      userId: "u",
      role: "sales_south",
      ucId: "",
    });
    expect(config.metadata["maskedColumns"]).toEqual(["customers.phone"]);
    expect(config.metadata["maskedColumns"]).not.toBe(masked);
    resetLangSmithForTests();
  });
});
