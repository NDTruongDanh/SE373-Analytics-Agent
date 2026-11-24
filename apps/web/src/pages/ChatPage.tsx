import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  SQLAnswerSchema,
  type EvidencePointer,
  type SseEventName,
  type SseProgressEvent,
} from "@shared/contracts";
import { ArrowUp, ArrowUpRight, MessageSquare, Sparkles } from "lucide-react";
import { InsightChart } from "@/charts";
import {
  extractRootCausePayload,
  extractVizPayload,
  type ChatAction,
  type ChatRootCauseState,
  type ChatState,
  type ChatVizState,
} from "@/chat";
import { InsightPanel } from "@/components/InsightPanel";
import { PlanReviewPanel, type PlanResumeSubmission } from "@/components/PlanReviewPanel";
import { RootCauseView } from "@/components/RootCauseView";
import { SafeMarkdown } from "@/components/chat/SafeMarkdown";
import { ResultDrawer } from "@/drawer";
import { postStream, StreamHttpError } from "@/stream";

const labels: Record<SseEventName, string> = {
  intent_parsed: "Mình đã nhận câu hỏi và đang bắt đầu phân tích.",
  schema_retrieved: "Mình đã tìm được thông tin về nguồn dữ liệu.",
  sql_generated: "Model đã đề xuất truy vấn SQL; truy vấn này chưa được kiểm tra.",
  sql_repaired: "Mình đã điều chỉnh truy vấn.",
  query_running: "Mình đang kiểm tra và truy vấn dữ liệu.",
  viz: "Mình đang chuẩn bị biểu đồ.",
  completed: "Đã hoàn tất câu trả lời.",
  failed: "Mình chưa thể hoàn tất yêu cầu.",
  interrupt_waiting: "Mình cần bạn làm rõ trước khi tiếp tục.",
};

export interface ChatMessageItem {
  role: "user" | "assistant";
  text: string;
  viz?: ChatVizState | null;
  rootCause?: ChatRootCauseState | null;
  resultPreview?: Record<string, unknown>[];
}

export interface ChatPageProps {
  persona: string;
  state: ChatState;
  dispatch: (action: ChatAction) => void;
  history: ChatMessageItem[];
  setHistory: React.Dispatch<React.SetStateAction<ChatMessageItem[]>>;
  question: string;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  controllerRef: React.MutableRefObject<AbortController | null>;
}

export function ChatPage({
  persona,
  state,
  dispatch,
  history,
  setHistory,
  question,
  setQuestion,
  controllerRef,
}: ChatPageProps) {
  const [activeEvidence, setActiveEvidence] = useState<EvidencePointer | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state.phase === "completed") input.current?.focus();
  }, [state.phase]);

  async function run(
    path: string,
    body: Record<string, unknown>,
    identity?: { runId: string; threadId: string },
  ) {
    const current = new AbortController();
    controllerRef.current = current;
    let runId = identity?.runId;
    let threadId = identity?.threadId;
    let terminal = false;
    let latestViz: ChatVizState | null = null;
    const lastUserQuestion = [...history].reverse().find((item) => item.role === "user")?.text;
    const questionTitle =
      (typeof body.question === "string" && body.question) ||
      lastUserQuestion ||
      state.viz?.title ||
      "Kết quả phân tích";
    try {
      await postStream(path, body, current.signal, (event: SseProgressEvent) => {
        if (terminal || (runId && runId !== event.runId) || (threadId && threadId !== event.threadId)) {
          throw new Error("Luồng phản hồi không hợp lệ hoặc không khớp phiên.");
        }
        runId = event.runId;
        threadId = event.threadId;
        terminal = ["completed", "failed", "interrupt_waiting"].includes(event.event);
        if (terminal) {
          current.abort();
          if (controllerRef.current === current) controllerRef.current = null;
        }
        if (event.event === "viz") {
          const parsedViz = extractVizPayload(event.data, questionTitle);
          if (parsedViz) latestViz = parsedViz;
        }
        dispatch({ type: "event", event });
        if (event.event === "completed") {
          const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : null;
          const detail = SQLAnswerSchema.safeParse(data?.answer ?? event.data);
          const completedRootCause = extractRootCausePayload(event.data, state.planReview?.plan);
          const completedVizRaw = extractVizPayload(event.data, questionTitle);
          let completedViz = completedVizRaw ?? latestViz;
          if (completedViz && completedVizRaw && !completedVizRaw.openuiLang && latestViz?.openuiLang) {
            completedViz = { ...completedViz, openuiLang: latestViz.openuiLang };
          }
          if (completedViz && !completedViz.resultPreview && latestViz?.resultPreview) {
            completedViz = { ...completedViz, resultPreview: latestViz.resultPreview };
          }
          const previewRows = detail.success ? detail.data.resultPreview : completedViz?.resultPreview;
          if (completedViz && previewRows && previewRows.length > 0 && !completedViz.resultPreview) {
            completedViz = { ...completedViz, resultPreview: previewRows };
          }
          const answerText = detail.success
            ? detail.data.answerText
            : typeof data?.answerText === "string"
              ? data.answerText
              : typeof data?.summary === "string"
                ? data.summary
                : completedRootCause?.answer?.finalReportMarkdown ??
                  completedRootCause?.message ??
                  "Không có nội dung trả lời.";
          setHistory((previous) => [
            ...previous,
            {
              role: "assistant",
              text: answerText,
              ...(completedViz ? { viz: completedViz } : {}),
              ...(completedRootCause ? { rootCause: completedRootCause } : {}),
              ...(previewRows ? { resultPreview: previewRows } : {}),
            },
          ]);
        }
      });
      if (!terminal) throw new Error("Kết nối đã đóng trước khi yêu cầu hoàn tất.");
    } catch (error) {
      if (controllerRef.current === current) controllerRef.current = null;
      if (!current.signal.aborted) {
        if (error instanceof StreamHttpError && error.status === 409) {
          dispatch({ type: "conflict", message: error.message });
        } else {
          dispatch({
            type: "error",
            message: error instanceof Error ? error.message : "Không thể kết nối máy chủ.",
          });
        }
      }
    } finally {
      if (controllerRef.current === current) controllerRef.current = null;
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || controllerRef.current || state.phase === "streaming" || state.phase === "waiting") return;
    const threadId = state.threadId;
    setQuestion("");
    setActiveEvidence(null);
    setHistory((previous) => [...previous, { role: "user", text }]);
    dispatch({ type: "start" });
    void run("/api/ask", { question: text, persona, ...(threadId ? { threadId } : {}) });
  }

  function choose(value: string) {
    if (!state.runId || !state.threadId || !state.clarification?.options.includes(value) || controllerRef.current || state.phase === "streaming") {
      return;
    }
    const identity = { runId: state.runId, threadId: state.threadId };
    dispatch({ type: "resume" });
    void run(`/api/runs/${encodeURIComponent(identity.runId)}/resume`, { value }, identity);
  }

  function resumePlan(submission: PlanResumeSubmission) {
    if (!state.runId || !state.threadId || !state.planReview || controllerRef.current || state.phase === "streaming") {
      return;
    }
    const identity = { runId: state.runId, threadId: state.threadId };
    dispatch({ type: "resume" });
    void run(
      `/api/runs/${encodeURIComponent(identity.runId)}/resume`,
      {
        value: submission.value,
        ...(submission.checkpointId ? { checkpointId: submission.checkpointId } : {}),
      },
      identity,
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const busy = state.phase === "streaming";
  const lastAssistantIndex = history.reduce(
    (lastIdx, item, idx) => (item.role === "assistant" ? idx : lastIdx),
    -1,
  );

  return (
    <div className="content">
      <div className="heading">
        <div>
          <div className="eyebrow accent">ANALYTICS ASSISTANT</div>
          <h1>Trợ lý phân tích</h1>
          <p>Khám phá dữ liệu, bắt đầu bằng một câu hỏi.</p>
        </div>
        <Sparkles className="heading-icon size-8" aria-hidden="true" />
      </div>
      <section className="chat-card" aria-label="Cuộc trò chuyện">
        <div className="chat-header">
          <div>
            <span className="chat-icon">
              <MessageSquare className="size-4" aria-hidden="true" />
            </span>
            <span>
              <strong>Cuộc trò chuyện</strong>
              <small>Đặt câu hỏi để phân tích dữ liệu</small>
            </span>
          </div>
          <span className="pill">
            <span className="status-dot" />
            {busy
              ? "Đang xử lý"
              : state.phase === "waiting"
                ? state.planReview
                  ? "Chờ duyệt kế hoạch"
                  : "Chờ làm rõ"
                : state.phase === "failed"
                  ? "Có lỗi"
                  : "Sẵn sàng"}
          </span>
        </div>
        <div className="conversation" aria-live="polite">
          {history.length === 0 && (
            <div className="welcome">
              <div className="welcome-icon">
                <Sparkles className="size-7" aria-hidden="true" />
              </div>
              <h2>Xin chào, tôi có thể giúp gì?</h2>
              <p>Hỏi về dữ liệu kinh doanh của bạn. Tôi sẽ phân tích và trình bày kết quả dễ hiểu.</p>
              <div className="suggestions">
                <button type="button" onClick={() => setQuestion("Số lượng đơn hàng theo trạng thái là bao nhiêu?")}>
                  Số lượng đơn hàng theo trạng thái
                  <span>
                    <ArrowUpRight className="inline size-3.5" aria-hidden="true" />
                  </span>
                </button>
                <button type="button" onClick={() => setQuestion("Doanh thu theo từng khu vực như thế nào?")}>
                  Doanh thu theo khu vực
                  <span>
                    <ArrowUpRight className="inline size-3.5" aria-hidden="true" />
                  </span>
                </button>
              </div>
            </div>
          )}
          {history.map((message, index) => {
            const isLastAssistantMessage =
              message.role === "assistant" && index === lastAssistantIndex;
            const turnViz =
              message.role === "assistant"
                ? message.viz ?? (isLastAssistantMessage ? state.viz : null)
                : null;
            const turnRootCause =
              message.role === "assistant"
                ? message.rootCause ?? (isLastAssistantMessage ? state.rootCause : null)
                : null;
            const turnPreview =
              message.resultPreview ??
              turnViz?.resultPreview ??
              (isLastAssistantMessage ? state.answerDetail?.resultPreview : undefined);
            const showPlainMarkdown =
              !turnRootCause ||
              (!turnRootCause.falsePremise &&
                message.text !== turnRootCause.answer?.finalReportMarkdown);
            return (
              <div className={`message ${message.role}`} key={index}>
                <span className="avatar">{message.role === "user" ? "B" : "✦"}</span>
                <div className="min-w-0 flex-1">
                  <strong>{message.role === "user" ? "Bạn" : "Trợ lý phân tích"}</strong>
                  {message.role === "assistant" ? (
                    <div className="mt-1 space-y-3">
                      {showPlainMarkdown && <SafeMarkdown content={message.text} />}
                      {turnRootCause ? (
                        <>
                          <RootCauseView
                            answer={turnRootCause.answer}
                            plan={turnRootCause.plan}
                            steps={turnRootCause.steps}
                            status={turnRootCause.status}
                            falsePremise={turnRootCause.falsePremise}
                            message={turnRootCause.message}
                            sql={turnRootCause.sql}
                            metricName={turnRootCause.metricName}
                            baselineVal={turnRootCause.baselineVal}
                            currentVal={turnRootCause.currentVal}
                            absDelta={turnRootCause.absDelta}
                            pctDelta={turnRootCause.pctDelta}
                            baselinePeriod={turnRootCause.baselinePeriod}
                            currentPeriod={turnRootCause.currentPeriod}
                            viz={
                              turnViz
                                ? {
                                    title: turnViz.title,
                                    report: turnViz.report,
                                    openuiLang: turnViz.openuiLang,
                                    streaming: false,
                                  }
                                : null
                            }
                          />
                          {turnViz && (
                            <InsightPanel
                              report={turnViz.report}
                              resultPreview={turnPreview}
                              truncated={turnViz.truncated}
                              activeEvidence={activeEvidence}
                              onSelectEvidence={setActiveEvidence}
                            />
                          )}
                        </>
                      ) : (
                        turnViz && (
                          <>
                            <InsightChart
                              title={turnViz.title}
                              report={turnViz.report}
                              lang={turnViz.openuiLang}
                              streaming={false}
                            />
                            <InsightPanel
                              report={turnViz.report}
                              resultPreview={turnPreview}
                              truncated={turnViz.truncated}
                              activeEvidence={activeEvidence}
                              onSelectEvidence={setActiveEvidence}
                            />
                          </>
                        )
                      )}
                    </div>
                  ) : (
                    <p>{message.text}</p>
                  )}
                </div>
              </div>
            );
          })}
          {busy && state.viz && (
            <div className="message assistant" data-testid="streaming-viz-turn">
              <span className="avatar">✦</span>
              <div className="min-w-0 flex-1 space-y-3">
                <strong>Trợ lý phân tích</strong>
                <InsightChart
                  title={state.viz.title}
                  report={state.viz.report}
                  lang={state.viz.openuiLang}
                  streaming={true}
                />
                <InsightPanel
                  report={state.viz.report}
                  resultPreview={state.viz.resultPreview ?? state.answerDetail?.resultPreview}
                  truncated={state.viz.truncated}
                  activeEvidence={activeEvidence}
                  onSelectEvidence={setActiveEvidence}
                />
              </div>
            </div>
          )}
          {(state.events.length > 0 || busy) && (
            <details className="progress" open>
              <summary className="progress-title">
                <span className="pulse" /> TIẾN TRÌNH PHÂN TÍCH
              </summary>
              {busy && state.events.length === 0 && <p>Đang kết nối máy chủ…</p>}
              <ol>
                {state.events.map((event, i) => {
                  const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : null;
                  const label =
                    event.event === "intent_parsed" && data?.phase === "resuming"
                      ? "Mình đang tiếp tục xử lý câu trả lời của bạn."
                      : event.event === "interrupt_waiting" && data?.action === "review_analysis_plan"
                        ? "Mình đã lập kế hoạch phân tích và đang chờ bạn kiểm duyệt."
                        : event.event === "sql_generated" && data?.phase === "display"
                          ? data.withheld === true
                            ? "Truy vấn đã chạy; SQL chưa thể hiển thị an toàn trong bản demo."
                            : "Truy vấn đã chạy. Bạn có thể xem SQL đề xuất bên dưới."
                          : labels[event.event];
                  const tables = Array.isArray(data?.tables)
                    ? data.tables.filter((value): value is string => typeof value === "string")
                    : [];
                  return (
                    <li key={i} className="progress-update">
                      <span className="event-dot" />
                      <span>
                        {label}
                        {tables.length > 0 && <span className="progress-meta"> Bảng: {tables.join(", ")}.</span>}
                        {event.event === "sql_generated" && typeof data?.statementType === "string" && (
                          <span className="progress-meta"> Loại: {data.statementType}.</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </details>
          )}
          {state.clarification && (state.phase === "waiting" || state.phase === "failed" || busy) && (
            <div className="clarification">
              <strong>{state.clarification.question}</strong>
              <div>
                {state.clarification.options.map((option) => (
                  <button key={option} type="button" disabled={busy} onClick={() => choose(option)}>
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}
          {state.planReview && (state.phase === "waiting" || state.phase === "failed" || busy) && (
            <PlanReviewPanel
              plan={state.planReview.plan}
              runId={state.runId}
              threadId={state.threadId}
              checkpointId={state.planReview.checkpointId}
              asOf={state.planReview.asOf}
              busy={busy}
              conflictError={state.conflictError}
              onResume={resumePlan}
            />
          )}
          {state.error && !(state.planReview && state.conflictError) && (
            <div className="error" role="alert">
              {state.error}
            </div>
          )}
          {state.events.length > 0 && state.phase !== "idle" && (
            <ResultDrawer
              events={state.events}
              answer={state.answerDetail ?? undefined}
              highlightedEvidence={activeEvidence}
            />
          )}
        </div>
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="question">
            Câu hỏi
          </label>
          <textarea
            id="question"
            ref={input}
            rows={1}
            placeholder="Hỏi bất cứ điều gì về dữ liệu của bạn..."
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={busy || state.phase === "waiting"}
          />
          <button type="submit" disabled={!question.trim() || busy || state.phase === "waiting"} aria-label="Gửi câu hỏi">
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
        </form>
        <div className="hint">
          Enter để gửi <span>·</span> Shift + Enter để xuống dòng
        </div>
      </section>
      <div className="footnote">✧ &nbsp; Câu trả lời dựa trên dữ liệu có sẵn và quyền truy cập của bạn.</div>
    </div>
  );
}
