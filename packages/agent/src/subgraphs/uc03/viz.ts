// UC-03 VIZ seam (docs/UC-plan/UC03.md §2.1, architecture §2.2 VERIFY).
//
// `createUc03Viz()` builds the `VizFn` the frozen root builder runs as
// `vizSeam` for every `ok` / `no_data` answer:
//
//   ValidatedQueryExecutor → RunQueryOutput (≤50-row preview in state)
//     → select_chart (deterministic selector, never model vibes)
//     → synthesize_insights (Profile 3, ZERO tools, <untrusted_data>)
//     → K7 render_chart validator (headless, ≤ 2 repairs, Table fallback)
//     → K7 numeric + causal validator (≤ 1% tolerance, strip + log)
//     → vizSpec { kind: "insight_report", report, openuiLang }
//
// Keyless runs (no `AGENT_MODEL_API_KEY`) take the deterministic path: the
// spec is code-built from buffer cells, insights stay empty, and a caveat
// records that synthesis was skipped — chart validity holds with zero LLM
// calls. The live path drafts the full report through Profile 3 and
// verifies it the same way.
//
// Never throws for chart failures: after exhausted repairs the harness
// falls back to the deterministic Table spec, then to None. Never touches
// answerText/toolsCalled/status — the answer seam owns those.

import {
  InsightReportSchema,
  type ChartType,
  type InsightReport,
} from "@shared/contracts";
import { createChatModel } from "../../models/factory.js";
import { estimateTokens } from "../../queryExecutor/budgets.js";
import { estimateCostUsd } from "../../telemetry/usage.js";
import type {
  AgentState,
  AgentUpdate,
  RootRuntime,
  VizFn,
} from "../../state.js";
import { RESULT_PREVIEW_MAX } from "../../constants.js";
import {
  RENDER_REPAIR_LIMIT,
  buildTableSpec,
  validateChart,
} from "../../validators/renderChart.js";
import {
  selectChartType,
  type SelectorBuffer,
} from "../../validators/chartSelector.js";
import {
  verifyNumericClaims,
  type StrippedClaim,
} from "../../validators/claimValidator.js";
import { serializeOpenuiLang } from "./serialize.js";
import { buildSpecForChart } from "./specBuilders.js";
import {
  buildInsightPrompt,
  runVizDraft,
  type VizModelLike,
} from "./synthesize.js";

/** Node names for the UC-03 trace spans (all under the viz seam). */
export const UC03_VIZ_NODE = "viz";

export interface Uc03VizSpec {
  kind: "insight_report";
  report: InsightReport;
  openuiLang: string;
  stripped: StrippedClaim[];
  repairs: number;
  deterministic: boolean;
}

export interface Uc03VizDeps {
  /**
   * Profile-3 model. "auto" (default) uses the synthesis profile when
   * `AGENT_MODEL_API_KEY` is set, else the deterministic path. Pass null
   * to force deterministic mode (unit tests, keyless evals).
   */
  model?: VizModelLike | "auto" | null;
  /** Full transient buffer override (tests/evals); defaults to state preview. */
  buffer?: SelectorBuffer;
}

function resolveModel(deps: Uc03VizDeps): VizModelLike | null {
  if (deps.model === null) return null;
  if (deps.model !== undefined && deps.model !== "auto") return deps.model;
  if (!process.env.AGENT_MODEL_API_KEY) return null;
  return createChatModel("synthesis") as unknown as VizModelLike;
}

function bufferOf(state: AgentState, override?: SelectorBuffer): SelectorBuffer {
  if (override) return override;
  return { columns: state.columns, rows: state.resultPreview };
}

function fallbackReport(
  buffer: SelectorBuffer,
  chartType: ChartType,
  reason: string,
  extraCaveats: string[],
): InsightReport {
  let built = buildSpecForChart(chartType, buffer);
  let effective = chartType;
  if (built === null) {
    built = buildTableSpec(buffer);
    effective = "table";
  }
  if (built.chart === "None") {
    effective = "none";
  } else if (built.chart === "Table") {
    effective = "table";
  }
  const validated = validateChart(effective, built, buffer);
  // Code-built specs validate by construction (cells plucked from the same
  // buffer), so the None branch is unreachable — kept fail-closed so a
  // validator regression can never ship a bad spec.
  if (!validated.ok) {
    return InsightReportSchema.parse({
      chartType: "none" as const,
      chartSpec: { chart: "None" as const },
      chartReason: reason,
      insights: [],
      caveats: extraCaveats,
    });
  }
  return InsightReportSchema.parse({
    chartType: effective,
    chartSpec: validated.spec,
    chartReason:
      effective === chartType
        ? reason
        : `${reason} Fell back to ${effective}: the buffer backs no ${chartType} chart.`,
    insights: [],
    caveats: extraCaveats,
  });
}

export function createUc03Viz(deps: Uc03VizDeps = {}): VizFn {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    if (state.status !== "ok" && state.status !== "no_data") return {};
    const started = Date.now();
    const buffer = bufferOf(state, deps.buffer);
    const selection = selectChartType(buffer, state.status);
    rt.emit({
      node: UC03_VIZ_NODE,
      type: "chart_selected",
      durationMs: 0,
      payload: { chartType: selection.chartType, columns: state.columns },
    });

    const model = resolveModel(deps);
    const truncated = state.resultPreview.length >= RESULT_PREVIEW_MAX;
    const baseCaveats =
      state.status === "no_data"
        ? ["No rows matched the filters; no chart is drawn."]
        : truncated
          ? [`Result preview is capped at ${RESULT_PREVIEW_MAX} rows.`]
          : [];

    let report: InsightReport;
    let stripped: StrippedClaim[] = [];
    let repairs = 0;
    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let modelId: string | undefined;
    let estimatedCostUsd = 0;

    if (model === null || state.status === "no_data") {
      // Deterministic path: code-built spec, no insights, explicit caveat.
      const caveats =
        model === null && state.status === "ok"
          ? [...baseCaveats, "Insight synthesis skipped: no model key configured."]
          : baseCaveats;
      report = fallbackReport(buffer, selection.chartType, selection.reason, caveats);
    } else {
      const promptInput = {
        question: state.question,
        chartType: selection.chartType,
        chartReasonHint: selection.reason,
        columns: state.columns,
        preview: state.resultPreview,
        truncated,
      };
      const promptText = buildInsightPrompt(promptInput);
      try {
        const outcome = await runVizDraft(model, promptInput, buffer);
        repairs = outcome.repairs;
        llmCalls = 1 + outcome.repairs;
        promptTokens = outcome.usage.inputTokens;
        completionTokens = outcome.usage.outputTokens;
        modelId = outcome.usage.model;
        const priced = estimateCostUsd(modelId, promptTokens, completionTokens);
        estimatedCostUsd = priced.estimatedCostUsd;
        const eventIds = state.semanticChunks.map((chunk) => chunk.chunkId);
        const checked = verifyNumericClaims(outcome.draft.insights, buffer, { eventIds });
        stripped = checked.stripped;
        const caveats = [...outcome.draft.caveats, ...baseCaveats];
        // Stripped claims are always surfaced: the user sees what was
        // removed and why (the trace carries the per-claim reason).
        if (stripped.length > 0) {
          caveats.push(
            `${stripped.length} draft claim(s) failed numeric verification and were removed.`,
          );
        }
        if (checked.verified.length === 0 && stripped.length === 0) {
          caveats.push("No verifiable claims could be grounded in the query results.");
        }
        report = InsightReportSchema.parse({
          ...outcome.draft,
          insights: checked.verified,
          caveats,
        });
      } catch {
        // Model or repair failure: deterministic fallback, traced below.
        // The failed attempts still spent budget — account for all of them.
        repairs = RENDER_REPAIR_LIMIT;
        llmCalls = 1 + RENDER_REPAIR_LIMIT;
        promptTokens = estimateTokens(promptText, "fallback");
        report = fallbackReport(buffer, selection.chartType, selection.reason, [
          ...baseCaveats,
          "Draft validation failed after 2 repairs; showing the result table instead.",
        ]);
      }
      if (promptTokens === 0 && completionTokens === 0) {
        const estimate = estimateTokens(promptText, JSON.stringify(report));
        promptTokens = estimate;
      }
    }

    rt.emit({
      node: UC03_VIZ_NODE,
      type: "chart_validated",      durationMs: 0,
      payload: {
        chartType: report.chartType,
        repairs,
        strippedClaims: stripped.length,
      },
    });
    for (const item of stripped) {
      rt.emit({
        node: UC03_VIZ_NODE,
        type: "claim_stripped",
        durationMs: 0,
        payload: { claimIndex: item.claimIndex, reason: item.reason },
      });
    }

    const openuiLang = serializeOpenuiLang({
      title: state.question.slice(0, 200) || "Query results",
      spec: report.chartSpec,
      notes: report.insights.slice(0, 2).map((insight) => insight.claim),
    });
    const durationMs = Date.now() - started;
    rt.emit({
      node: UC03_VIZ_NODE,
      type: "node_done",
      durationMs,
      payload: {
        model: modelId ?? (model === null ? "deterministic" : "unmetered"),
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        estimatedCostUsd,
        strippedClaims: stripped.length,
      },
    });

    const spec: Uc03VizSpec = {
      kind: "insight_report",
      report,
      openuiLang,
      stripped,
      repairs,
      deterministic: model === null,
    };
    return {
      vizSpec: spec,
      budget: { llmCalls, tokensUsed: promptTokens + completionTokens },
      telemetry: { promptTokens, completionTokens, latencyMs: durationMs },
    };
  };
}
