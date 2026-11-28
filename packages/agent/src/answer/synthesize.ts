import { redactPII } from "@shared/access-policy";
import { InsightReportSchema } from "@shared/contracts";
import { BUDGET_LIMITS } from "../constants.js";
import { createChatModel } from "../models/factory.js";
import {
  budgetTripReasonFromError,
  checkBudget,
  estimateTokens,
  formatBudgetTripTemplate,
  recordLlmCall,
  type BudgetState,
  type BudgetTripReason,
} from "../queryExecutor/budgets.js";
import { invokeJsonWithUsage, unaccountedUsage, type PlainJsonModelLike } from "../telemetry/usage.js";
import { finalizeTurnMemory } from "../multiTurn.js";
import {
  AnswerDraftSchema,
  buildAnswerPrompt,
  isVietnamese,
  prepareAnswerRows,
  verifyAnswerDraft,
} from "./grounding.js";
import type {
  AgentState,
  AgentStatus,
  AgentUpdate,
  RootRuntime,
  SynthesizeFn,
} from "../state.js";

export const ANSWER_PREVIEW_ROWS = 5;

const RAW_SQL_ERROR = /\b(?:SELECT\b[\s\S]{1,500}?\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|WITH\s+\w+\s+AS\b)|\bat\s+\S+\s+\(/i;

const STATUS_FALLBACK_MESSAGES: Record<AgentStatus, [string, string]> = {
  ok: ["Không có kết quả đã xác minh để trình bày.", "No verified result is available to summarize."],
  no_data: ["Không tìm thấy dữ liệu phù hợp với điều kiện đã hỏi.", "No data matched the requested conditions."],
  cannot_answer: ["Không thể trả lời từ dữ liệu hiện có.", "The available data cannot answer this question."],
  needs_clarification: ["Cần làm rõ câu hỏi trước khi truy vấn.", "Please clarify the question before running a query."],
  restricted: ["Bạn không có quyền truy cập dữ liệu được yêu cầu.", "Access to the requested data is restricted."],
  false_premise: ["Tiền đề của câu hỏi không khớp dữ liệu.", "The question's premise does not match the data."],
  error: ["Không thể hoàn tất truy vấn do lỗi thực thi.", "The query could not be completed because of an execution error."],
};

export interface AnswerSynthesizerDeps {
  model?: PlainJsonModelLike | null;
}

function statusMessage(status: AgentStatus, question: string): string {
  return STATUS_FALLBACK_MESSAGES[status][isVietnamese(question) ? 0 : 1];
}

function numberText(value: number, question: string): string {
  const exact = String(value);
  if (!Number.isFinite(value) || /e/i.test(exact)) return exact;
  const [integer, fraction] = exact.split(".");
  const grouped = (integer ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, isVietnamese(question) ? "." : ",");
  return fraction === undefined ? grouped : `${grouped}${isVietnamese(question) ? "," : "."}${fraction}`;
}

function readVerifiedInsights(vizSpec: unknown): { claims: string[]; caveats: string[] } | null {
  if (!vizSpec || typeof vizSpec !== "object" || !("kind" in vizSpec) || vizSpec.kind !== "insight_report") return null;
  if ("narrativeDowngraded" in vizSpec && vizSpec.narrativeDowngraded === true) return null;
  const report = InsightReportSchema.safeParse("report" in vizSpec ? vizSpec.report : null);
  if (!report.success || report.data.insights.length === 0) return null;
  return {
    claims: report.data.insights.map((item) => item.claim.trim()).filter(Boolean),
    caveats: report.data.caveats,
  };
}

function skipModelAfterVizFailure(vizSpec: unknown): boolean {
  if (!vizSpec || typeof vizSpec !== "object") return false;
  if ("narrativeDowngraded" in vizSpec && vizSpec.narrativeDowngraded === true) return true;
  if (!("report" in vizSpec)) return false;
  const report = InsightReportSchema.safeParse(vizSpec.report);
  return report.success && report.data.caveats.some((value) =>
    /rate-limited|draft validation failed|budget exceeded|nhận định đã bị loại|no verifiable claims/i.test(value)
  );
}

function formatCellValue(value: unknown, question: string): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return numberText(value, question);
  if (typeof value === "string") {
    if (/(?:ignore (?:all )?(?:previous|above)|system prompt|<\/?untrusted_data>)/i.test(value)) {
      return "[untrusted text omitted]";
    }
    return value.replace(/\s+/g, " ").slice(0, 100);
  }
  if (typeof value === "boolean") return String(value);
  return (JSON.stringify(value) ?? "null").slice(0, 100);
}

function previewCaveat(state: AgentState, shown: number): string {
  if (shown === 0) return "";
  const vi = isVietnamese(state.question);
  if (state.resultTruncated || state.rowCount === null) {
    return vi
      ? `Đây là ${shown} dòng xem trước; tổng số dòng ngoài phần này chưa xác định.`
      : `These are ${shown} preview rows; the full row count is unknown.`;
  }
  if (state.rowCount > shown) {
    return vi
      ? `Đang hiển thị ${shown} trong ${state.rowCount} dòng kết quả.`
      : `Showing ${shown} of ${state.rowCount} result rows.`;
  }
  return "";
}

function formatPreviewSummary(state: AgentState): string {
  const rows = state.resultPreview;
  const vi = isVietnamese(state.question);
  if (rows.length === 0) return statusMessage("ok", state.question);
  const firstKeys = Object.keys(rows[0]!);
  if (rows.length === 1 && firstKeys.length === 1) {
    const value = rows[0]![firstKeys[0]!];
    const formatted = formatCellValue(value, state.question);
    return vi ? `Kết quả cho điều kiện đã hỏi là ${formatted}.`
      : `The requested result is ${formatted}.`;
  }
  const shown = rows.slice(0, ANSWER_PREVIEW_ROWS);
  const formattedRows = shown.map((row) => Object.entries(row)
    .slice(0, 5)
    .map(([key, value]) => `${key}: ${formatCellValue(value, state.question)}`)
    .join(", "));
  const intro = state.rowCount !== null && !state.resultTruncated
    ? vi ? `Truy vấn trả về ${state.rowCount} dòng dữ liệu phù hợp.` : `The query returned ${state.rowCount} matching rows.`
    : vi ? "Truy vấn có dữ liệu phù hợp trong phần xem trước." : "The preview contains matching query rows.";
  return [intro, vi ? `Ví dụ: ${formattedRows.join("; ")}.` : `Examples: ${formattedRows.join("; ")}.`,
    previewCaveat(state, rows.length)].filter(Boolean).join(" ");
}

export function synthesizeAnswer(state: AgentState): AgentUpdate {
  if (state.budgetExceeded || state.status === "error") {
    const raw = state.answerText.trim();
    const safe = raw && (state.budgetExceeded || !RAW_SQL_ERROR.test(raw))
      ? raw : statusMessage("error", state.question);
    return { answerText: redactPII(safe).redacted };
  }

  if (state.status !== "ok" && state.status !== "no_data") {
    return { answerText: redactPII(state.answerText.trim() || statusMessage(state.status, state.question)).redacted };
  }
  if (state.status === "no_data") {
    const upstream = state.route !== "text-to-sql" ? state.answerText.trim() : "";
    return { answerText: upstream
      ? redactPII(upstream).redacted
      : statusMessage("no_data", state.question) };
  }
  if (state.answerText.trim().length > 0) {
    const { redacted, hit } = redactPII(state.answerText);
    return hit ? { answerText: redacted } : {};
  }

  const report = readVerifiedInsights(state.vizSpec);
  if (report) {
    const combined = [...report.claims, ...report.caveats,
      previewCaveat(state, state.resultPreview.length)].filter(Boolean).join(" ");
    return { answerText: redactPII(combined).redacted };
  }

  const summary = formatPreviewSummary(state);
  return { answerText: redactPII(summary).redacted };
}

function budgetTripUpdate(
  state: AgentState,
  budget: BudgetState,
  reason: BudgetTripReason,
  startCalls: number,
  startTokens: number,
): AgentUpdate {
  return {
    status: "error",
    budgetExceeded: true,
    answerText: formatBudgetTripTemplate({
      reason,
      budget,
      completed: [
        ...state.tablesUsed.map((table) => `Queried table ${table}`),
        ...(state.rowCount !== null ? [`Verified query returned ${state.rowCount} rows`] : []),
      ],
      verifiedSql: state.sql,
      rowCount: state.rowCount ?? undefined,
      remaining: ["Finish natural-language answer verification"],
    }),
    budget: { llmCalls: budget.llmCalls - startCalls, tokensUsed: budget.tokensUsed - startTokens },
  };
}

export function createAnswerSynthesizer(deps: AnswerSynthesizerDeps = {}): SynthesizeFn {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    const started = Date.now();
    let update = synthesizeAnswer(state);
    let mode = "deterministic";
    const shouldDraft = state.route === "text-to-sql" && state.status === "ok" &&
      !state.budgetExceeded && state.answerText.trim() === "" &&
      readVerifiedInsights(state.vizSpec) === null && !skipModelAfterVizFailure(state.vizSpec) &&
      state.resultPreview.length > 0;
    if (shouldDraft) {
      const model = deps.model === null ? null : deps.model ??
        (process.env.AGENT_MODEL_API_KEY ? createChatModel("synthesis") : null);
      if (model !== null) {
        const prepared = prepareAnswerRows(state);
        if (prepared.rows.length > 0) {
          const startCalls = state.budget.llmCalls;
          const startTokens = state.budget.tokensUsed;
          const budget: BudgetState = {
            ...state.budget,
            deadlineMs: state.budget.deadlineMs > 0 ? state.budget.deadlineMs : Date.now() + BUDGET_LIMITS.runDeadlineMs,
          };
          const pre = checkBudget(budget);
          if (pre.tripped) {
            update = budgetTripUpdate(state, budget, pre.reason, startCalls, startTokens);
            mode = "budget_trip";
          } else {
            const role = (rt.config.configurable as Record<string, unknown> | undefined)?.["roleScope"];
            const prompt = buildAnswerPrompt(state, prepared, typeof role === "string" ? role : "authorized");
            try {
              const out = await invokeJsonWithUsage(model, AnswerDraftSchema, prompt, {
                budget,
                deadlineMs: budget.deadlineMs,
                emit: rt.emit,
                node: "answer",
                name: "answer_draft",
                formatReaskLimit: 1,
              });
              const usage = unaccountedUsage(out);
              const tokens = usage.inputTokens + usage.outputTokens;
              recordLlmCall(budget, tokens > 0 ? tokens : estimateTokens(prompt, JSON.stringify(out.parsed)));
              const checked = verifyAnswerDraft(out.parsed, state, prepared);
              update = {
                ...update,
                ...(checked !== null ? {
                  answerText: [checked, previewCaveat(state, prepared.rows.length)].filter(Boolean).join(" "),
                } : {}),
                budget: { llmCalls: budget.llmCalls - startCalls, tokensUsed: budget.tokensUsed - startTokens },
                telemetry: {
                  promptTokens: out.inputTokens,
                  completionTokens: out.outputTokens,
                  latencyMs: Date.now() - started,
                },
              };
              mode = checked !== null ? "model_verified" : "validation_fallback";
            } catch (error) {
              const tripReason = budgetTripReasonFromError(error) ??
                (Date.now() >= budget.deadlineMs ? "deadline" : undefined);
              update = tripReason
                ? budgetTripUpdate(state, budget, tripReason, startCalls, startTokens)
                : {
                  ...update,
                  budget: { llmCalls: budget.llmCalls - startCalls, tokensUsed: budget.tokensUsed - startTokens },
                };
              mode = tripReason ? "budget_trip" : "model_fallback";
            }
          }
        }
      }
    }
    if (state.answerText.trim().length === 0 || mode !== "deterministic") {
      rt.emit({
        node: "answer",
        type: "node_done",
        durationMs: Date.now() - started,
        payload: {
          status: update.status ?? state.status,
          answerLength: typeof update.answerText === "string" ? update.answerText.length : state.answerText.length,
          mode,
        },
      });
    }
    return finalizeTurnMemory(state, update);
  };
}
