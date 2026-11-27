// D-20 conformance legs (01-15, wave 6): the SSE host validates every emit
// against the per-event zod schemas exported by @shared/contracts — no direct
// zod import in apps/api, no hand-written structural validator on this path.
// A schema-invalid payload must degrade to failed, never hit the wire raw.

import { describe, expect, it } from "vitest";
import type { AgentState } from "@shared/agent";
import {
  SSE_EVENT_NAMES,
  SseCompletedEventSchema,
  type SseEnvelope,
  type SseEventName,
} from "@shared/contracts";
import {
  completionArtifacts,
  completedPayload,
  containsWirePii,
  displayableSql,
  emitSseEvent,
  interruptPayload,
  SSE_ALLOWLIST as HOST_ALLOWLIST,
  vizPayload,
} from "../src/sse.js";

interface CapturedWrite {
  chunks: string[];
}

function fakeResponse(captured: CapturedWrite): {
  res: Parameters<typeof emitSseEvent>[0];
} {
  return {
    res: {
      write: (chunk: string): boolean => {
        captured.chunks.push(chunk);
        return true;
      },
    } as unknown as Parameters<typeof emitSseEvent>[0],
  };
}

function emit(
  event: SseEventName,
  envelope: SseEnvelope,
): { events: string[]; text: string } {
  const captured: CapturedWrite = { chunks: [] };
  const { res } = fakeResponse(captured);
  emitSseEvent(res, event, envelope);
  const text = captured.chunks.join("");
  const events = [...text.matchAll(/^event: ([^\n]+)$/gm)].map((m) => m[1]);
  return { events, text };
}

describe("sse contracts-schema gate (D-20)", () => {
  it("displays only a bounded literal-free SQL proposal", () => {
    const sql = "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status";
    expect(displayableSql(sql)).toBe(sql);
    for (const unsafe of [
      "SELECT * FROM orders WHERE phone = '0901111111'",
      "SELECT * FROM orders WHERE id = 1234",
      "SELECT * FROM orders -- token",
      "SELECT * FROM orders /* secret */",
      'SELECT "private" FROM orders',
      "SELECT * FROM orders WHERE token = $$secret$$",
      "SELECT * FROM orders WHERE id = $1",
      "SELECT status AS arbitrary_secret FROM orders",
      "SELECT * FROM đơn_hàng",
      "DELETE FROM orders",
      "SELECT " + "x".repeat(33) + " FROM orders",
    ]) expect(displayableSql(unsafe)).toBeNull();
  });
  it("emits a schema-valid payload on its allowlisted event", () => {
    const { events, text } = emit("completed", {
      runId: "run-1",
      threadId: "chat:sales_south:run-1",
      data: { status: "ok", toolsCalled: ["list_tables", "run_query"], total: 12 },
    });
    expect(events).toEqual(["completed"]);
    expect(text).toContain("run-1");
  });

  it("withholds a schema-invalid payload via the contracts schema", () => {
    // The gate is the contracts schema itself: an empty runId fails
    // SseCompletedEventSchema (min(1)), so the host must degrade to failed.
    expect(
      SseCompletedEventSchema.safeParse({
        runId: "",
        threadId: "chat:sales_south:run-1",
        event: "completed",
      }).success,
    ).toBe(false);
    const { events, text } = emit("completed", {
      runId: "",
      threadId: "chat:sales_south:run-1",
      data: { status: "ok" },
    });
    expect(events).toEqual(["failed"]);
    expect(text).not.toMatch(/^event: completed$/m);
    expect(text).toContain("withheld");
  });

  it("keeps the host allowlist identical to the contracts event names", () => {
    expect([...HOST_ALLOWLIST]).toEqual([...SSE_EVENT_NAMES]);
    expect(HOST_ALLOWLIST).toHaveLength(9);
  });

  it("formats interruptPayload with strict camelCase and scrubbed reason", () => {
    const payload = interruptPayload({
      action: "review_analysis_plan",
      reason: "Please review the proposed plan before execution",
      pendingClarification: {
        field: "timeRange",
        question: "Select a time range",
        options: ["opt1", "opt2"],
        attempts: 0,
      },
      plan: { metricName: "net_revenue" },
      currentPlan: { metricName: "net_revenue" },
    });
    expect(payload).toEqual({
      action: "review_analysis_plan",
      reason: "Please review the proposed plan before execution",
      pendingClarification: {
        field: "timeRange",
        question: "Select a time range",
        options: ["opt1", "opt2"],
        attempts: 0,
      },
      plan: { metricName: "net_revenue" },
      currentPlan: { metricName: "net_revenue" },
    });
    expect(Object.keys(payload)).toEqual([
      "action",
      "reason",
      "pendingClarification",
      "plan",
      "currentPlan",
    ]);
  });
});

describe("containsWirePii (#115)", () => {
  it.each([
    "metric:net_revenue (score: 0.03278688524590164): Metric",
    "estimatedCostUsd 0.00052410000000001",
    "tỷ lệ 0,0912345678",
    "tổng 10901234567 đơn",
    "4 status groups, 986385 orders",
  ])("does not flag number digits in %s", (text) => {
    expect(containsWirePii(text)).toBe(false);
  });

  it.each([
    "0901234567",
    "liên hệ 0901234567 nhé",
    "SĐT:0901234567",
    "abc0901234567",
    "a,0901234567",
    "028582120590",
    "+84 912 345 678",
    "mail lan@example.com",
  ])("flags phone or email shape in %s", (text) => {
    expect(containsWirePii(text)).toBe(true);
  });

  it("passes a definition answer with a long score but withholds one with a phone", () => {
    const base = { status: "ok", toolsCalled: [], total: 0 };
    expect(
      completedPayload({ ...base, answerText: "x (score: 0.03278688524590164)" }),
    ).toMatchObject({ status: "ok" });
    expect(() =>
      completedPayload({ ...base, answerText: "gọi 0901234567" }),
    ).toThrow(/withheld/);
  });
});

describe("answer artifacts on the SSE boundary", () => {
  const state = {
    status: "ok",
    budgetExceeded: false,
    sql: "-- @citations: metric:orders_count\nSELECT COUNT(*) AS n FROM public.orders",
    semanticChunks: [{ chunkId: "metric:orders_count", text: "Number of orders" }],
    intent: { requestedMetrics: ["orders_count"] },
    tablesUsed: ["orders"],
    resultPreview: [{ n: 12 }],
    resultTruncated: false,
    vizSpec: {
      kind: "insight_report",
      openuiLang: "chart = None",
      report: {
        chartType: "none",
        chartSpec: { chart: "None" },
        chartReason: "One scalar result.",
        insights: [{ claim: "There are 12 orders.", evidence: [{ column: "n", rowKey: "12", value: 12 }] }],
        caveats: [],
      },
    },
  } as unknown as AgentState;

  it("sends verified citations, preview, and UC-03 report", () => {
    expect(completionArtifacts(state)).toMatchObject({
      citations: ["metric:orders_count"], tablesUsed: ["orders"], resultPreview: [{ n: 12 }],
    });
    expect(vizPayload(state)).toMatchObject({ resultPreview: [{ n: 12 }], report: { chartType: "none" } });
  });

  it("withholds unsafe preview/report and all artifacts for restricted results", () => {
    const unsafe = { ...state, resultPreview: [{ phone: "+84 912 345 678" }] } as AgentState;
    expect(completionArtifacts(unsafe)?.resultPreview).toBeUndefined();
    expect(completionArtifacts(unsafe)?.previewWithheld).toBe(true);
    expect(vizPayload(unsafe)).toBeNull();
    expect(completionArtifacts({ ...state, status: "restricted" })).toBeNull();
    expect(vizPayload({ ...state, status: "restricted" })).toBeNull();
  });

  it("ignores ISO date ranges while flagging 10-digit +84 landlines, dedupes citations, and enforces byte limits", () => {
    expect(containsWirePii("Khoảng thời gian 2026-07-01 - 2026-09-30")).toBe(false);
    expect(containsWirePii("+84 28 1234 5678")).toBe(true);

    const dupSql = "-- @citations: metric:orders_count, metric:orders_count\nSELECT COUNT(*) AS n FROM public.orders";
    expect(completionArtifacts({ ...state, sql: dupSql } as AgentState)?.citations).toEqual([
      "metric:orders_count",
    ]);

    const largeUtf8Row = { label: "đ".repeat(32_000) };
    const oversizedPreview = { ...state, resultPreview: [largeUtf8Row] } as AgentState;
    expect(JSON.stringify([largeUtf8Row]).length).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(JSON.stringify([largeUtf8Row]), "utf8")).toBeGreaterThan(60_000);
    expect(completionArtifacts(oversizedPreview)?.resultPreview).toBeUndefined();
    expect(completionArtifacts(oversizedPreview)?.previewWithheld).toBe(true);
    expect(vizPayload(oversizedPreview)).toBeNull();
  });
});
