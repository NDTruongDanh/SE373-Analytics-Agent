import { redactPII } from "@shared/access-policy";
import { DEFAULT_ROUTE_ID } from "../constants.js";
import type {
  AgentState,
  AgentStatus,
  AgentUpdate,
  RootRuntime,
  SynthesizeFn,
} from "../state.js";

export const ANSWER_PREVIEW_ROWS = 5;
const NUMBER_FORMAT = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });

const STATUS_FALLBACK_MESSAGES: Partial<Record<AgentStatus, string>> = {
  cannot_answer: "Cannot answer the question from the available schema or data.",
  needs_clarification: "Clarification is needed before running the query.",
  restricted: "Access to this data is restricted by policy.",
  false_premise: "The question could not be answered because its premise does not match the data.",
  error: "Unable to complete the query due to an execution error.",
  no_data: "Không có dữ liệu phù hợp với câu hỏi.",
};

interface VizInsightClaim {
  claim: string;
}

interface VizSpecReport {
  insights?: VizInsightClaim[];
  caveats?: string[];
}

interface VizSpecPayload {
  kind?: string;
  report?: VizSpecReport;
}

function readVerifiedInsights(vizSpec: unknown): {
  claims: string[];
  caveats: string[];
} {
  if (!vizSpec || typeof vizSpec !== "object") {
    return { claims: [], caveats: [] };
  }
  const payload = vizSpec as VizSpecPayload;
  if (payload.kind !== "insight_report" || !payload.report) {
    return { claims: [], caveats: [] };
  }
  const rawInsights = Array.isArray(payload.report.insights)
    ? payload.report.insights
    : [];
  const rawCaveats = Array.isArray(payload.report.caveats)
    ? payload.report.caveats
    : [];
  const claims = rawInsights
    .map((item) => (item && typeof item.claim === "string" ? item.claim.trim() : ""))
    .filter((claim) => claim.length > 0);
  const caveats = rawCaveats
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c) => c.length > 0);
  return { claims, caveats };
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return NUMBER_FORMAT.format(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function formatPreviewSummary(
  rows: readonly Record<string, unknown>[],
  tablesUsed: readonly string[],
): string {
  if (rows.length === 0) {
    return "Query succeeded with 0 matching rows.";
  }
  const firstKeys = Object.keys(rows[0]!);
  if (rows.length === 1 && firstKeys.length === 1) {
    const col = firstKeys[0]!;
    return `${col}: ${formatCellValue(rows[0]![col])}`;
  }
  const shown = rows.slice(0, ANSWER_PREVIEW_ROWS);
  const formattedRows = shown.map((row) => {
    const pairs = Object.entries(row)
      .map(([k, v]) => `${k}=${formatCellValue(v)}`)
      .join(", ");
    return `[${pairs}]`;
  });
  const suffix = rows.length > ANSWER_PREVIEW_ROWS ? "; ..." : "";
  const source =
    tablesUsed.length > 0 ? ` from ${tablesUsed.join(", ")}` : "";
  return `Returned ${rows.length} rows${source}: ${formattedRows.join("; ")}${suffix}`;
}

export function synthesizeAnswer(state: AgentState): AgentUpdate {
  if (state.budgetExceeded || state.status === "error") {
    const answerText =
      state.answerText.trim().length > 0
        ? state.answerText
        : STATUS_FALLBACK_MESSAGES.error ?? "Unable to complete the query due to an execution error.";
    return { answerText: redactPII(answerText).redacted };
  }

  if (state.answerText.trim().length > 0) {
    const { redacted, hit } = redactPII(state.answerText);
    return hit ? { answerText: redacted } : {};
  }

  if (state.status !== "ok") {
    const fallback =
      STATUS_FALLBACK_MESSAGES[state.status] ??
      "Unable to answer the question.";
    return { answerText: fallback };
  }

  const { claims, caveats } = readVerifiedInsights(state.vizSpec);
  if (claims.length > 0) {
    const combined =
      caveats.length > 0
        ? `${claims.join(" ")} (${caveats.join("; ")})`
        : claims.join(" ");
    return { answerText: redactPII(combined).redacted };
  }

  const summary = formatPreviewSummary(state.resultPreview, state.tablesUsed);
  return { answerText: redactPII(summary).redacted };
}

export function createAnswerSynthesizer(): SynthesizeFn {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    const started = Date.now();
    const update = synthesizeAnswer(state);
    // Skip span emission when upstream handlers or the default route already answered.
    const shouldEmit =
      state.ucId !== DEFAULT_ROUTE_ID && state.answerText.trim().length === 0;
    if (shouldEmit) {
      const nextText =
        typeof update.answerText === "string"
          ? update.answerText
          : state.answerText;
      rt.emit({
        node: "answer",
        type: "node_done",
        durationMs: Date.now() - started,
        payload: {
          status: state.status,
          answerLength: nextText.length,
        },
      });
    }
    return update;
  };
}
