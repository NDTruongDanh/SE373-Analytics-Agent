// Generic answer seam (#104): the default `synthesize` of the frozen root
// builder is the tracer demo formatter (orders-by-status), so hosts inject
// this one. UC-03 VIZ owns the chart and verified insights but never writes
// answerText; this seam turns them into the user-facing answer.
//
// Deterministic and tool-free: it only reads state the harness already
// verified (UC-03 claims survived the numeric validator) and the masked
// ≤50-row preview. Output passes through the PII redactor as a last line.
import { redactPII } from "@shared/access-policy";
import type { AgentState, AgentUpdate, SynthesizeFn } from "../state.js";

/** Rows echoed in the deterministic fallback answer. */
export const ANSWER_PREVIEW_ROWS = 5;

const NUMBER_FORMAT = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

function formatCell(value: unknown): string {
  if (typeof value === "number") return NUMBER_FORMAT.format(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return NUMBER_FORMAT.format(Number(value));
  }
  if (value === null || value === undefined) return "—";
  return String(value);
}

function verifiedInsights(state: AgentState): string[] {
  const spec = state.vizSpec as
    | { kind?: unknown; report?: { insights?: { claim?: unknown }[] } }
    | null;
  if (!spec || spec.kind !== "insight_report") return [];
  return (spec.report?.insights ?? [])
    .map((insight) => (typeof insight.claim === "string" ? insight.claim.trim() : ""))
    .filter((claim) => claim !== "");
}

function previewLines(state: AgentState): string[] {
  const columns =
    state.columns.length > 0 ? state.columns : Object.keys(state.resultPreview[0] ?? {});
  return state.resultPreview
    .slice(0, ANSWER_PREVIEW_ROWS)
    .map((row) => `- ${columns.map((col) => `${col}: ${formatCell(row[col])}`).join(", ")}`);
}

/** Pure answer builder; exported for tests. */
export function synthesizeAnswer(state: AgentState): AgentUpdate {
  // Handlers that already wrote an answer (errors, clarifications, RCA,
  // definition fast-path, restricted) keep it.
  if (state.answerText.length > 0) return {};
  if (state.status !== "ok" && state.status !== "no_data") return {};
  if (state.resultPreview.length === 0) {
    return {
      status: "no_data",
      answerText: "Không có dữ liệu phù hợp với câu hỏi.",
    };
  }
  const insights = verifiedInsights(state);
  const shown = Math.min(state.resultPreview.length, ANSWER_PREVIEW_ROWS);
  const header =
    shown < state.resultPreview.length
      ? `Kết quả (${String(shown)}/${String(state.resultPreview.length)} dòng đầu):`
      : `Kết quả (${String(shown)} dòng):`;
  const body =
    insights.length > 0
      ? insights.map((claim) => `- ${claim}`).join("\n")
      : [header, ...previewLines(state)].join("\n");
  return { status: "ok", answerText: redactPII(body).redacted };
}

export function createAnswerSynthesizer(): SynthesizeFn {
  return (state: AgentState) => Promise.resolve(synthesizeAnswer(state));
}
