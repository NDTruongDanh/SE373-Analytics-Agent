// Spans tests (AGENT-07, 01-12): parent-child linkage across nested spans,
// attempt propagation, redaction proof through the real TraceWriter to a
// temp file, count/column-only tool payloads, and both sibling-plan seam
// shapes. No network, no database.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SpanEmitter, SpanEvent } from "../src/state.js";
import type { ExecutorSpan, SpanSink } from "../src/queryExecutor/executor.js";
import { createSpanEmitter } from "../src/telemetry/spans.js";

const SYNTHETIC_PHONE = "0901 234 567";
const SYNTHETIC_EMAIL = "nguoi.moi@example.vn";

function makeEmitter() {
  const tracesDir = mkdtempSync(path.join(tmpdir(), "spans-"));
  const emit = createSpanEmitter({
    runId: "run-spans-1",
    threadId: "thread-spans-1",
    userId: "user-spans-1",
    role: "sales_south",
    tracesDir,
  });
  const readEvents = (): Record<string, unknown>[] =>
    readFileSync(path.join(tracesDir, "run-spans-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { emit, readEvents };
}

describe("span emitter", () => {
  it("satisfies both sibling-plan seam shapes", () => {
    const { emit } = makeEmitter();
    const asEmitter: SpanEmitter = emit;
    const asSink: SpanSink = emit;
    expect(typeof asEmitter).toBe("function");
    expect(typeof asSink).toBe("function");
  });

  it("links parent and child across nested spans and returns the value", async () => {
    const { emit, readEvents } = makeEmitter();
    const value = await emit.span(
      "understand",
      "node_done",
      async (child) => {
        child({
          node: "retrieve",
          type: "tool_call",
          durationMs: 5,
          payload: { tool: "describe_table", table: "orders" },
        });
        return "ok";
      },
      { attempt: 1 },
    );
    expect(value).toBe("ok");
    const events = readEvents();
    expect(events).toHaveLength(3);
    const start = events.find(
      (event) => (event["payload"] as { phase?: string })?.phase === "start",
    );
    const end = events.find(
      (event) => (event["payload"] as { phase?: string })?.phase === "end",
    );
    const childEvent = events.find((event) => event["node"] === "retrieve");
    expect(start?.["spanId"]).toBeDefined();
    expect(childEvent?.["parentSpanId"]).toBe(start?.["spanId"]);
    expect(end?.["parentSpanId"]).toBe(start?.["spanId"]);
    expect((end?.["payload"] as { ok?: boolean })?.ok).toBe(true);
    expect(start?.["attempt"]).toBe(1);
    expect(end?.["attempt"]).toBe(1);
  });

  it("writes an end event and rethrows on failure", async () => {
    const { emit, readEvents } = makeEmitter();
    await expect(
      emit.span("answer", "node_done", async () => {
        throw new Error("synthesis blew up");
      }),
    ).rejects.toThrow("synthesis blew up");
    const events = readEvents();
    expect(events).toHaveLength(2);
    expect((events[1]["payload"] as { ok?: boolean })?.ok).toBe(false);
  });

  it("propagates attempt on direct emits and accepts executor spans", () => {
    const { emit, readEvents } = makeEmitter();
    const executorEvent: ExecutorSpan = {
      node: "run",
      type: "tool_call",
      attempt: 2,
      durationMs: 7,
      payload: { tool: "run_query", rowCount: 3 },
    };
    emit(executorEvent);
    const direct: SpanEvent = {
      node: "describe",
      type: "tool_call",
      durationMs: 4,
      attempt: 3,
      payload: { tool: "describe_table", table: "orders" },
    };
    emit(direct);
    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[0]["attempt"]).toBe(2);
    expect(events[1]["attempt"]).toBe(3);
  });

  it("emits skill_call spans for the loader path", () => {
    const { emit, readEvents } = makeEmitter();
    emit.emitSkillCall("text-to-sql", { attempt: 0 });
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      node: "skills",
      type: "skill_call",
      payload: { skill: "text-to-sql" },
    });
  });

  it("carries counts and column names only in tool payloads", () => {
    const { emit, readEvents } = makeEmitter();
    emit.emitToolCall("run", "run_query", {
      rowCount: 2,
      columns: ["status", "n"],
    });
    const events = readEvents();
    expect(events[0]["payload"]).toEqual({
      tool: "run_query",
      rowCount: 2,
      columns: ["status", "n"],
    });
  });

  it("redacts synthetic PII before write (markers present, literals absent)", () => {
    const { emit, readEvents } = makeEmitter();
    emit({
      node: "run",
      type: "tool_call",
      durationMs: 1,
      payload: { note: `call ${SYNTHETIC_PHONE} or ${SYNTHETIC_EMAIL}` },
    });
    const events = readEvents();
    expect(events).toHaveLength(1);
    const raw = JSON.stringify(events[0]);
    expect(raw).not.toContain(SYNTHETIC_PHONE);
    expect(raw).not.toContain(SYNTHETIC_EMAIL);
    expect(raw).toContain("[MASKED_PHONE]");
    expect(raw).toContain("[MASKED_EMAIL]");
  });
});
