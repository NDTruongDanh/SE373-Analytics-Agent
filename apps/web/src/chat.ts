import {
  InsightReportSchema,
  SQLAnswerSchema,
  type InsightReport,
  type SQLAnswer,
  type SseProgressEvent,
} from "@shared/contracts";

export type Phase = "idle" | "streaming" | "waiting" | "completed" | "failed";
export interface Clarification { question: string; options: string[] }

export interface ChatVizState {
  title: string;
  report: InsightReport;
  openuiLang: string;
  truncated: boolean;
  narrativeDowngraded?: boolean;
  resultPreview?: Record<string, unknown>[];
}

export interface ChatState {
  phase: Phase;
  runId: string | null;
  threadId: string | null;
  events: SseProgressEvent[];
  clarification: Clarification | null;
  answer: string | null;
  answerDetail: SQLAnswer | null;
  viz: ChatVizState | null;
  error: string | null;
}

export const initialChat: ChatState = {
  phase: "idle",
  runId: null,
  threadId: null,
  events: [],
  clarification: null,
  answer: null,
  answerDetail: null,
  viz: null,
  error: null,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function extractVizPayload(
  value: unknown,
  fallbackTitle = "Kết quả phân tích",
): ChatVizState | null {
  const data = record(value);
  if (!data) return null;
  const vizSpec = record(data.vizSpec);
  const rawReport =
    data.report ??
    vizSpec?.report ??
    (data.kind === "insight_report" ? data.data : undefined) ??
    data.insightReport ??
    data;
  const parsed = InsightReportSchema.safeParse(rawReport);
  if (!parsed.success) return null;

  const rawLang =
    data.openuiLang ?? data.lang ?? vizSpec?.openuiLang ?? vizSpec?.lang;
  const openuiLang = typeof rawLang === "string" ? rawLang : "";

  const titleCandidates = [
    data.title,
    vizSpec?.title,
    data.question,
    data.summary,
    fallbackTitle,
  ];
  const title =
    titleCandidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )?.trim() ?? fallbackTitle;

  const answerRecord = record(data.answer);
  const truncated = Boolean(
    data.truncated ??
      data.resultTruncated ??
      vizSpec?.truncated ??
      vizSpec?.resultTruncated ??
      answerRecord?.resultTruncated ??
      false,
  );

  const rawDowngraded =
    data.narrativeDowngraded ?? vizSpec?.narrativeDowngraded;
  const narrativeDowngraded =
    typeof rawDowngraded === "boolean" ? rawDowngraded : undefined;

  const rawPreview = Array.isArray(data.resultPreview)
    ? data.resultPreview
    : Array.isArray(answerRecord?.resultPreview)
      ? answerRecord.resultPreview
      : Array.isArray(vizSpec?.resultPreview)
        ? vizSpec.resultPreview
        : undefined;
  const resultPreview = rawPreview
    ?.filter((row): row is Record<string, unknown> => record(row) !== null)
    .slice(0, 50);

  return {
    title,
    report: parsed.data,
    openuiLang,
    truncated,
    ...(narrativeDowngraded !== undefined ? { narrativeDowngraded } : {}),
    ...(resultPreview ? { resultPreview } : {}),
  };
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
      if (event.event === "viz") {
        const viz = extractVizPayload(event.data, state.viz?.title);
        return viz ? { ...next, viz } : next;
      }
      if (event.event === "completed") {
        const answer = SQLAnswerSchema.safeParse(data?.answer ?? event.data);
        const extractedViz = extractVizPayload(event.data, state.viz?.title);
        let incomingViz = extractedViz ?? state.viz;
        if (
          incomingViz &&
          extractedViz &&
          !extractedViz.openuiLang &&
          state.viz?.openuiLang
        ) {
          incomingViz = { ...incomingViz, openuiLang: state.viz.openuiLang };
        }
        if (
          incomingViz &&
          !incomingViz.resultPreview &&
          state.viz?.resultPreview
        ) {
          incomingViz = { ...incomingViz, resultPreview: state.viz.resultPreview };
        }
        if (
          incomingViz &&
          answer.success &&
          (!incomingViz.resultPreview || incomingViz.resultPreview.length === 0) &&
          answer.data.resultPreview.length > 0
        ) {
          incomingViz = { ...incomingViz, resultPreview: answer.data.resultPreview };
        }
        return {
          ...next,
          phase: "completed",
          clarification: null,
          answer: answer.success
            ? answer.data.answerText
            : typeof data?.answerText === "string"
              ? data.answerText
              : typeof data?.summary === "string"
                ? data.summary
                : "Không có nội dung trả lời.",
          answerDetail: answer.success ? answer.data : null,
          viz: incomingViz,
        };
      }
      return next;
    }
  }
}
