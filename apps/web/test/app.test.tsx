// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SQLAnswer } from "@shared/contracts";
import { App } from "../src/app.js";
import { ResultDrawer } from "../src/drawer.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function sse(event: string, data: unknown): Response {
  const envelope = { event, runId: "run-1", threadId: "chat:sales_south:thread-1", data };
  return new Response(`event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

describe("chat interface", () => {
  it("shows incoming progress before completion and allows it to be collapsed", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Câu hỏi"), { target: { value: "Số đơn?" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi câu hỏi" }));
    const event = { event: "intent_parsed", runId: "run-1", threadId: "thread-1", data: { phase: "starting" } };
    streamController.enqueue(new TextEncoder().encode(`event: intent_parsed\ndata: ${JSON.stringify(event)}\n\n`));
    expect(await screen.findByText("Mình đã nhận câu hỏi và đang bắt đầu phân tích.")).toBeTruthy();
    expect(screen.queryByText("Đã hoàn tất câu trả lời.")).toBeNull();
    const details = screen.getByText(/TIẾN TRÌNH PHÂN TÍCH/).closest("details");
    expect(details?.open).toBe(true);
    fireEvent.click(screen.getByText(/TIẾN TRÌNH PHÂN TÍCH/));
    expect(details?.open).toBe(false);
    const completed = { ...event, event: "completed", data: { answerText: "Xong" } };
    streamController.enqueue(new TextEncoder().encode(`event: completed\ndata: ${JSON.stringify(completed)}\n\n`));
    streamController.close();
    expect(await screen.findByText("Xong")).toBeTruthy();
  });

  it("shows the available SQL proposal while the response is still streaming", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Câu hỏi"), { target: { value: "Số đơn?" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi câu hỏi" }));
    const event = { event: "sql_generated", runId: "run-1", threadId: "thread-1", data: { phase: "display", sql: "SELECT status FROM orders" } };
    streamController.enqueue(new TextEncoder().encode(`event: sql_generated\ndata: ${JSON.stringify(event)}\n\n`));
    expect(await screen.findByText("Truy vấn đã chạy. Bạn có thể xem SQL đề xuất bên dưới.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /SQL & nguồn tham chiếu/ }));
    expect(screen.getByText("SELECT status FROM orders")).toBeTruthy();
    expect(screen.queryByText("Đã hoàn tất câu trả lời.")).toBeNull();
    const completed = { ...event, event: "completed", data: { answerText: "Xong" } };
    streamController.enqueue(new TextEncoder().encode(`event: completed\ndata: ${JSON.stringify(completed)}\n\n`));
    streamController.close();
    expect(await screen.findByText("Xong")).toBeTruthy();
  });

  it("sends a question and resumes a clarification on the same run", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sse("interrupt_waiting", { pendingClarification: { question: "Chọn vùng?", options: ["Nam", "Bắc"] } }))
      .mockResolvedValueOnce(sse("completed", { status: "ok", answerText: "Có 12 đơn hàng." }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Câu hỏi"), { target: { value: "Có bao nhiêu đơn?" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi câu hỏi" }));
    expect(await screen.findByText("Chọn vùng?")).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/ask");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ question: "Có bao nhiêu đơn?", persona: "sales_south" });
    fireEvent.click(screen.getByRole("button", { name: "Nam" }));
    expect(await screen.findByText("Có 12 đơn hàng.")).toBeTruthy();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/runs/run-1/resume");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ value: "Nam" });
    expect(screen.getByText("Mình cần bạn làm rõ trước khi tiếp tục.")).toBeTruthy();
    expect(screen.getByText("Đã hoàn tất câu trả lời.")).toBeTruthy();
  });

  it("shows API failures without inventing results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("error", { status: 503 }));
    render(<App />);
    fireEvent.change(screen.getByLabelText("Câu hỏi"), { target: { value: "Số đơn?" } });
    fireEvent.click(screen.getByRole("button", { name: "Gửi câu hỏi" }));
    expect((await screen.findByRole("alert")).textContent).toContain("503");
  });
});

describe("result drawer", () => {
  it("renders SQLAnswer details as text and a bounded preview", async () => {
    const answer: SQLAnswer = {
      intent: { metric: null, dimensions: [], filters: [], timeRange: null },
      sql: "SELECT 1", tablesUsed: ["orders"], citations: ["metric:orders"],
      attempts: [{ attemptNo: 1, sql: "SELECT 1", schemaRefs: [], validation: "ok", durationMs: 5 }],
      resultPreview: [{ name: "<img src=x onerror=alert(1)>" }], answerText: "Done", status: "ok",
      telemetry: { promptTokens: 2, completionTokens: 3, embeddingTokens: 0, estimatedCostUsd: 0, latencyMs: 10 },
    };
    const { container } = render(<ResultDrawer events={[]} answer={answer} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL & nguồn tham chiếu/ }));
    expect(screen.getAllByText("SELECT 1").length).toBeGreaterThan(0);
    expect(screen.getByText("metric:orders")).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    await waitFor(() => expect(screen.getByText(/1\/50 dòng/)).toBeTruthy());
  });

  it("shows an honest empty state without a result payload", () => {
    render(<ResultDrawer events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL & nguồn tham chiếu/ }));
    expect(screen.getByText("Chi tiết kết quả khác chưa được API cung cấp.")).toBeTruthy();
  });

  it("displays a SQL proposal as soon as its safe progress event arrives", () => {
    render(<ResultDrawer events={[{ event: "sql_generated", runId: "r", threadId: "t", data: { phase: "display", sql: "SELECT status FROM orders" } }]} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL & nguồn tham chiếu/ }));
    expect(screen.getByText("SELECT status FROM orders")).toBeTruthy();
    expect(screen.getByText(/SQL do model đề xuất/)).toBeTruthy();
  });

  it("explains when a SQL proposal is withheld", () => {
    render(<ResultDrawer events={[{ event: "sql_generated", runId: "r", threadId: "t", data: { phase: "display", withheld: true } }]} />);
    fireEvent.click(screen.getByRole("button", { name: /SQL & nguồn tham chiếu/ }));
    expect(screen.getByText(/Không hiển thị SQL vì có thể chứa/)).toBeTruthy();
  });
});
