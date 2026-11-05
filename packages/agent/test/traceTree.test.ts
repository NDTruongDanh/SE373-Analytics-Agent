import { describe, expect, it } from "vitest";
// Import through the shared subpath (the plan's done-criteria: the builder
// must be importable via @shared/agent/telemetry).
import {
  buildTraceTree,
  deriveSummary,
  joinAudits,
  nestEvents,
} from "../src/telemetry/spans.js";
import type { TreeInputEvent } from "../src/telemetry/spans.js";

// All fixtures below are synthetic and PII-free: invented runIds, column
// names, and counts only — no phones, emails, or row values.

const RUN_ID = "run-fixture-viewer-1";

function event(partial: Partial<TreeInputEvent> & { type: string }): TreeInputEvent {
  return {
    node: "answer",
    durationMs: 0,
    ...partial,
  };
}

describe("traceTree nesting", () => {
  it("nests events by parentSpanId into a tree", () => {
    const events: TreeInputEvent[] = [
      event({ spanId: "root-a", type: "node_done" }),
      event({ spanId: "child-a1", parentSpanId: "root-a", type: "tool_call" }),
      event({
        spanId: "grandchild-a1",
        parentSpanId: "child-a1",
        type: "llm_call",
      }),
      event({ spanId: "root-b", type: "node_done" }),
    ];
    const roots = nestEvents(events);
    expect(roots.map((root) => root.spanId)).toEqual(["root-a", "root-b"]);
    expect(roots[0]?.children.map((child) => child.spanId)).toEqual(["child-a1"]);
    expect(roots[0]?.children[0]?.children.map((child) => child.spanId)).toEqual([
      "grandchild-a1",
    ]);
    expect(roots[1]?.children).toEqual([]);
  });

  it("orders siblings by attempt then timestamp", () => {
    const events: TreeInputEvent[] = [
      event({ spanId: "root", type: "node_done" }),
      event({
        spanId: "retry",
        parentSpanId: "root",
        type: "tool_call",
        attempt: 1,
        ts: "2026-11-05T00:00:02.000Z",
      }),
      event({
        spanId: "first",
        parentSpanId: "root",
        type: "tool_call",
        attempt: 0,
        ts: "2026-11-05T00:00:03.000Z",
      }),
      event({
        spanId: "first-early",
        parentSpanId: "root",
        type: "tool_call",
        attempt: 0,
        ts: "2026-11-05T00:00:01.000Z",
      }),
    ];
    const roots = nestEvents(events);
    expect(roots[0]?.children.map((child) => child.spanId)).toEqual([
      "first-early",
      "first",
      "retry",
    ]);
  });

  it("treats orphans with unknown parents as roots", () => {
    const roots = nestEvents([
      event({ spanId: "orphan", parentSpanId: "missing", type: "tool_call" }),
    ]);
    expect(roots.map((root) => root.spanId)).toEqual(["orphan"]);
  });
});

describe("traceTree audit join", () => {
  it("keeps only lines for the run with the viewer shape", () => {
    const audits = joinAudits(RUN_ID, [
      {
        runId: RUN_ID,
        tool: "run_query",
        decision: "allow",
        rowCount: 4,
        durationMs: 12,
        maskedColumns: ["customers.phone"],
        rowScopeApplied: [{ table: "orders", column: "region" }],
      },
      {
        runId: "run-other",
        tool: "run_query",
        decision: "allow",
        rowCount: 9,
        durationMs: 3,
        maskedColumns: [],
        rowScopeApplied: [],
      },
      { runId: RUN_ID, tool: "run_query" },
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      tool: "run_query",
      decision: "allow",
      rowCount: 4,
      durationMs: 12,
      maskedColumns: ["customers.phone"],
      rowScopeApplied: [{ table: "orders", column: "region" }],
    });
  });
});

describe("traceTree summary", () => {
  function summaryEvents(): TreeInputEvent[] {
    return [
      event({
        spanId: "llm-1",
        type: "llm_call",
        payload: { model: "agent-default", inputTokens: 10, outputTokens: 5 },
      }),
      event({
        spanId: "tool-1",
        type: "tool_call",
        payload: { tool: "run_query", maskedColumns: ["customers.phone"] },
      }),
      event({
        spanId: "tool-2",
        type: "tool_call",
        payload: {
          tool: "run_query",
          maskedColumns: ["customers.phone", "orders.region"],
        },
      }),
      event({ spanId: "approval-1", type: "approval_requested", payload: { kind: "approval" } }),
      event({
        spanId: "approval-2",
        type: "approval_decided",
        payload: { kind: "approval", decision: "provided" },
      }),
      event({
        spanId: "done",
        type: "run_done",
        payload: {
          status: "ok",
          llmCalls: 1,
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostUsd: 0,
          toolCalls: 2,
          sqlAttempts: 2,
          sqlFailures: 0,
        },
      }),
    ];
  }

  it("derives tokens, cost, SQL failures, masked columns, and approvals", () => {
    const summary = deriveSummary(summaryEvents());
    expect(summary).toEqual({
      status: "ok",
      llmCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0,
      toolCalls: 2,
      sqlAttempts: 2,
      sqlFailures: 0,
      maskedColumns: ["customers.phone", "orders.region"],
      approvals: { requested: 1, decided: 1 },
    });
  });

  it("returns null when no run_done event exists", () => {
    expect(
      deriveSummary([event({ spanId: "only", type: "tool_call", payload: {} })]),
    ).toBeNull();
  });

  it("builds the full tree with joined audits and summary", () => {
    const events = summaryEvents();
    const tree = buildTraceTree(RUN_ID, events, [
      {
        runId: RUN_ID,
        tool: "run_query",
        decision: "allow",
        rowCount: 4,
        durationMs: 12,
        maskedColumns: [],
        rowScopeApplied: [],
      },
    ]);
    expect(tree.runId).toBe(RUN_ID);
    expect(tree.eventCount).toBe(events.length);
    expect(tree.roots).toHaveLength(events.length);
    expect(tree.audits).toHaveLength(1);
    expect(tree.summary?.status).toBe("ok");
    expect(tree.summary?.approvals).toEqual({ requested: 1, decided: 1 });
  });
});
