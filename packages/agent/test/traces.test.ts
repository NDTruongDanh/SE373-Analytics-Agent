import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TraceEventSchema, dbToolError } from "@shared/contracts";
import { MASKED_EMAIL, MASKED_PHONE } from "@shared/access-policy";
import { appendTraceEvent } from "../src/traces/writer.js";
import { buildRootGraph } from "../src/graph.js";
import { TEXT_TO_SQL_UC_ID } from "../src/constants.js";
import { ValidatedQueryExecutor } from "../src/queryExecutor/executor.js";
import { createSpanEmitter } from "../src/telemetry/spans.js";

// TraceWriter suite: span linkage survives the round trip, every
// research-listed phone/email shape comes back marker-only with source
// literals absent, and the file parses as one event per line.

const PHONES = [
  "0901 234 567", // mobile spaced
  "0901234567", // mobile compact
  "032 123 4567", // mobile 03 spaced
  "0587654321", // mobile 05 compact
  "0285 8212 0590", // landline spaced
  "028582120590", // landline compact
  "024 0590 1799", // national 024 spaced
  "+84901234567", // international compact
  "+84 901 234 567", // international spaced
  "0901.234.567", // dotted separators
  "0901-234-567", // dashed separators
];
const EMAIL = "lan@example.com";

function baseEvent(runId: string, payload?: unknown) {
  return {
    runId,
    threadId: "thread-1",
    userId: "demo-user",
    role: "sales_south",
    node: "run",
    type: "tool_call",
    durationMs: 1,
    payload,
  };
}

describe("TraceWriter", () => {
  it("keeps span linkage fields through the round trip", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-link-"));
    const parent = appendTraceEvent(baseEvent("run-link-1"), dir);
    const child = appendTraceEvent(
      { ...baseEvent("run-link-1"), parentSpanId: parent.spanId, attempt: 1 },
      dir,
    );
    const lines = readFileSync(path.join(dir, "run-link-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const [parsedParent, parsedChild] = lines.map((line) =>
      TraceEventSchema.parse(JSON.parse(line)),
    );
    expect(parsedParent.spanId).toBe(parent.spanId);
    expect(parsedParent.parentSpanId).toBeUndefined();
    expect(parsedChild.parentSpanId).toBe(parent.spanId);
    expect(parsedChild.spanId).toBe(child.spanId);
    expect(parsedChild.attempt).toBe(1);
  });

  it.each(PHONES)("redacts phone shape %s with the shared marker", (phone) => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-phone-"));
    const result = appendTraceEvent(
      baseEvent("run-phone-1", { customer: `lien he ${phone} nhe` }),
      dir,
    );
    expect(result.redacted).toBe(true);
    const content = readFileSync(path.join(dir, "run-phone-1.jsonl"), "utf8");
    expect(content).toContain(MASKED_PHONE);
    expect(content).not.toContain(phone);
  });

  it("redacts email addresses with the shared marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-email-"));
    const result = appendTraceEvent(
      baseEvent("run-email-1", { contact: `mail ${EMAIL} di` }),
      dir,
    );
    expect(result.redacted).toBe(true);
    const content = readFileSync(path.join(dir, "run-email-1.jsonl"), "utf8");
    expect(content).toContain(MASKED_EMAIL);
    expect(content).not.toContain(EMAIL);
  });

  it("redacts row-array payloads cell by cell", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-rows-"));
    appendTraceEvent(
      baseEvent("run-rows-1", [
        { status: "completed", phone: "0901234567" },
        { status: "pending", phone: "none" },
      ]),
      dir,
    );
    const content = readFileSync(path.join(dir, "run-rows-1.jsonl"), "utf8");
    expect(content).toContain(MASKED_PHONE);
    expect(content).not.toContain("0901234567");
  });

  it("leaves clean payloads untouched with hit false", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-clean-"));
    const result = appendTraceEvent(
      baseEvent("run-clean-1", { total: 42 }),
      dir,
    );
    expect(result.redacted).toBe(false);
    const content = readFileSync(path.join(dir, "run-clean-1.jsonl"), "utf8");
    expect(content).toContain('"total":42');
  });

  it("writes one contract-valid event per line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-lines-"));
    for (let i = 0; i < 3; i += 1) {
      appendTraceEvent(baseEvent("run-lines-1", { i }), dir);
    }
    const lines = readFileSync(path.join(dir, "run-lines-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = TraceEventSchema.parse(JSON.parse(line));
      expect(parsed.runId).toBe("run-lines-1");
      expect(parsed.spanId).toBeDefined();
    }
  });

  it("carries the full G1/G5 event set contract-valid in one run file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-complete-"));
    const runId = "run-complete-1";
    appendTraceEvent(
      {
        ...baseEvent(runId),
        node: "propose",
        type: "llm_call",
        payload: {
          model: "openai/gpt-oss-120b",
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: 0.00045,
          pricingKnown: true,
        },
      },
      dir,
    );
    appendTraceEvent(
      {
        ...baseEvent(runId),
        node: "run",
        type: "tool_call",
        payload: {
          tool: "run_query",
          rowCount: 2,
          maskedColumns: ["customers.phone"],
          rowScopeApplied: [{ table: "sellers", column: "region_group" }],
        },
      },
      dir,
    );
    appendTraceEvent(
      { ...baseEvent(runId), node: "propose", type: "node_done" },
      dir,
    );
    const lines = readFileSync(path.join(dir, `${runId}.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    const events = lines.map((line) =>
      TraceEventSchema.parse(JSON.parse(line)),
    );
    const llmCall = events.find((event) => event.type === "llm_call");
    expect(llmCall?.payload).toMatchObject({
      model: "openai/gpt-oss-120b",
      inputTokens: 100,
      outputTokens: 50,
      pricingKnown: true,
    });
    const toolCall = events.find(
      (event) =>
        event.type === "tool_call" &&
        (event.payload as { tool?: string })?.tool === "run_query",
    );
    expect(toolCall?.payload).toMatchObject({
      maskedColumns: ["customers.phone"],
      rowScopeApplied: [{ table: "sellers", column: "region_group" }],
    });
  });
});

const E2E_COLUMNS = [
  { name: "id", type: "integer", nullable: false, sensitive: false },
  { name: "status", type: "text", nullable: true, sensitive: false },
  { name: "total", type: "numeric", nullable: true, sensitive: false },
];

const E2E_SQL =
  "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status";

function countedPayload(
  events: { type?: unknown; node?: unknown; payload?: unknown }[],
): {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  sqlAttempts: number;
  sqlFailures: number;
  repairs: number;
} {
  const sums = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    toolCalls: 0,
    sqlAttempts: 0,
    sqlFailures: 0,
    repairs: 0,
  };
  for (const event of bodyOf(events)) {
    const payload =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    if (event.type === "llm_call") {
      sums.llmCalls += 1;
      if (typeof payload["inputTokens"] === "number") {
        sums.inputTokens += payload["inputTokens"] as number;
      }
      if (typeof payload["outputTokens"] === "number") {
        sums.outputTokens += payload["outputTokens"] as number;
      }
      if (typeof payload["estimatedCostUsd"] === "number") {
        sums.estimatedCostUsd += payload["estimatedCostUsd"] as number;
      }
    } else if (event.type === "tool_call") {
      sums.toolCalls += 1;
      if (payload["tool"] === "run_query") {
        sums.sqlAttempts += 1;
        if (payload["ok"] === false) sums.sqlFailures += 1;
      }
    } else if (event.type === "node_done" && event.node === "repair") {
      sums.repairs += 1;
    }
  }
  return sums;
}

function bodyOf<T>(events: T[]): T[] {
  return events.filter(
    (event) => (event as { type?: unknown }).type !== "run_done",
  );
}

// Phase-3 G3 run lifecycle: one finished run writes exactly one run_done
// whose totals reconcile with the run file, under the real principal.
describe("run_done totals", () => {
  it("accumulates llm, tool, repair, and cost signals into one snapshot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-totals-"));
    const emit = createSpanEmitter({
      runId: "run-totals-1",
      threadId: "thread-totals-1",
      userId: "user-totals-1",
      role: "marketing",
      tracesDir: dir,
    });
    emit.emitLlmCall("propose", {
      model: "openai/gpt-oss-120b",
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.00045,
      pricingKnown: true,
      durationMs: 5,
      attempt: 1,
    });
    emit.emitLlmCall("understand", {
      model: "openai/gpt-oss-120b",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.00002,
      pricingKnown: true,
    });
    emit.emitToolCall("run", "run_query", { rowCount: 2, ok: true });
    emit.emitToolCall("describe", "describe_table", {});
    emit({
      node: "repair",
      type: "node_done",
      durationMs: 1,
      payload: { code: "SYNTAX_ERROR", nextAttempt: 2 },
      attempt: 1,
    });
    expect(emit.totals()).toMatchObject({
      llmCalls: 2,
      inputTokens: 110,
      outputTokens: 55,
      toolCalls: 2,
      sqlAttempts: 1,
      sqlFailures: 0,
      repairs: 1,
    });
    expect(emit.totals().estimatedCostUsd).toBeCloseTo(0.00047, 9);
    // Snapshots are copies: mutating the return never moves the roll-up.
    const snap = emit.totals();
    snap.llmCalls = 999;
    expect(emit.totals().llmCalls).toBe(2);

    emit.emitRunDone("ok");
    const lines = readFileSync(
      path.join(dir, "run-totals-1.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(6);
    const events = lines.map((line) =>
      TraceEventSchema.parse(JSON.parse(line)),
    );
    const done = events.filter((event) => event.type === "run_done");
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({
      status: "ok",
      llmCalls: 2,
      inputTokens: 110,
      outputTokens: 55,
      toolCalls: 2,
      sqlAttempts: 1,
      sqlFailures: 0,
      repairs: 1,
    });
    expect(
      (done[0].payload as { estimatedCostUsd?: number }).estimatedCostUsd,
    ).toBeCloseTo(0.00047, 9);
    // The run_done event itself never perturbs the counters.
    expect(emit.totals().llmCalls).toBe(2);
    expect(emit.totals().toolCalls).toBe(2);
  });

  it("writes exactly one reconciling run_done on the text-to-sql ask path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-rundone-"));
    const runId = "run-rundone-1";
    const threadId = "thread-rundone-1";
    const emit = createSpanEmitter({
      runId,
      threadId,
      userId: "user-rundone-1",
      role: "hr",
      tracesDir: dir,
    });
    const executor = new ValidatedQueryExecutor({
      model: {
        withStructuredOutput: () => ({
          invoke: async () => ({
            sql: E2E_SQL,
            tablesUsed: ["orders"],
          }),
        }),
      },
      mcp: {
        call: async (tool: string) => {
          if (tool === "describe_table") {
            return {
              table: "orders",
              columns: E2E_COLUMNS,
              primaryKey: ["id"],
              foreignKeys: [],
            };
          }
          if (tool === "explain_query") {
            return { estimatedCost: 12.5, estimatedRows: 4 };
          }
          if (tool === "run_query") {
            return {
              columns: ["status", "n"],
              rows: [{ status: "completed", n: 7 }],
              rowCount: 1,
              truncated: false,
              maskedColumns: [],
              durationMs: 1,
            };
          }
          throw new Error(`unexpected tool ${tool}`);
        },
      },
      // Same forwarding the entry installs for internally built executors:
      // executor spans ride the run emitter so the roll-up sees them.
      emitSpan: (event) =>
        emit({
          node: event.node,
          type: event.type,
          durationMs: event.durationMs ?? 0,
          payload: event.payload,
          attempt: event.attempt,
        }),
    });
    const graph = buildRootGraph({
      emitSpan: emit,
      textToSql: {
        intentModel: {
          withStructuredOutput: () => ({
            invoke: async () => ({
              metric: "order_count",
              dimensions: ["status"],
              filters: [],
              timeRange: null,
              requestedMetrics: ["order_count"],
              schemaEntities: ["orders"],
              queryMode: "standard_query" as const,
            }),
          }),
        },
        executor,
      },
    });
    const out = await graph.invoke(
      {
        question: "How many orders per status?",
        ucId: TEXT_TO_SQL_UC_ID,
        runId,
        threadId,
      },
      {
        configurable: {
          thread_id: threadId,
          threadId,
          runId,
          userId: "user-rundone-1",
          roleScope: "hr",
          mcpUrl: "http://127.0.0.1:1/mcp",
          token: "stub-token",
          tracesDir: dir,
        },
      },
    );
    expect(out.status).toBe("ok");
    emit.emitRunDone(out.status);

    const content = readFileSync(path.join(dir, `${runId}.jsonl`), "utf8");
    const events = content
      .trim()
      .split("\n")
      .map((line) => TraceEventSchema.parse(JSON.parse(line)));
    const done = events.filter((event) => event.type === "run_done");
    expect(done).toHaveLength(1);
    const expected = countedPayload(
      events as { type?: unknown; node?: unknown; payload?: unknown }[],
    );
    expect(done[0].payload).toMatchObject({
      status: "ok",
      llmCalls: expected.llmCalls,
      inputTokens: expected.inputTokens,
      outputTokens: expected.outputTokens,
      toolCalls: expected.toolCalls,
      sqlAttempts: expected.sqlAttempts,
      sqlFailures: expected.sqlFailures,
      repairs: expected.repairs,
    });
    expect(
      (done[0].payload as { estimatedCostUsd?: number }).estimatedCostUsd,
    ).toBeCloseTo(expected.estimatedCostUsd, 9);
    // Scripted-model path: understand + propose llm calls, describe +
    // explain + run tool calls, one successful SQL attempt, no repairs.
    expect(expected).toMatchObject({
      llmCalls: 2,
      toolCalls: 3,
      sqlAttempts: 1,
      sqlFailures: 0,
      repairs: 0,
    });
    // The real principal stamps every event; no hard-coded literal remains.
    for (const event of events) {
      expect(event.role).toBe("hr");
    }
    expect(content).not.toContain("sales_south");
  });

  it("keeps hard-coded role literals out of every emit path", () => {
    const graphSrc = readFileSync(
      new URL("../src/graph.ts", import.meta.url),
      "utf8",
    );
    const registrySrc = readFileSync(
      new URL("../src/subgraphs/registry.ts", import.meta.url),
      "utf8",
    );
    expect(graphSrc).not.toContain('role: "sales_south"');
    expect(registrySrc).not.toContain('role: "sales_south"');
  });
});

// run_query attempt accounting: every MCP attempt emits one tool_call with
// ok true/false, so sqlAttempts/sqlFailures reconcile with the run file
// while repairs tracks repair node_done independently. Deterministic fakes
// only: no API key, no DB, no network.
describe("run_query attempt accounting", () => {
  const PRINCIPAL = {
    runId: "run-attempts-1",
    userId: "demo-user",
    roleScope: "sales_south",
  };
  const COLUMNS = [
    { name: "id", type: "integer", nullable: false, sensitive: false },
    { name: "status", type: "text", nullable: true, sensitive: false },
  ];

  function scriptedExecutor(
    modelResponses: string[],
    handlers: Record<string, (args: Record<string, unknown>) => unknown>,
    seen: { node?: unknown; type?: unknown; payload?: unknown; attempt?: unknown }[],
  ): ValidatedQueryExecutor {
    const queue = [...modelResponses];
    return new ValidatedQueryExecutor({
      model: {
        withStructuredOutput: () => ({
          invoke: async (input: string) => {
            void input;
            const next = queue.shift();
            if (next === undefined) throw new Error("model responses exhausted");
            return JSON.parse(next) as { sql: string; tablesUsed: string[] };
          },
        }),
      },
      mcp: {
        call: async (tool: string, _args: Record<string, unknown>) => {
          const handler = handlers[tool];
          if (!handler) throw new Error(`unexpected tool ${tool}`);
          return handler(_args);
        },
      },
      emitSpan: (event) => {
        seen.push(event);
        return `span-${seen.length}`;
      },
    });
  }

  function describeHandler(args: Record<string, unknown>): unknown {
    return {
      table: String(args["table"] ?? ""),
      columns: COLUMNS,
      primaryKey: ["id"],
      foreignKeys: [],
    };
  }

  function wiredTotals(
    runId: string,
    seen: { node?: unknown; type?: unknown; payload?: unknown; attempt?: unknown }[],
  ): ReturnType<ReturnType<typeof createSpanEmitter>["totals"]> {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-attempts-"));
    const emit = createSpanEmitter({
      runId,
      threadId: "thread-attempts-1",
      userId: "user-attempts-1",
      role: "hr",
      tracesDir: dir,
    });
    for (const event of seen) {
      emit({
        node: String(event.node ?? "run"),
        type: String(event.type ?? "tool_call"),
        durationMs: 0,
        payload: event.payload,
        attempt: typeof event.attempt === "number" ? event.attempt : 0,
      });
    }
    return emit.totals();
  }

  it("counts a final-attempt non-repairable run_query failure", async () => {
    const seen: {
      node?: unknown;
      type?: unknown;
      payload?: unknown;
      attempt?: unknown;
    }[] = [];
    const executor = scriptedExecutor(
      [JSON.stringify({ sql: E2E_SQL, tablesUsed: ["orders"] })],
      {
        describe_table: describeHandler,
        explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 4 }),
        run_query: () => {
          throw dbToolError("SCOPE_DENIED", "row scope denies south slice");
        },
      },
      seen,
    );
    const result = await executor.run({
      question: "How many orders per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });
    expect(result.status).toBe("restricted");
    const failures = seen.filter(
      (event) =>
        event.type === "tool_call" &&
        (event.payload as { tool?: unknown })?.tool === "run_query",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].payload).toMatchObject({ ok: false, code: "SCOPE_DENIED" });
    expect(
      (failures[0].payload as Record<string, unknown>)["message"],
    ).toBeUndefined();
    expect(wiredTotals("run-attempts-fail", seen)).toMatchObject({
      sqlAttempts: 1,
      sqlFailures: 1,
      repairs: 0,
    });
  });

  it("counts a local guard denial as a repair but not a sqlFailure", async () => {
    const seen: {
      node?: unknown;
      type?: unknown;
      payload?: unknown;
      attempt?: unknown;
    }[] = [];
    const executor = scriptedExecutor(
      [
        JSON.stringify({ sql: "SELECT * FROM ghosts", tablesUsed: ["ghosts"] }),
        JSON.stringify({ sql: E2E_SQL, tablesUsed: ["orders"] }),
      ],
      {
        describe_table: describeHandler,
        explain_query: () => ({ estimatedCost: 12.5, estimatedRows: 4 }),
        run_query: () => ({
          columns: ["status", "n"],
          rows: [{ status: "completed", n: 7 }],
          rowCount: 1,
          truncated: false,
          maskedColumns: [],
          durationMs: 1,
        }),
      },
      seen,
    );
    const result = await executor.run({
      question: "How many orders per status?",
      candidateTables: ["orders"],
      principal: PRINCIPAL,
    });
    expect(result.status).toBe("ok");
    const attempts = seen.filter(
      (event) =>
        event.type === "tool_call" &&
        (event.payload as { tool?: unknown })?.tool === "run_query",
    );
    // The denied proposal never reached MCP: exactly one successful attempt.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].payload).toMatchObject({ ok: true });
    expect(
      seen.filter((event) => event.type === "node_done" && event.node === "repair"),
    ).toHaveLength(1);
    expect(wiredTotals("run-attempts-guard", seen)).toMatchObject({
      sqlAttempts: 1,
      sqlFailures: 0,
      repairs: 1,
    });
  });
});
