import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SQLAnswerSchema, type SseEventName, type SseProgressEvent } from "@shared/contracts";
import { chatReducer, initialChat } from "./chat.js";
import { ResultDrawer } from "./drawer.js";
import { postStream } from "./stream.js";
import "./styles.css";
import "./progress.css";

const labels: Record<SseEventName, string> = {
  intent_parsed: "Mình đã nhận câu hỏi và đang bắt đầu phân tích.", schema_retrieved: "Mình đã tìm được thông tin về nguồn dữ liệu.", sql_generated: "Model đã đề xuất truy vấn SQL; truy vấn này chưa được kiểm tra.",
  sql_repaired: "Mình đã điều chỉnh truy vấn.", query_running: "Mình đang kiểm tra và truy vấn dữ liệu.", viz: "Mình đang chuẩn bị biểu đồ.",
  completed: "Đã hoàn tất câu trả lời.", failed: "Mình chưa thể hoàn tất yêu cầu.", interrupt_waiting: "Mình cần bạn làm rõ trước khi tiếp tục.",
};
const personas = [
  { value: "sales_south", label: "Kinh doanh miền Nam" },
  { value: "marketing", label: "Marketing" },
  { value: "hr", label: "Nhân sự" },
  { value: "data_admin", label: "Quản trị dữ liệu" },
];
interface Message { role: "user" | "assistant"; text: string }

export function App() {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const [persona, setPersona] = useState("sales_south");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Message[]>([]);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (state.phase === "completed") input.current?.focus(); }, [state.phase]);

  async function run(path: string, body: Record<string, string>, identity?: { runId: string; threadId: string }) {
    const current = new AbortController();
    controller.current = current;
    let runId = identity?.runId;
    let threadId = identity?.threadId;
    let terminal = false;
    try {
      await postStream(path, body, current.signal, (event: SseProgressEvent) => {
        if (terminal || (runId && runId !== event.runId) || (threadId && threadId !== event.threadId)) throw new Error("Luồng phản hồi không hợp lệ hoặc không khớp phiên.");
        runId = event.runId;
        threadId = event.threadId;
        terminal = ["completed", "failed", "interrupt_waiting"].includes(event.event);
        dispatch({ type: "event", event });
        if (event.event === "completed") {
          const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
          const detail = SQLAnswerSchema.safeParse(data?.answer ?? event.data);
          const answerText = detail.success ? detail.data.answerText : typeof data?.answerText === "string" ? data.answerText : "Không có nội dung trả lời.";
          setHistory((previous) => [...previous, { role: "assistant", text: answerText }]);
        }
      });
      if (!terminal) throw new Error("Kết nối đã đóng trước khi yêu cầu hoàn tất.");
    } catch (error) {
      if (!current.signal.aborted) dispatch({ type: "error", message: error instanceof Error ? error.message : "Không thể kết nối máy chủ." });
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || controller.current || state.phase === "streaming" || state.phase === "waiting") return;
    const threadId = state.threadId;
    setQuestion("");
    setHistory((previous) => [...previous, { role: "user", text }]);
    dispatch({ type: "start" });
    void run("/api/ask", { question: text, persona, ...(threadId ? { threadId } : {}) });
  }

  function choose(value: string) {
    if (!state.runId || !state.threadId || !state.clarification?.options.includes(value) || controller.current || state.phase === "streaming") return;
    const identity = { runId: state.runId, threadId: state.threadId };
    dispatch({ type: "resume" });
    void run(`/api/runs/${encodeURIComponent(identity.runId)}/resume`, { value }, identity);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const busy = state.phase === "streaming";
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">✳</span><span>ANALYTICS<br /><small>WORKSPACE</small></span></div>
      <div className="sidebar-body"><p className="eyebrow">KHÔNG GIAN LÀM VIỆC</p><div className="nav-active"><span>◈</span> Trợ lý phân tích</div>
        <div className="sidebar-note"><span>✦</span><p><strong>Hỏi dữ liệu của bạn</strong><br />Đặt câu hỏi bằng ngôn ngữ tự nhiên để bắt đầu phân tích.</p></div>
      </div><div className="sidebar-footer"><span className="status-dot" /> UC-01 · Analytics Agent</div></aside>
    <main className="main"><header className="topbar"><div><span className="breadcrumb">KHÔNG GIAN LÀM VIỆC</span><span className="breadcrumb-sep">/</span><strong>Trợ lý phân tích</strong></div>
      <label className="persona">Vai trò <select value={persona} disabled={busy || state.phase === "waiting"} onChange={(event) => { setPersona(event.target.value); setHistory([]); dispatch({ type: "reset" }); }} aria-label="Vai trò">{personas.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select></label>
    </header>
    <div className="content"><div className="heading"><div><div className="eyebrow accent">ANALYTICS ASSISTANT</div><h1>Trợ lý phân tích</h1><p>Khám phá dữ liệu, bắt đầu bằng một câu hỏi.</p></div><span className="heading-icon">✳</span></div>
      <section className="chat-card" aria-label="Cuộc trò chuyện">
        <div className="chat-header"><div><span className="chat-icon">✦</span><span><strong>Cuộc trò chuyện</strong><small>Đặt câu hỏi để phân tích dữ liệu</small></span></div><span className="pill"><span className="status-dot" /> {busy ? "Đang xử lý" : state.phase === "waiting" ? "Chờ làm rõ" : state.phase === "failed" ? "Có lỗi" : "Sẵn sàng"}</span></div>
        <div className="conversation" aria-live="polite">
          {history.length === 0 && <div className="welcome"><div className="welcome-icon">✳</div><h2>Xin chào, tôi có thể giúp gì?</h2><p>Hỏi về dữ liệu kinh doanh của bạn. Tôi sẽ phân tích và trình bày kết quả dễ hiểu.</p><div className="suggestions"><button type="button" onClick={() => setQuestion("Số lượng đơn hàng theo trạng thái là bao nhiêu?")}>Số lượng đơn hàng theo trạng thái <span>↗</span></button><button type="button" onClick={() => setQuestion("Doanh thu theo từng khu vực như thế nào?")}>Doanh thu theo khu vực <span>↗</span></button></div></div>}
          {history.map((message, index) => <div className={`message ${message.role}`} key={index}><span className="avatar">{message.role === "user" ? "B" : "✦"}</span><div><strong>{message.role === "user" ? "Bạn" : "Trợ lý phân tích"}</strong><p>{message.text}</p></div></div>)}
          {(state.events.length > 0 || busy) && <details className="progress" open><summary className="progress-title"><span className="pulse" /> TIẾN TRÌNH PHÂN TÍCH</summary>{busy && state.events.length === 0 && <p>Đang kết nối máy chủ…</p>}<ol>{state.events.map((event, i) => {
            const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
            const label = event.event === "intent_parsed" && data?.phase === "resuming" ? "Mình đang tiếp tục xử lý câu trả lời của bạn." : event.event === "sql_generated" && data?.phase === "display" ? (data.withheld === true ? "Truy vấn đã chạy; SQL chưa thể hiển thị an toàn trong bản demo." : "Truy vấn đã chạy. Bạn có thể xem SQL đề xuất bên dưới.") : labels[event.event];
            const tables = Array.isArray(data?.tables) ? data.tables.filter((value): value is string => typeof value === "string") : [];
            return <li key={i} className="progress-update"><span className="event-dot" /><span>{label}{tables.length > 0 && <span className="progress-meta"> Bảng: {tables.join(", ")}.</span>}{event.event === "sql_generated" && typeof data?.statementType === "string" && <span className="progress-meta"> Loại: {data.statementType}.</span>}</span></li>;
          })}</ol></details>}
          {state.clarification && (state.phase === "waiting" || state.phase === "failed" || busy) && <div className="clarification"><strong>{state.clarification.question}</strong><div>{state.clarification.options.map((option) => <button key={option} type="button" disabled={busy} onClick={() => choose(option)}>{option}</button>)}</div></div>}
          {state.error && <div className="error" role="alert">{state.error}</div>}
          {(state.events.length > 0 && state.phase !== "idle") && <ResultDrawer events={state.events} answer={state.answerDetail ?? undefined} />}
        </div>
        <form className="composer" onSubmit={send}><label className="sr-only" htmlFor="question">Câu hỏi</label><textarea id="question" ref={input} rows={1} placeholder="Hỏi bất cứ điều gì về dữ liệu của bạn..." value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={onKeyDown} disabled={busy || state.phase === "waiting"} /><button type="submit" disabled={!question.trim() || busy || state.phase === "waiting"} aria-label="Gửi câu hỏi">↑</button></form>
        <div className="hint">Enter để gửi <span>·</span> Shift + Enter để xuống dòng</div>
      </section><div className="footnote">✧ &nbsp; Câu trả lời dựa trên dữ liệu có sẵn và quyền truy cập của bạn.</div>
    </div></main>
  </div>;
}
