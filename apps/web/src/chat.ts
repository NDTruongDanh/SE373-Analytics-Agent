import { SQLAnswerSchema, type SQLAnswer, type SseProgressEvent } from "@shared/contracts";

export type Phase = "idle" | "streaming" | "waiting" | "completed" | "failed";
export interface Clarification { question: string; options: string[] }
export interface ChatState {
  phase: Phase;
  runId: string | null;
  threadId: string | null;
  events: SseProgressEvent[];
  clarification: Clarification | null;
  answer: string | null;
  answerDetail: SQLAnswer | null;
  error: string | null;
}

export const initialChat: ChatState = {
  phase: "idle", runId: null, threadId: null, events: [], clarification: null, answer: null, answerDetail: null, error: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function clarificationFrom(value: unknown): Clarification | null {
  const payload = record(value);
  const pending = payload?.pendingClarification;
  const structured = record(pending);
  const options = Array.isArray(pending) ? pending : structured?.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4 ||
    !options.every((option): option is string => typeof option === "string" && option.trim().length > 0)) return null;
  const question = structured?.question ?? payload?.reason;
  return { question: typeof question === "string" && question.trim() ? question : "Vui lòng chọn một phương án để tiếp tục.", options };
}

export type ChatAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "event"; event: SseProgressEvent }
  | { type: "error"; message: string }
  | { type: "reset" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "start": return { ...initialChat, phase: "streaming" };
    case "resume": return { ...state, phase: "streaming", error: null };
    case "reset": return initialChat;
    case "error": return { ...state, phase: "failed", error: action.message };
    case "event": {
      const event = action.event;
      if ((state.runId && state.runId !== event.runId) || (state.threadId && state.threadId !== event.threadId)) {
        return { ...state, phase: "failed", error: "Mã phiên phản hồi không khớp." };
      }
      const next = { ...state, runId: event.runId, threadId: event.threadId, events: [...state.events, event] };
      const data = record(event.data);
      if (event.event === "interrupt_waiting") {
        const clarification = clarificationFrom(event.data);
        return clarification ? { ...next, phase: "waiting", clarification } :
          { ...next, phase: "failed", error: "Không nhận được lựa chọn làm rõ hợp lệ." };
      }
      if (event.event === "failed") return { ...next, phase: "failed", error: typeof data?.message === "string" ? data.message : "Yêu cầu thất bại." };
      if (event.event === "completed") {
        const answer = SQLAnswerSchema.safeParse(data?.answer ?? event.data);
        return { ...next, phase: "completed", clarification: null, answer: answer.success ? answer.data.answerText : typeof data?.answerText === "string" ? data.answerText : "Không có nội dung trả lời.", answerDetail: answer.success ? answer.data : null };
      }
      return next;
    }
  }
}
