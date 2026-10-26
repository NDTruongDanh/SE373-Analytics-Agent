// D-20 conformance legs (01-15, wave 6): the SSE host validates every emit
// against the per-event zod schemas exported by @se373/contracts — no direct
// zod import in apps/api, no hand-written structural validator on this path.
// A schema-invalid payload must degrade to failed, never hit the wire raw.

import { describe, expect, it } from "vitest";
import {
  SSE_EVENT_NAMES,
  SseCompletedEventSchema,
  type SseEnvelope,
  type SseEventName,
} from "@se373/contracts";
import { emitSseEvent, SSE_ALLOWLIST as HOST_ALLOWLIST } from "../src/sse.js";

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
});
