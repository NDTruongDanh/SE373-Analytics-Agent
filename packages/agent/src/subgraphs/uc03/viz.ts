import {
  InsightReportSchema,
  type ChartType,
  type InsightReport,
} from "@shared/contracts";
import {
  createChatModel,
  createSemanticCacheContext,
} from "../../models/factory.js";
import {
  budgetTripReasonFromError,
  checkBudget,
  estimateTokens,
  formatBudgetTripTemplate,
  type BudgetState,
  type BudgetTripReason,
} from "../../queryExecutor/budgets.js";
import { takeTransientQueryBuffer } from "../../queryExecutor/transientBuffer.js";
import { classifyModelReaskFailure, isRateLimitFailure } from "../../telemetry/retry.js";
import { estimateCostUsd } from "../../telemetry/usage.js";
import type {
  AgentState,
  AgentUpdate,
  RootRuntime,
  VizFn,
} from "../../state.js";
import { BUDGET_LIMITS, RESULT_PREVIEW_MAX } from "../../constants.js";
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
  isCaveatClaim,
  isNegativeMovementClaim,
  verifyNumericClaims,
  type StrippedClaim,
} from "../../validators/claimValidator.js";
import { serializeOpenuiLang } from "./serialize.js";
import { buildSpecForChart } from "./specBuilders.js";
import {
  buildInsightPrompt,
  runClaimRegeneration,
  runVizDraft,
  type ClaimRepairDiff,
  type VizModelLike,
} from "./synthesize.js";

export const UC03_VIZ_NODE = "viz";

export const TRUNCATION_CAVEAT =
  "Query results were truncated; totals or shares cannot be inferred from the partial result set.";

export const NARRATIVE_DOWNGRADE_CAVEAT =
  "Toàn bộ nhận định đã bị ẩn để tránh báo cáo một chiều sau khi loại nhận định tiêu cực hoặc cảnh báo duy nhất.";

export interface Uc03VizSpec {
  kind: "insight_report";
  report: InsightReport;
  openuiLang: string;
  stripped: StrippedClaim[];
  repairs: number;
  deterministic: boolean;
  regeneratedClaims?: boolean;
  narrativeDowngraded?: boolean;
}

export interface Uc03VizDeps {
  model?: VizModelLike | "auto" | null;
  buffer?: SelectorBuffer & { truncated?: boolean };
  truncated?: boolean;
}

function resolveModel(
  deps: Uc03VizDeps,
  state: AgentState,
  rt: RootRuntime,
): VizModelLike | null {
  if (deps.model === null) return null;
  if (deps.model !== undefined && deps.model !== "auto") return deps.model;
  if (!process.env.AGENT_MODEL_API_KEY) return null;
  const configurable = (rt.config.configurable ?? {}) as Record<string, unknown>;
  const role = typeof configurable["roleScope"] === "string"
    ? configurable["roleScope"] as string
    : undefined;
  const rowScope = Object.hasOwn(configurable, "rowScope")
    ? configurable["rowScope"]
    : undefined;
  return createChatModel("synthesis", {
    semanticCacheContext: createSemanticCacheContext({
      analysisState: {
        question: state.question,
        intent: state.intent,
        analysisPlan: state.analysisPlan,
        status: state.status,
        tablesUsed: state.tablesUsed,
      },
      semanticChunks: state.semanticChunks,
      role,
      rowScope,
    }),
  }) as unknown as VizModelLike;
}

function hasTruncationCaveat(caveats: readonly string[]): boolean {
  return caveats.some((c) => /(truncat|bị cắt|partial result)/i.test(c));
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
  // Fail-closed guard: unreachable for code-built specs unless a validator regression rejects them.
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

function budgetExceededUpdate(
  state: AgentState,
  rt: RootRuntime,
  budget: BudgetState,
  startCalls: number,
  startTokens: number,
  reason: BudgetTripReason,
): AgentUpdate {
  rt.emit({
    node: UC03_VIZ_NODE,
    type: "node_done",
    durationMs: 0,
    payload: { budgetExceeded: true, tripReason: reason, caveat: "budget_exceeded" },
  });
  return {
    status: "error",
    budgetExceeded: true,
    vizSpec: null,
    answerText: formatBudgetTripTemplate({
      reason,
      budget,
      completed: [
        ...state.tablesUsed.map((table) => `Queried table ${table}`),
        ...(state.rowCount !== null ? [`Verified query returned ${state.rowCount} rows`] : []),
      ],
      verifiedSql: state.sql,
      rowCount: state.rowCount ?? undefined,
      remaining: ["Finish chart and numeric claim verification"],
    }),
    budget: {
      llmCalls: budget.llmCalls - startCalls,
      tokensUsed: budget.tokensUsed - startTokens,
    },
  };
}

export function createUc03Viz(deps: Uc03VizDeps = {}): VizFn {
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    if (state.status !== "ok" && state.status !== "no_data") return {};
    const started = Date.now();
    const transient = deps.buffer ? undefined : takeTransientQueryBuffer(state.runId);
    const buffer: SelectorBuffer = deps.buffer
      ? { columns: deps.buffer.columns, rows: deps.buffer.rows }
      : transient
        ? { columns: transient.columns, rows: transient.rows }
        : { columns: state.columns, rows: state.resultPreview };
    const truncated = Boolean(
      deps.truncated ??
        deps.buffer?.truncated ??
        transient?.truncated ??
        state.resultTruncated,
    );

    const selection = selectChartType(buffer, state.status);
    rt.emit({
      node: UC03_VIZ_NODE,
      type: "chart_selected",
      durationMs: 0,
      payload: {
        chartType: selection.chartType,
        columns: buffer.columns,
        truncated,
      },
    });

    const model = resolveModel(deps, state, rt);
    const baseCaveats =
      state.status === "no_data"
        ? ["No rows matched the filters; no chart is drawn."]
        : truncated
          ? [TRUNCATION_CAVEAT]
          : [];

    let report: InsightReport;
    let stripped: StrippedClaim[] = [];
    let repairs = 0;
    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let modelId: string | undefined;
    let estimatedCostUsd = 0;
    let regeneratedClaims = false;
    let narrativeDowngraded = false;
    let budgetTokensUsed = 0;

    if (model === null || state.status === "no_data") {
      const caveats =
        model === null && state.status === "ok"
          ? [...baseCaveats, "Insight synthesis skipped: no model key configured."]
          : baseCaveats;
      report = fallbackReport(buffer, selection.chartType, selection.reason, caveats);
    } else {
      const startCalls = state.budget?.llmCalls ?? 0;
      const startTokens = state.budget?.tokensUsed ?? 0;
      const budget: BudgetState = {
        llmCalls: startCalls,
        tokensUsed: startTokens,
        maxLlmCalls: state.budget?.maxLlmCalls ?? BUDGET_LIMITS.maxLlmCalls,
        maxTokens: state.budget?.maxTokens ?? BUDGET_LIMITS.maxTokens,
        deadlineMs:
          state.budget?.deadlineMs && state.budget.deadlineMs > 0
            ? state.budget.deadlineMs
            : Date.now() + BUDGET_LIMITS.runDeadlineMs,
      };
      const preCheck = checkBudget(budget);
      if (preCheck.tripped) {
        return budgetExceededUpdate(state, rt, budget, startCalls, startTokens, preCheck.reason);
      } else {
        const previewRows =
          state.resultPreview.length > 0
            ? state.resultPreview
            : buffer.rows.slice(0, RESULT_PREVIEW_MAX);
        const promptInput = {
          question: state.question,
          chartType: selection.chartType,
          chartReasonHint: selection.reason,
          columns: buffer.columns.length > 0 ? buffer.columns : state.columns,
          preview: previewRows,
          truncated,
        };
        const promptText = buildInsightPrompt(promptInput);
        let rateLimitedFallback = false;
        try {
          const outcome = await runVizDraft(model, promptInput, buffer, {
            budget,
            deadlineMs: budget.deadlineMs,
            emit: rt.emit,
            node: UC03_VIZ_NODE,
          });
          repairs = outcome.repairs;
          llmCalls = budget.llmCalls - startCalls;
          promptTokens = outcome.usage.inputTokens;
          completionTokens = outcome.usage.outputTokens;
          modelId = outcome.usage.model;

          const eventIds = state.semanticChunks.map((chunk) => chunk.chunkId);
          let activeDraft = outcome.draft;
          let checked = verifyNumericClaims(activeDraft.insights, buffer, {
            eventIds,
            truncated,
          });

          if (checked.stripped.length > 0) {
            const diffs: ClaimRepairDiff[] = checked.stripped.map((item) => ({
              claimIndex: item.claimIndex,
              ...(item.expected !== undefined ? { expected: item.expected } : {}),
              ...(item.found !== undefined ? { found: item.found } : {}),
              reason: item.reason,
            }));
            const regenStarted = Date.now();
            const regen = await runClaimRegeneration(
              model,
              promptInput,
              buffer,
              diffs,
              {
                budget,
                deadlineMs: budget.deadlineMs,
                emit: rt.emit,
                node: UC03_VIZ_NODE,
              },
            );
            llmCalls = budget.llmCalls - startCalls;
            if (regen !== null) {
              regeneratedClaims = true;
              promptTokens += regen.usage.inputTokens;
              completionTokens += regen.usage.outputTokens;
              modelId = regen.usage.model ?? modelId;
              activeDraft = regen.draft;
              checked = verifyNumericClaims(activeDraft.insights, buffer, {
                eventIds,
                truncated,
              });
              rt.emit({
                node: UC03_VIZ_NODE,
                type: "claim_regenerated",
                durationMs: Date.now() - regenStarted,
                payload: { diffs, remainingStripped: checked.stripped.length },
              });
            }
          }

          const priced = estimateCostUsd(modelId, promptTokens, completionTokens);
          estimatedCostUsd = priced.estimatedCostUsd;
          stripped = checked.stripped;

          const caveats = [...activeDraft.caveats];
          if (checked.truncationCaveatRequired && !hasTruncationCaveat(caveats)) {
            caveats.push(TRUNCATION_CAVEAT);
          }

          let finalInsights = checked.verified;
          if (stripped.length > 0) {
            caveats.push(
              `${stripped.length} nhận định đã bị loại vì không khớp dữ liệu.`,
            );
            const strippedSoleNegative =
              stripped.some(
                (item) =>
                  isNegativeMovementClaim(item.claim) ||
                  item.expected === "decrease/lower",
              ) &&
              !checked.verified.some((item) => isNegativeMovementClaim(item.claim));
            const strippedSoleCaveat =
              stripped.some((item) => isCaveatClaim(item.claim)) &&
              !checked.verified.some((item) => isCaveatClaim(item.claim)) &&
              activeDraft.caveats.length === 0;
            if (strippedSoleNegative || strippedSoleCaveat) {
              finalInsights = [];
              narrativeDowngraded = true;
              caveats.push(NARRATIVE_DOWNGRADE_CAVEAT);
            }
          }
          if (finalInsights.length === 0 && stripped.length === 0) {
            caveats.push("No verifiable claims could be grounded in the query results.");
          }
          report = InsightReportSchema.parse({
            ...activeDraft,
            insights: finalInsights,
            caveats,
          });
        } catch (error) {
          llmCalls = budget.llmCalls - startCalls;
          const tripReason = budgetTripReasonFromError(error);
          if (tripReason) {
            return budgetExceededUpdate(state, rt, budget, startCalls, startTokens, tripReason);
          }
          if (isRateLimitFailure(error)) {
            rateLimitedFallback = true;
            repairs = 0;
            promptTokens = 0;
            completionTokens = 0;
            report = fallbackReport(buffer, selection.chartType, selection.reason, [
              ...baseCaveats,
              "Insight synthesis skipped: model rate-limited.",
            ]);
          } else {
            const formatFailure = classifyModelReaskFailure(error)?.formatFailure === true;
            repairs = formatFailure ? 0 : RENDER_REPAIR_LIMIT;
            promptTokens = estimateTokens(promptText, "fallback");
            report = fallbackReport(buffer, selection.chartType, selection.reason, [
              ...baseCaveats,
              formatFailure
                ? "Draft validation failed after one format re-ask; showing the result table instead."
                : "Draft validation failed after 2 chart repairs; showing the result table instead.",
            ]);
          }
        }
        if (!rateLimitedFallback && promptTokens === 0 && completionTokens === 0) {
          const estimate = estimateTokens(promptText, JSON.stringify(report));
          promptTokens = estimate;
        }
      }
      budgetTokensUsed = budget.tokensUsed - startTokens;
    }

    rt.emit({
      node: UC03_VIZ_NODE,
      type: "chart_validated",
      durationMs: 0,
      payload: {
        chartType: report.chartType,
        repairs,
        strippedClaims: stripped.length,
        regeneratedClaims,
        narrativeDowngraded,
      },
    });
    for (const item of stripped) {
      rt.emit({
        node: UC03_VIZ_NODE,
        type: "claim_stripped",
        durationMs: 0,
        payload: {
          claimIndex: item.claimIndex,
          ...(item.expected !== undefined ? { expected: item.expected } : {}),
          ...(item.found !== undefined ? { found: item.found } : {}),
          reason: item.reason,
        },
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
        regeneratedClaims,
        narrativeDowngraded,
      },
    });

    const spec: Uc03VizSpec = {
      kind: "insight_report",
      report,
      openuiLang,
      stripped,
      repairs,
      deterministic: model === null,
      ...(regeneratedClaims ? { regeneratedClaims: true } : {}),
      ...(narrativeDowngraded ? { narrativeDowngraded: true } : {}),
    };
    return {
      vizSpec: spec,
      budget: { llmCalls, tokensUsed: budgetTokensUsed },
      telemetry: { promptTokens, completionTokens, latencyMs: durationMs },
    };
  };
}
