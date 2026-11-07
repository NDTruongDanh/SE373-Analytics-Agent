import { describe, expect, it, vi } from "vitest";
import { SseParser, postStream, readEventStream } from "../src/stream.js";

const frame = (event: string, data: unknown = {}) =>
  `event: ${event}\r\ndata: ${JSON.stringify({ runId: "r1", threadId: "t1", event, data })}\r\n\r\n`;

describe("SSE stream", () => {
  it("parses chunk boundaries, CRLF and multiple frames", () => {
    const events: string[] = [];
    const parser = new SseParser((event) => events.push(event.event));
    const source = frame("intent_parsed") + frame("completed", { answerText: "Xin chào" });
    for (const char of source) parser.push(char);
    parser.finish();
    expect(events).toEqual(["intent_parsed", "completed"]);
  });

  it("rejects invalid JSON, unknown names and mismatching event headers", () => {
    expect(() => new SseParser(() => {}).push("event: completed\ndata: {\n\n")).toThrow();
    expect(() => new SseParser(() => {}).push(frame("unknown"))).toThrow();
    expect(() => new SseParser(() => {}).push(frame("completed").replace("event: completed", "event: failed"))).toThrow();
  });

  it("rejects truncated frames and responses without SSE", async () => {
    const parser = new SseParser(() => {});
    parser.push("event: completed\ndata: {");
    expect(() => parser.finish()).toThrow();
    await expect(readEventStream(new Response("no", { status: 500 }), () => {})).rejects.toThrow("500");
    await expect(readEventStream(new Response("no"), () => {})).rejects.toThrow();
  });

  it.each(["malformed", "identity"])("cancels on %s errors without masking them", async (kind) => {
    const original = new Error("identity mismatch");
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(kind === "malformed" ? "event: completed\ndata: {\n\n" : frame("completed")));
      },
      cancel,
    });
    await expect(readEventStream(new Response(body, { headers: { "content-type": "text/event-stream" } }),
      () => { throw original; })).rejects.toThrow(kind === "malformed" ? "Phản hồi từ máy chủ không hợp lệ." : original);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("posts JSON and delivers the stream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(frame("completed"), {
      headers: { "content-type": "text/event-stream" },
    }));
    try {
      const events: string[] = [];
      const controller = new AbortController();
      await postStream("/api/runs/r1/resume", { value: "Nam" }, controller.signal, (event) => events.push(event.event));
      expect(events).toEqual(["completed"]);
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/r1/resume", expect.objectContaining({ method: "POST", body: '{"value":"Nam"}', signal: controller.signal }));
    } finally {
      fetchMock.mockRestore();
    }
  });
});
