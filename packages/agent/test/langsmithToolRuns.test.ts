// #97: MCP calls appear as LangSmith tool runs, and LLM runs carry cost
// from policies/model_pricing.yaml. DB-free and network-free: a stub fetch
// transport captures every upload. Canary literals are invented for this
// proof (never seed data).
import { describe, expect, it, vi } from "vitest";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { AIMessage } from "@langchain/core/messages";
import { dbToolError } from "@shared/contracts";
import {
  attachUsageCost,
  createLangSmithTracer,
  flushLangSmith,
  resetLangSmithForTests,
} from "../src/telemetry/langsmith.js";
import {
  hasPiiSafeTracer,
  summarizeMcpResult,
  withMcpToolRun,
} from "../src/telemetry/toolRuns.js";
import { runUsage } from "../../../evals/run.js";

const CANARY_PHONE = "0912 345 678";
const CANARY_EMAIL = "canary.t97@example.vn";

const ENABLED_ENV = {
  LANGSMITH_TRACING: "true",
  LANGSMITH_API_KEY: "test-key-not-real",
  LANGSMITH_PROJECT: "se373-test-project",
} as unknown as NodeJS.ProcessEnv;

/** Stub transport: records every outbound body, answers 200, never network. */
function stubTransport(bodies: string[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = init?.body;
    if (typeof body === "string") {
      bodies.push(body);
    } else if (body instanceof ReadableStream) {
      const chunks: Buffer[] = [];
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
      bodies.push(Buffer.concat(chunks).toString("utf8"));
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function tracerWith(bodies: string[]) {
  resetLangSmithForTests();
  const tracer = createLangSmithTracer(ENABLED_ENV, {
    apiKey: "test-key-not-real",
    fetchImplementation: stubTransport(bodies),
  });
  if (!tracer) throw new Error("tracer gate unexpectedly closed");
  return tracer;
}

const ROW_RESULT = JSON.stringify({
  columns: ["name", "phone"],
  rows: [{ name: "Canary", phone: CANARY_PHONE, email: CANARY_EMAIL }],
  rowCount: 1,
  truncated: false,
  maskedColumns: ["customers.phone"],
  durationMs: 4,
});

describe("withMcpToolRun", () => {
  it("uploads a tool run with counts and column names but no row values", async () => {
    const bodies: string[] = [];
    const tracer = tracerWith(bodies);
    const out = await withMcpToolRun(
      [tracer],
      "run_query",
      { sql: "SELECT name FROM public.customers", maxRows: 5, runId: "r-1", userId: "u-1", roleScope: "sales_south" },
      async () => ({ text: ROW_RESULT }),
    );
    await flushLangSmith();

    expect(out.text).toBe(ROW_RESULT);
    const all = bodies.join("\n");
    expect(all).toContain('"run_type":"tool"');
    expect(all).toContain("run_query");
    expect(all).toContain("SELECT name FROM public.customers");
    expect(all).toContain("customers.phone");
    expect(all).toContain('"rowCount":1');
    expect(all).not.toContain(CANARY_PHONE);
    expect(all).not.toContain(CANARY_EMAIL);
    expect(all).not.toContain('"Canary"');
    // Identity travels in headers only, never as tool input.
    expect(all).not.toContain("r-1");
    expect(all).not.toContain("u-1");
    resetLangSmithForTests();
  });

  it("reports a failed call by contract code only and rethrows the original error", async () => {
    const bodies: string[] = [];
    const tracer = tracerWith(bodies);
    const failure = dbToolError("SCOPE_DENIED", `no access for ${CANARY_EMAIL}`);
    await expect(
      withMcpToolRun([tracer], "describe_table", { table: "employees" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await flushLangSmith();

    const all = bodies.join("\n");
    expect(all).toContain("MCP tool describe_table failed (SCOPE_DENIED)");
    expect(all).not.toContain(CANARY_EMAIL);
    expect(all).not.toContain("no access for");
    resetLangSmithForTests();
  });

  it("is a plain passthrough without the PII-safe tracer", async () => {
    const handleToolStart = vi.fn();
    const plain = { name: "plain_handler", handleToolStart };
    const fn = vi.fn(async () => ({ text: ROW_RESULT }));

    expect(hasPiiSafeTracer(undefined)).toBe(false);
    expect(hasPiiSafeTracer([plain])).toBe(false);
    expect(hasPiiSafeTracer(CallbackManager.fromHandlers(plain))).toBe(false);
    await withMcpToolRun(undefined, "run_query", {}, fn);
    await withMcpToolRun([plain], "run_query", {}, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(handleToolStart).not.toHaveBeenCalled();
  });
});

describe("summarizeMcpResult", () => {
  it("keeps counts and names, never rows or chunk text", () => {
    expect(summarizeMcpResult(ROW_RESULT, false)).toEqual({
      ok: true,
      rowCount: 1,
      truncated: false,
      durationMs: 4,
      columns: ["name", "phone"],
      maskedColumns: ["customers.phone"],
      rowsCount: 1,
    });
    expect(
      summarizeMcpResult(
        JSON.stringify({
          table: "customers",
          columns: [
            { name: "customer_id", type: "text", nullable: false, sensitive: false },
            { name: "phone", type: "text", nullable: true, sensitive: true },
          ],
        }),
        false,
      ),
    ).toEqual({ ok: true, table: "customers", columns: ["customer_id", "phone"] });
    expect(
      summarizeMcpResult(JSON.stringify({ chunks: [{ content: CANARY_EMAIL }, {}] }), false),
    ).toEqual({ ok: true, chunksCount: 2 });
    expect(
      summarizeMcpResult(JSON.stringify({ code: "TIMEOUT", message: CANARY_PHONE }), true),
    ).toEqual({ ok: false, code: "TIMEOUT" });
    expect(summarizeMcpResult("not json", false)).toEqual({
      ok: true,
      unparsed: true,
      length: 8,
    });
  });
});

describe("LLM run cost", () => {
  it("adds input/output/total cost for a priced model", () => {
    const run = {
      outputs: {
        generations: [[{ message: { response_metadata: { model_name: "openai/gpt-oss-120b" } } }]],
      },
      extra: {
        metadata: { usage_metadata: { input_tokens: 1_000_000, output_tokens: 1_000_000, total_tokens: 2_000_000 } },
      },
    };
    attachUsageCost(run);
    const usage = run.extra.metadata.usage_metadata as Record<string, number>;
    expect(usage["input_cost"]).toBeCloseTo(0.15, 10);
    expect(usage["output_cost"]).toBeCloseTo(0.6, 10);
    expect(usage["total_cost"]).toBeCloseTo(0.75, 10);
  });

  it("leaves unknown models and missing usage without cost fields", () => {
    const unknown = {
      extra: {
        metadata: {
          ls_model_name: "vendor/unpriced",
          usage_metadata: { input_tokens: 10, output_tokens: 10 },
        },
      },
    };
    attachUsageCost(unknown);
    expect(unknown.extra.metadata.usage_metadata).not.toHaveProperty("total_cost");

    const noUsage: { extra: { metadata: Record<string, unknown> } } = { extra: { metadata: {} } };
    attachUsageCost(noUsage);
    expect(noUsage.extra.metadata).toEqual({});
  });

  it("uploads total_cost on a traced chat model run", async () => {
    const bodies: string[] = [];
    const tracer = tracerWith(bodies);
    const manager = CallbackManager.configure([tracer]);
    const [run] = (await manager?.handleChatModelStart(
      { lc: 1, type: "not_implemented", id: ["fake"] },
      [[new AIMessage("question")]],
    )) ?? [];
    await run?.handleLLMEnd({
      generations: [[
        {
          text: "answer",
          message: new AIMessage({
            content: "answer",
            usage_metadata: { input_tokens: 2000, output_tokens: 1000, total_tokens: 3000 },
            response_metadata: { model_name: "openai/gpt-oss-120b" },
          }),
        },
      ]],
    });
    await flushLangSmith();

    const all = bodies.join("\n");
    expect(all).toContain('"total_cost":0.0009');
    expect(all).toContain('"input_cost":0.0003');
    resetLangSmithForTests();
  });
});

describe("eval runUsage", () => {
  it("sums input and output tokens and carries the estimated cost", () => {
    expect(
      runUsage({ inputTokens: 2152, outputTokens: 1099, estimatedCostUsd: 0.0009822 }),
    ).toEqual({ tokens: 3251, costUsd: 0.0009822 });
  });
});
