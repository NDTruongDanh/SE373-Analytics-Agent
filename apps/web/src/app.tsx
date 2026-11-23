import { QueryClientProvider } from "@tanstack/react-query";
import {
  Activity,
  BellRing,
  BookOpen,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useReducer, useState } from "react";
import { BrowserRouter, MemoryRouter, NavLink, Route, Routes, useLocation } from "react-router";
import { chatReducer, initialChat } from "@/chat";
import { createQueryClient } from "@/lib/queryClient";
import { AlertsPage } from "@/pages/AlertsPage";
import { ApprovalsPage } from "@/pages/ApprovalsPage";
import { ChatPage, type ChatMessageItem } from "@/pages/ChatPage";
import { DictionaryPage } from "@/pages/DictionaryPage";
import { EvalTracesPage } from "@/pages/EvalTracesPage";
import "@/styles.css";
import "@/progress.css";

const personas = [
  { value: "sales_south", label: "Kinh doanh miền Nam" },
  { value: "marketing", label: "Marketing" },
  { value: "hr", label: "Nhân sự" },
  { value: "data_admin", label: "Quản trị dữ liệu" },
];

const NAV_ITEMS = [
  { to: "/", label: "Trợ lý phân tích", icon: MessageSquare, end: true },
  { to: "/alerts", label: "Cảnh báo", icon: BellRing, end: false },
  { to: "/dictionary", label: "Từ điển dữ liệu", icon: BookOpen, end: false },
  { to: "/approvals", label: "Phê duyệt", icon: ShieldCheck, end: false },
  { to: "/evals", label: "Trace & Eval", icon: Activity, end: false },
];

export interface AppProps {
  /** Optional initial routes for isolated component tests. */
  initialEntries?: string[];
}

function WorkspaceShell() {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const [persona, setPersona] = useState("sales_south");
  const [history, setHistory] = useState<ChatMessageItem[]>([]);
  const location = useLocation();

  const busy = state.phase === "streaming";
  const currentTitle =
    NAV_ITEMS.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)))
      ?.label ?? "Trợ lý phân tích";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles className="size-5" aria-hidden="true" />
          </span>
          <span>
            ANALYTICS
            <br />
            <small>WORKSPACE</small>
          </span>
        </div>
        <nav className="sidebar-body" aria-label="Điều hướng chính">
          <p className="eyebrow">KHÔNG GIAN LÀM VIỆC</p>
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
          <div className="sidebar-note">
            <Sparkles className="size-4 text-[#bee4b4]" aria-hidden="true" />
            <p>
              <strong>Hỏi dữ liệu của bạn</strong>
              <br />
              Đặt câu hỏi bằng ngôn ngữ tự nhiên để bắt đầu phân tích.
            </p>
          </div>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" /> SE373 · Analytics Agent
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span className="breadcrumb">KHÔNG GIAN LÀM VIỆC</span>
            <span className="breadcrumb-sep">/</span>
            <strong>{currentTitle}</strong>
          </div>
          <label className="persona">
            Vai trò{" "}
            <select
              value={persona}
              disabled={busy || state.phase === "waiting"}
              onChange={(event) => {
                setPersona(event.target.value);
                setHistory([]);
                dispatch({ type: "reset" });
              }}
              aria-label="Vai trò"
            >
              {personas.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </header>
        <Routes>
          <Route
            path="/"
            element={
              <ChatPage
                persona={persona}
                state={state}
                dispatch={dispatch}
                history={history}
                setHistory={setHistory}
              />
            }
          />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/dictionary" element={<DictionaryPage persona={persona} />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/evals" element={<EvalTracesPage />} />
        </Routes>
      </main>
    </div>
  );
}

export { InsightChart } from "@/charts";
export { InsightPanel } from "@/components/InsightPanel";
export { PlanReviewPanel } from "@/components/PlanReviewPanel";
export { RootCauseView } from "@/components/RootCauseView";

export function App({ initialEntries }: AppProps = {}) {
  const client = useMemo(() => createQueryClient(), []);

  return (
    <QueryClientProvider client={client}>
      {initialEntries ? (
        <MemoryRouter initialEntries={initialEntries}>
          <WorkspaceShell />
        </MemoryRouter>
      ) : (
        <BrowserRouter>
          <WorkspaceShell />
        </BrowserRouter>
      )}
    </QueryClientProvider>
  );
}
