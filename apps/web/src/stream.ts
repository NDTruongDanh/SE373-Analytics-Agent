import { SseProgressEventSchema, type SseProgressEvent } from "@shared/contracts";

/** Decode SSE frames incrementally. A frame is dispatched only after a blank line. */
export class SseParser {
  private buffer = "";
  private eventName = "message";
  private data: string[] = [];

  constructor(private readonly onEvent: (event: SseProgressEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.search(/[\r\n]/);
    while (newline !== -1) {
      // A CR at the end of a chunk may be the first half of CRLF.
      if (this.buffer[newline] === "\r" && newline === this.buffer.length - 1) return;
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.slice(newline, newline + 2) === "\r\n" ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      this.line(line);
      newline = this.buffer.search(/[\r\n]/);
    }
  }

  finish(): void {
    if (this.buffer.endsWith("\r")) this.push("\n");
    if (this.buffer.length > 0 || this.data.length > 0) {
      throw new Error("Luồng phản hồi bị ngắt trước khi hoàn tất.");
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length > 0) this.dispatch();
      this.eventName = "message";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    if (field === "data") this.data.push(value);
  }

  private dispatch(): void {
    let value: unknown;
    try {
      value = JSON.parse(this.data.join("\n"));
    } catch {
      throw new Error("Phản hồi từ máy chủ không hợp lệ.");
    }
    const parsed = SseProgressEventSchema.safeParse(value);
    if (!parsed.success || parsed.data.event !== this.eventName) {
      throw new Error("Sự kiện từ máy chủ không hợp lệ.");
    }
    this.onEvent(parsed.data);
  }
}

export class StreamHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable?: boolean;

  constructor(
    status: number,
    message: string,
    code?: string,
    retryable?: boolean,
  ) {
    super(message);
    this.name = "StreamHttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function parseHttpError(response: Response): Promise<StreamHttpError> {
  let code: string | undefined;
  let serverMessage: string | undefined;
  let retryable: boolean | undefined;
  try {
    const raw = await response.text();
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec.code === "string") code = rec.code;
        if (typeof rec.message === "string" && rec.message.trim().length > 0) {
          serverMessage = rec.message.trim();
        }
        if (typeof rec.retryable === "boolean") retryable = rec.retryable;
      }
    }
  } catch {
    // Non-JSON or unreadable error body; fall back to status-based message.
  }

  if (response.status === 409) {
    const base =
      "Checkpoint đã cũ hoặc phiên phân tích đang có yêu cầu khác đang xử lý (HTTP 409 Conflict).";
    const message = serverMessage ? `${base} ${serverMessage}` : base;
    return new StreamHttpError(409, message, code, retryable);
  }

  const fallback = `Không thể xử lý yêu cầu (HTTP ${response.status}).`;
  const message = serverMessage ? `${fallback} ${serverMessage}` : fallback;
  return new StreamHttpError(response.status, message, code, retryable);
}

export async function readEventStream(
  response: Response,
  onEvent: (event: SseProgressEvent) => void,
): Promise<void> {
  if (!response.ok) throw await parseHttpError(response);
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new Error("Máy chủ không trả về luồng sự kiện hợp lệ.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onEvent);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Keep the original parsing or callback error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function postStream(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (event: SseProgressEvent) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  await readEventStream(response, onEvent);
}
