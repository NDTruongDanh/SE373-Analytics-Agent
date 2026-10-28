// Resume tests (AGENT-08, 01-12): clarification payloads, stable thread ids,
// and a DB-free MemorySaver proof that interrupt plus Command-resume on the
// same thread_id completes without re-running completed nodes, while a fresh
// thread_id starts clean. No network, no database.

import { describe, expect, it } from "vitest";
import { MemorySaver, StateGraph, StateSchema, START, END } from "@langchain/langgraph";
import * as z from "zod";
import {
  isSameThread,
  makeThreadId,
  pauseForApproval,
  requestClarification,
  resumeDecision,
  THREAD_ID_MAX_LENGTH,
} from "../src/hitl.js";

const ResumeState = new StateSchema({
  hits: z.number().default(0),
  decision: z.string().nullable().default(null),
});

/** Minimal two-node graph: side-effecting node a, interrupting node b. */
function buildGraph(counts: { a: number }) {
  return new StateGraph(ResumeState)
    .addNode("a", async () => {
      counts.a += 1;
      return { hits: 1 };
    })
    .addNode("b", async () => {
      const verdict = pauseForApproval({
        action: "review_sql",
        sql: "SELECT 1",
      });
      return {
        decision: typeof verdict === "string" ? verdict : String(verdict),
      };
    })
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", END)
    .compile({ checkpointer: new MemorySaver() });
}

function interruptedOf(output: unknown): unknown[] | undefined {
  return (output as { __interrupt__?: unknown[] }).__interrupt__;
}

describe("hitl helpers", () => {
  it("builds stable chat thread ids under the limit", () => {
    expect(makeThreadId("u1", "s1")).toBe("chat:u1:s1");
    expect(isSameThread(makeThreadId("u1", "s1"), "chat:u1:s1")).toBe(true);
    expect(isSameThread("chat:u1:s1", "chat:u1:s2")).toBe(false);
    expect(() => makeThreadId("", "s1")).toThrow(/non-empty/);
    expect(() => makeThreadId("u1", "x".repeat(THREAD_ID_MAX_LENGTH))).toThrow(
      /exceeds/,
    );
  });

  it("returns the needs_clarification payload with options", () => {
    expect(
      requestClarification({ reason: "pick a metric", options: ["a", "b"] }),
    ).toEqual({
      status: "needs_clarification",
      reason: "pick a metric",
      sql: null,
      pendingClarification: ["a", "b"],
    });
    expect(
      requestClarification({
        reason: "which table",
        options: ["orders"],
        table: "orders",
      }).table,
    ).toBe("orders");
    expect(() => requestClarification({ reason: "", options: ["a"] })).toThrow(
      /reason/,
    );
    expect(() =>
      requestClarification({ reason: "r", options: [] }),
    ).toThrow(/option/);
  });
});

describe("interrupt plus resume on MemorySaver", () => {
  it("pauses at the interrupt and resumes on the same thread without re-run", async () => {
    const counts = { a: 0 };
    const resume = buildGraph(counts);
    const threadId = makeThreadId("u1", "s1");

    const paused = await resume.invoke({}, { configurable: { thread_id: threadId } });
    expect(interruptedOf(paused)).toHaveLength(1);
    expect(counts.a).toBe(1);
    const state = await resume.getState({ configurable: { thread_id: threadId } });
    expect(state.next).toContain("b");

    const done = (await resume.invoke(resumeDecision("approve"), {
      configurable: { thread_id: threadId },
    })) as { hits: number; decision: string | null };
    expect(done.decision).toBe("approve");
    expect(done.hits).toBe(1);
    // Completed node a did not re-run on resume.
    expect(counts.a).toBe(1);
  });

  it("starts clean on a fresh thread_id (no inherited pause)", async () => {
    const counts = { a: 0 };
    const graph = buildGraph(counts);
    const first = makeThreadId("u1", "s1");
    await graph.invoke({}, { configurable: { thread_id: first } });
    expect(counts.a).toBe(1);

    const second = makeThreadId("u1", "s2");
    const paused = await graph.invoke({}, { configurable: { thread_id: second } });
    // Fresh thread runs node a again and pauses at its own interrupt —
    // it does not inherit the first thread's resumed decision.
    expect(counts.a).toBe(2);
    expect(interruptedOf(paused)).toHaveLength(1);
    const state = await graph.getState({ configurable: { thread_id: second } });
    expect(state.next).toContain("b");
    const values = state.values as { decision: string | null };
    expect(values.decision).toBeNull();
  });
});
