import type {
  AnalysisPlan,
  InsightReport,
  PlanStep,
  RootCauseAnswer,
  SQLAnswer,
  TimePeriod,
} from "@shared/contracts";
import {
  AlertOctagon,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  GitBranch,
  Layers,
  Scale,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import { InsightChart, isTrustedOpenuiLang } from "@/charts";
import { SafeMarkdown } from "@/components/chat/SafeMarkdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface RootCauseDecompositionFactor {
  id?: string;
  label: string;
  effectType: "additive" | "rate" | "mix" | "lmdi" | "shapley";
  delta: number;
  contributionPct: number;
  sql?: string | null;
  description?: string;
}

export interface RootCauseViewProps {
  answer?: RootCauseAnswer | null;
  rootCause?: RootCauseAnswer | null;
  plan?: AnalysisPlan | null;
  steps?: PlanStep[];
  status?: SQLAnswer["status"];
  falsePremise?: boolean;
  message?: string;
  sql?: string | null;
  metricName?: string;
  baselineVal?: number;
  currentVal?: number;
  absDelta?: number;
  pctDelta?: number;
  baselinePeriod?: TimePeriod;
  currentPeriod?: TimePeriod;
  viz?: {
    title?: string;
    report: InsightReport;
    openuiLang: string;
    streaming?: boolean;
  } | null;
  decompositionFactors?: RootCauseDecompositionFactor[];
}

interface ChartableEntry {
  label: string;
  delta: number;
  contributionPct: number;
}

function formatMetricValue(
  value: number,
  metricName: string,
  metricType?: AnalysisPlan["metricType"],
): string {
  if (!Number.isFinite(value)) return "—";
  const lower = metricName.toLowerCase();
  if (lower.includes("rate") || lower.includes("ratio") || lower.includes("pct")) {
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    return `${pct.toFixed(2)}%`;
  }
  if (lower.includes("order") && !lower.includes("aov") && metricType === "additive") {
    return `${value.toLocaleString("vi-VN")} đơn`;
  }
  if (Math.abs(value) >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)} tỷ VNĐ`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")} triệu VNĐ`;
  }
  return `${value.toLocaleString("vi-VN")} VNĐ`;
}

function formatSignedDelta(
  value: number,
  metricName: string,
  metricType?: AnalysisPlan["metricType"],
): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatMetricValue(Math.abs(value), metricName, metricType)}`;
}

function formatSignedPct(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function detectPremiseContradiction(
  question: string | undefined,
  explicitDirection: "increase" | "decrease" | undefined,
  absDelta: number | undefined,
): boolean {
  if (absDelta === undefined || !Number.isFinite(absDelta) || absDelta === 0) {
    return false;
  }
  if (explicitDirection === "decrease" && absDelta > 0) return true;
  if (explicitDirection === "increase" && absDelta < 0) return true;
  if (!question) return false;
  const q = question.toLowerCase();
  const hasInc = /(?:tăng|tăng vọt|tăng trưởng|đột biến|cao hơn|spike|surge|increase)/i.test(q);
  const hasDec = /(?:giảm|sụt giảm|tụt|rơi|thấp hơn|suy giảm|drop|decrease|plummet)/i.test(q);
  if (hasDec && !hasInc && absDelta > 0) return true;
  if (hasInc && !hasDec && absDelta < 0) return true;
  return false;
}

function buildGeneratedOpenuiChart(
  title: string,
  items: ChartableEntry[],
  mode: "bar" | "table",
): { report: InsightReport; lang: string } | null {
  if (items.length === 0) return null;
  const bounded = items.slice(0, 10);
  const labels = bounded.map((item) => item.label.slice(0, 80) || "Nhánh");
  const deltas = bounded.map((item) => Number(item.delta.toFixed(2)));
  const contributions = bounded.map((item) => Number(item.contributionPct.toFixed(2)));
  const safeTitle = title.slice(0, 200) || "Phân rã nguyên nhân gốc rễ";

  if (mode === "table") {
    const report: InsightReport = {
      chartType: "table",
      chartSpec: {
        chart: "Table",
        columns: [
          { label: "Nhánh / Nhân tử", data: labels, type: "string" },
          { label: "Biến động (Δ)", data: deltas, type: "number" },
          { label: "Đóng góp (%)", data: contributions, type: "number" },
        ],
      },
      chartReason: "Bảng phân rã đóng góp và biến động theo từng nguyên nhân được xác minh.",
      insights: [],
      caveats: [],
    };
    const lang = [
      "root = Card([title, chart])",
      `title = TextContent(${JSON.stringify(safeTitle)}, "large-heavy")`,
      "chart = Table([c1, c2, c3])",
      `c1 = Col("Nhánh / Nhân tử", ${JSON.stringify(labels)}, "string")`,
      `c2 = Col("Biến động (Δ)", ${JSON.stringify(deltas)}, "number")`,
      `c3 = Col("Đóng góp (%)", ${JSON.stringify(contributions)}, "number")`,
    ].join("\n");
    return { report, lang };
  }

  const report: InsightReport = {
    chartType: "bar",
    chartSpec: {
      chart: "BarChart",
      labels,
      series: [{ category: "Đóng góp (%)", values: contributions }],
      variant: "grouped",
    },
    chartReason: "So sánh tỷ trọng đóng góp (%) giữa các nguyên nhân và phân đoạn.",
    insights: [],
    caveats: [],
  };
  const lang = [
    "root = Card([title, chart])",
    `title = TextContent(${JSON.stringify(safeTitle)}, "large-heavy")`,
    'chart = BarChart(labels, [s1], "grouped")',
    `labels = ${JSON.stringify(labels)}`,
    `s1 = Series("Đóng góp (%)", ${JSON.stringify(contributions)})`,
  ].join("\n");
  return { report, lang };
}

function stepStatusBadge(status: PlanStep["status"]): {
  variant: "success" | "secondary" | "destructive" | "warning" | "outline";
  label: string;
} {
  switch (status) {
    case "done":
      return { variant: "success", label: "done · Hoàn thành" };
    case "skipped":
      return { variant: "secondary", label: "skipped · Bỏ qua" };
    case "failed":
      return { variant: "destructive", label: "failed · Lỗi" };
    case "doing":
      return { variant: "warning", label: "doing · Đang chạy" };
    case "todo":
      return { variant: "outline", label: "todo · Chờ chạy" };
  }
}

function unexploredReasonLabel(reason: string): string {
  switch (reason) {
    case "MAX_QUERIES_REACHED":
      return "Chạm giới hạn số truy vấn";
    case "MAX_DEPTH_REACHED":
      return "Chạm giới hạn độ sâu";
    case "PRUNED_BELOW_THRESHOLD":
      return "Cắt tỉa dưới ngưỡng đóng góp";
    default:
      return reason;
  }
}

function effectTypeLabel(effectType: RootCauseDecompositionFactor["effectType"]): string {
  switch (effectType) {
    case "rate":
      return "Rate Effect (Hiệu ứng tỷ suất)";
    case "mix":
      return "Mix Effect (Hiệu ứng cơ cấu)";
    case "lmdi":
      return "LMDI-I Factor (Nhân tử log-mean)";
    case "shapley":
      return "Shapley Factor (Phân bổ tương tác)";
    case "additive":
      return "Additive Waterfall (Cộng tính)";
  }
}

export function RootCauseView({
  answer: answerProp,
  rootCause: rootCauseProp,
  plan,
  steps: stepsProp,
  status,
  falsePremise: falsePremiseProp,
  message,
  sql: sqlProp,
  metricName: metricNameProp,
  baselineVal: baselineValProp,
  currentVal: currentValProp,
  absDelta: absDeltaProp,
  pctDelta: pctDeltaProp,
  baselinePeriod: baselinePeriodProp,
  currentPeriod: currentPeriodProp,
  viz,
  decompositionFactors,
}: RootCauseViewProps) {
  const answer = answerProp ?? rootCauseProp ?? null;
  const effectiveMetric = metricNameProp ?? answer?.metricName ?? plan?.metricName ?? "net_revenue";
  const effectiveMetricType = answer?.metricType ?? plan?.metricType ?? "additive";
  const effectiveBaselineVal = baselineValProp ?? answer?.baselineVal ?? plan?.baselineVal;
  const effectiveCurrentVal = currentValProp ?? answer?.currentVal ?? plan?.currentVal;
  const effectiveAbsDelta = absDeltaProp ?? answer?.absDelta ?? plan?.absDelta;
  const effectivePctDelta = pctDeltaProp ?? answer?.pctDelta ?? plan?.pctDelta;
  const effectiveBaselinePeriod = baselinePeriodProp ?? answer?.baselinePeriod ?? plan?.baselinePeriod;
  const effectiveCurrentPeriod = currentPeriodProp ?? answer?.currentPeriod ?? plan?.currentPeriod;
  const effectiveQuestion = answer?.question ?? plan?.question;

  const isFalsePremise = Boolean(
    status === "false_premise" ||
      falsePremiseProp ||
      (plan && plan.isValidBaseline === false) ||
      detectPremiseContradiction(effectiveQuestion, plan?.direction, effectiveAbsDelta),
  );

  const effectiveSteps = useMemo<PlanStep[]>(() => {
    if (stepsProp && stepsProp.length > 0) return stepsProp;
    if (plan?.steps && plan.steps.length > 0) return plan.steps;
    if (!answer) return [];
    const fromCauses: PlanStep[] = answer.primaryCauses.map((cause) => ({
      stepId: cause.stepId,
      axis: cause.axis,
      dimensionOrFactor: cause.dimensionOrFactor,
      dimensionValue: cause.dimensionValue,
      dimensionPath: cause.dimensionPath,
      parentId: null,
      depth: Math.max(0, cause.dimensionPath.length - 1),
      status: "done",
      delta: cause.delta,
      contributionPct: cause.contributionPct,
      sql: cause.sql,
      retryCount: 0,
      hypothesis: cause.hypothesis,
    }));
    const fromUnexplored: PlanStep[] = answer.unexploredBranches.map((ub, index) => ({
      stepId: `skipped_${ub.dimensionOrFactor}_${index}`,
      axis: ub.axis,
      dimensionOrFactor: ub.dimensionOrFactor,
      dimensionValue: ub.dimensionValue,
      dimensionPath: ub.dimensionValue ? [ub.dimensionValue] : [ub.dimensionOrFactor],
      parentId: ub.parentId,
      depth: 0,
      status: "skipped",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
      hypothesis: unexploredReasonLabel(ub.reason),
    }));
    return [...fromCauses, ...fromUnexplored];
  }, [stepsProp, plan, answer]);

  const formulaSteps = useMemo(
    () => effectiveSteps.filter((step) => step.axis === "formula"),
    [effectiveSteps],
  );

  const chartItems = useMemo<ChartableEntry[]>(() => {
    if (answer && answer.primaryCauses.length > 0) {
      return answer.primaryCauses.map((cause) => ({
        label:
          cause.dimensionPath.length > 0
            ? cause.dimensionPath.join(" > ")
            : (cause.dimensionValue ?? cause.dimensionOrFactor),
        delta: cause.delta,
        contributionPct: cause.contributionPct,
      }));
    }
    const doneSteps = effectiveSteps.filter((step) => step.status === "done");
    if (doneSteps.length > 0) {
      return doneSteps.map((step) => ({
        label:
          step.dimensionPath.length > 0
            ? step.dimensionPath.join(" > ")
            : (step.dimensionValue ?? step.dimensionOrFactor),
        delta: step.delta,
        contributionPct: step.contributionPct,
      }));
    }
    if (decompositionFactors && decompositionFactors.length > 0) {
      return decompositionFactors.map((factor) => ({
        label: factor.label,
        delta: factor.delta,
        contributionPct: factor.contributionPct,
      }));
    }
    return [];
  }, [answer, effectiveSteps, decompositionFactors]);

  const hasTrustedExternalViz = Boolean(
    viz && viz.openuiLang && isTrustedOpenuiLang(viz.openuiLang) && viz.report.chartType !== "none",
  );

  const [chartMode, setChartMode] = useState<"harness" | "bar" | "table">(
    hasTrustedExternalViz ? "harness" : "bar",
  );
  const [openSqlDrawers, setOpenSqlDrawers] = useState<Record<string, boolean>>({});
  const [showMarkdown, setShowMarkdown] = useState(false);

  const activeChart = useMemo(() => {
    if (chartMode === "harness" && hasTrustedExternalViz && viz) {
      return {
        title: viz.title ?? effectiveQuestion ?? "Biểu đồ phân rã nguyên nhân",
        report: viz.report,
        lang: viz.openuiLang,
        streaming: viz.streaming ?? false,
      };
    }
    const mode = chartMode === "table" ? "table" : "bar";
    const generated = buildGeneratedOpenuiChart(
      effectiveQuestion ?? `Phân rã biến động ${effectiveMetric}`,
      chartItems,
      mode,
    );
    if (!generated) return null;
    return {
      title: effectiveQuestion ?? `Phân rã biến động ${effectiveMetric}`,
      report: generated.report,
      lang: generated.lang,
      streaming: false,
    };
  }, [chartMode, hasTrustedExternalViz, viz, effectiveQuestion, effectiveMetric, chartItems]);

  const offsettingSummary = useMemo(() => {
    const items =
      answer && answer.primaryCauses.length > 0
        ? answer.primaryCauses.map((c) => ({
            label:
              c.dimensionPath.length > 0
                ? c.dimensionPath.join(" > ")
                : (c.dimensionValue ?? c.dimensionOrFactor),
            delta: c.delta,
            contributionPct: c.contributionPct,
          }))
        : effectiveSteps
            .filter((s) => s.status === "done" && s.axis === "dimension")
            .map((s) => ({
              label:
                s.dimensionPath.length > 0
                  ? s.dimensionPath.join(" > ")
                  : (s.dimensionValue ?? s.dimensionOrFactor),
              delta: s.delta,
              contributionPct: s.contributionPct,
            }));

    if (items.length === 0) return null;
    const positive = items.filter((item) => item.delta > 0);
    const negative = items.filter((item) => item.delta < 0);
    const grossMovement = items.reduce((sum, item) => sum + Math.abs(item.delta), 0);
    const netDelta = effectiveAbsDelta ?? items.reduce((sum, item) => sum + item.delta, 0);
    const hasOppositeSigns = positive.length > 0 && negative.length > 0;
    const isNearZeroNet = grossMovement > 0 && Math.abs(netDelta) < 0.1 * grossMovement;
    const hasOver100Pct = items.some((item) => Math.abs(item.contributionPct) > 100);

    if (!hasOppositeSigns && !isNearZeroNet && !hasOver100Pct) {
      return null;
    }

    return {
      positiveCount: positive.length,
      negativeCount: negative.length,
      grossMovement,
      isNearZeroNet,
      positiveSum: positive.reduce((sum, i) => sum + i.delta, 0),
      negativeSum: negative.reduce((sum, i) => sum + i.delta, 0),
    };
  }, [answer, effectiveSteps, effectiveAbsDelta]);

  const rateMixFactors = useMemo(() => {
    if (!decompositionFactors) return [];
    return decompositionFactors.filter(
      (f) => f.effectType === "rate" || f.effectType === "mix",
    );
  }, [decompositionFactors]);

  const lmdiFactors = useMemo(() => {
    if (!decompositionFactors) return [];
    return decompositionFactors.filter(
      (f) => f.effectType === "lmdi" || f.effectType === "shapley",
    );
  }, [decompositionFactors]);

  const hasRateMixMode =
    rateMixFactors.length > 0 || effectiveMetricType === "ratio";
  const hasLmdiMode =
    lmdiFactors.length > 0 ||
    (effectiveMetricType === "additive" && formulaSteps.length > 0);

  function toggleSqlDrawer(key: string) {
    setOpenSqlDrawers((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }

  const baselineSql =
    sqlProp ?? answer?.primaryCauses.find((c) => Boolean(c.sql))?.sql ?? null;

  if (isFalsePremise) {
    const actualDirection =
      effectiveAbsDelta !== undefined
        ? effectiveAbsDelta >= 0
          ? "tăng"
          : "giảm"
        : "biến động";
    return (
      <Card
        className="my-3 border-destructive/40 bg-card shadow-xs"
        data-testid="root-cause-view"
        aria-label="Kết quả kiểm chứng tiền đề UC-05"
      >
        <CardHeader className="gap-2 border-b border-border bg-destructive/10 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="destructive">
              <AlertOctagon className="size-3" aria-hidden="true" />
              false_premise · Tiền đề không khớp dữ liệu
            </Badge>
            <Badge variant="outline">{effectiveMetric}</Badge>
          </div>
          <CardTitle className="text-base text-destructive">
            Tiền đề câu hỏi không chính xác (false_premise)
          </CardTitle>
          {effectiveQuestion && (
            <CardDescription className="text-xs text-foreground">
              {effectiveQuestion}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3 pt-4 text-xs">
          <div
            role="alert"
            data-testid="rca-false-premise-callout"
            className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-destructive"
          >
            <p className="m-0 font-semibold leading-relaxed">
              {message ??
                answer?.finalReportMarkdown ??
                `Dữ liệu thực tế cho thấy ${effectiveMetric} ${actualDirection} so với kỳ gốc, trái với tiền đề của câu hỏi nên hệ thống đã dừng phân rã để tránh bịa nguyên nhân.`}
            </p>
          </div>

          {(effectiveBaselineVal !== undefined ||
            effectiveCurrentVal !== undefined ||
            effectiveAbsDelta !== undefined) && (
            <div className="grid gap-3 rounded-xl border border-border bg-muted/40 p-3 sm:grid-cols-3">
              <div>
                <span className="text-muted-foreground">Kỳ cơ sở (V_base)</span>
                <p className="m-0 mt-1 text-sm font-bold text-foreground">
                  {effectiveBaselineVal !== undefined
                    ? formatMetricValue(effectiveBaselineVal, effectiveMetric, effectiveMetricType)
                    : "—"}
                </p>
                {effectiveBaselinePeriod && (
                  <span className="text-muted-foreground">
                    {effectiveBaselinePeriod.start} → {effectiveBaselinePeriod.end}
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Kỳ phân tích (V_curr)</span>
                <p className="m-0 mt-1 text-sm font-bold text-foreground">
                  {effectiveCurrentVal !== undefined
                    ? formatMetricValue(effectiveCurrentVal, effectiveMetric, effectiveMetricType)
                    : "—"}
                </p>
                {effectiveCurrentPeriod && (
                  <span className="text-muted-foreground">
                    {effectiveCurrentPeriod.start} → {effectiveCurrentPeriod.end}
                  </span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Biến động thực tế (Δ)</span>
                <p className="m-0 mt-1 text-sm font-bold text-primary">
                  {effectiveAbsDelta !== undefined
                    ? formatSignedDelta(effectiveAbsDelta, effectiveMetric, effectiveMetricType)
                    : "—"}
                  {effectivePctDelta !== undefined && ` (${formatSignedPct(effectivePctDelta)})`}
                </p>
              </div>
            </div>
          )}

          {baselineSql && (
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={Boolean(openSqlDrawers["baseline"])}
                aria-controls="rca-sql-drawer-baseline"
                data-testid="rca-sql-toggle-baseline"
                onClick={() => toggleSqlDrawer("baseline")}
              >
                <Code2 className="size-3.5" aria-hidden="true" />
                <span>
                  {openSqlDrawers["baseline"]
                    ? "Ẩn SQL kiểm chứng tiền đề"
                    : "Xem SQL kiểm chứng tiền đề"}
                </span>
              </Button>
              {openSqlDrawers["baseline"] && (
                <div
                  id="rca-sql-drawer-baseline"
                  data-testid="rca-sql-drawer-baseline"
                  className="rounded-lg border border-border bg-muted p-3"
                >
                  <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
                    <code>{baselineSql}</code>
                  </pre>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const mathDiffPct = answer ? (answer.mathDiffRatio * 100).toFixed(2) : null;
  const doneCount = effectiveSteps.filter((s) => s.status === "done").length;
  const skippedCount = effectiveSteps.filter((s) => s.status === "skipped").length;
  const failedCount = effectiveSteps.filter((s) => s.status === "failed").length;

  return (
    <Card
      className="my-3 border-border bg-card shadow-xs"
      data-testid="root-cause-view"
      aria-label="Báo cáo phân tích nguyên nhân gốc rễ và phân bổ Waterfall UC-05"
    >
      <CardHeader className="gap-2 border-b border-border bg-muted/40 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">
              <GitBranch className="size-3" aria-hidden="true" />
              UC-05 · Phân tích nguyên nhân gốc rễ
            </Badge>
            <Badge variant="outline">
              {effectiveMetric} ({effectiveMetricType})
            </Badge>
            {answer && (
              <Badge
                variant={answer.mathVerified ? "success" : "warning"}
                data-testid="rca-math-badge"
              >
                {answer.mathVerified ? (
                  <CheckCircle2 className="size-3" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="size-3" aria-hidden="true" />
                )}
                K7 Waterfall: {answer.mathVerified ? "Đạt" : "Lệch ngưỡng"} (sai số {mathDiffPct}%)
              </Badge>
            )}
          </div>
          {answer && (
            <span className="text-xs text-muted-foreground">
              {answer.totalQueriesCount} truy vấn · Phần dư:{" "}
              {formatMetricValue(answer.residualOtherAbs, effectiveMetric, effectiveMetricType)}
            </span>
          )}
        </div>
        {effectiveQuestion && (
          <CardTitle className="text-base text-accent-foreground">{effectiveQuestion}</CardTitle>
        )}
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
          <span>
            {hasRateMixMode
              ? "Phương pháp phân bổ: Rate + Mix Effects (Tỷ suất & Cơ cấu)"
              : hasLmdiMode
                ? "Phương pháp phân bổ: Waterfall cộng tính & LMDI-I (Orders × AOV)"
                : "Phương pháp phân bổ: Waterfall cộng tính (Additive Attribution)"}
          </span>
          <span>·</span>
          <span>
            Bước: {doneCount} done · {skippedCount} skipped · {failedCount} failed
          </span>
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 pt-4 text-xs">
        {(effectiveBaselineVal !== undefined ||
          effectiveCurrentVal !== undefined ||
          effectiveAbsDelta !== undefined) && (
          <div
            className="grid gap-3 rounded-xl border border-border bg-muted/40 p-3 sm:grid-cols-3"
            data-testid="rca-baseline-summary"
          >
            <div className="space-y-1">
              <span className="font-semibold text-muted-foreground">Kỳ mốc (V_base)</span>
              <p className="m-0 text-sm font-bold text-foreground">
                {effectiveBaselineVal !== undefined
                  ? formatMetricValue(effectiveBaselineVal, effectiveMetric, effectiveMetricType)
                  : "—"}
              </p>
              {effectiveBaselinePeriod && (
                <span className="block text-muted-foreground">
                  {effectiveBaselinePeriod.start} → {effectiveBaselinePeriod.end}
                </span>
              )}
            </div>
            <div className="space-y-1">
              <span className="font-semibold text-muted-foreground">Kỳ phân tích (V_curr)</span>
              <p className="m-0 text-sm font-bold text-foreground">
                {effectiveCurrentVal !== undefined
                  ? formatMetricValue(effectiveCurrentVal, effectiveMetric, effectiveMetricType)
                  : "—"}
              </p>
              {effectiveCurrentPeriod && (
                <span className="block text-muted-foreground">
                  {effectiveCurrentPeriod.start} → {effectiveCurrentPeriod.end}
                </span>
              )}
            </div>
            <div className="space-y-1">
              <span className="font-semibold text-muted-foreground">Biến động tổng (Δ)</span>
              <p
                className={cn(
                  "m-0 inline-flex items-center gap-1 text-sm font-bold",
                  (effectiveAbsDelta ?? 0) < 0 ? "text-destructive" : "text-primary",
                )}
              >
                {(effectiveAbsDelta ?? 0) < 0 ? (
                  <TrendingDown className="size-4" aria-hidden="true" />
                ) : (
                  <TrendingUp className="size-4" aria-hidden="true" />
                )}
                {effectiveAbsDelta !== undefined
                  ? formatSignedDelta(effectiveAbsDelta, effectiveMetric, effectiveMetricType)
                  : "—"}
                {effectivePctDelta !== undefined && ` (${formatSignedPct(effectivePctDelta)})`}
              </p>
            </div>
          </div>
        )}

        {offsettingSummary && (
          <div
            role="note"
            data-testid="rca-offsetting-warning"
            className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-900"
          >
            <Scale className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <strong className="block">
                Cảnh báo các phân đoạn triệt tiêu lẫn nhau (Offsetting Segments)
              </strong>
              <p className="m-0 leading-relaxed">
                Có {offsettingSummary.positiveCount} nhánh tăng (tổng{" "}
                {formatSignedDelta(
                  offsettingSummary.positiveSum,
                  effectiveMetric,
                  effectiveMetricType,
                )}
                ) và {offsettingSummary.negativeCount} nhánh giảm (tổng{" "}
                {formatSignedDelta(
                  offsettingSummary.negativeSum,
                  effectiveMetric,
                  effectiveMetricType,
                )}
                ). Tổng biên độ dao động gộp (Σ|Δ|) là{" "}
                <strong>
                  {formatMetricValue(
                    offsettingSummary.grossMovement,
                    effectiveMetric,
                    effectiveMetricType,
                  )}
                </strong>
                {offsettingSummary.isNearZeroNet
                  ? "; biến động ròng gần 0 nên tỷ trọng % theo biến động ròng có thể vượt 100%."
                  : "."}
              </p>
            </div>
          </div>
        )}

        {activeChart && (
          <div
            className="space-y-2 rounded-xl border border-border bg-card p-3"
            data-testid="rca-openui-chart-section"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-accent-foreground">
                <BarChart3 className="size-4 text-primary" aria-hidden="true" />
                Biểu đồ phân bổ đóng góp (OpenUI)
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {hasTrustedExternalViz && (
                  <Button
                    type="button"
                    size="sm"
                    variant={chartMode === "harness" ? "default" : "outline"}
                    onClick={() => setChartMode("harness")}
                  >
                    Biểu đồ từ Harness
                  </Button>
                )}
                {chartItems.length > 0 && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant={chartMode === "bar" ? "default" : "outline"}
                      onClick={() => setChartMode("bar")}
                      data-testid="rca-chart-mode-bar"
                    >
                      OpenUI BarChart
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={chartMode === "table" ? "default" : "outline"}
                      onClick={() => setChartMode("table")}
                      data-testid="rca-chart-mode-table"
                    >
                      OpenUI Table
                    </Button>
                  </>
                )}
              </div>
            </div>
            <InsightChart
              title={activeChart.title}
              report={activeChart.report}
              lang={activeChart.lang}
              streaming={activeChart.streaming}
            />
          </div>
        )}

        {(hasRateMixMode || rateMixFactors.length > 0) && (
          <div
            className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-3"
            data-testid="rca-rate-mix-section"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-accent-foreground">
                <Layers className="size-4 text-primary" aria-hidden="true" />
                Phân rã chỉ số tỷ lệ: Rate + Mix Effects
              </span>
              <Badge variant="secondary">Rate + Mix</Badge>
            </div>
            {rateMixFactors.length > 0 ? (
              <ul className="m-0 list-none space-y-2 p-0">
                {rateMixFactors.map((factor, idx) => {
                  const barWidth = Math.min(100, Math.max(4, Math.abs(factor.contributionPct)));
                  return (
                    <li
                      key={factor.id ?? `${factor.effectType}-${idx}`}
                      className="space-y-1 rounded-lg border border-border bg-card p-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={factor.effectType === "rate" ? "warning" : "secondary"}>
                            {effectTypeLabel(factor.effectType)}
                          </Badge>
                          <strong className="text-foreground">{factor.label}</strong>
                        </div>
                        <span className="font-semibold text-foreground">
                          {formatSignedDelta(factor.delta, effectiveMetric, effectiveMetricType)} (
                          {formatSignedPct(factor.contributionPct)})
                        </span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-muted"
                        aria-hidden="true"
                      >
                        <div
                          data-testid="rca-contribution-bar"
                          className={cn(
                            "h-full rounded-full",
                            factor.delta < 0 ? "bg-destructive" : "bg-primary",
                          )}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      {factor.description && (
                        <p className="m-0 text-muted-foreground">{factor.description}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="m-0 text-muted-foreground">
                Chỉ số dạng tỷ lệ (<code>{effectiveMetric}</code>) được tách theo biến động tỷ suất
                nội tại (Rate effect) và cơ cấu tỷ trọng phân đoạn (Mix effect / Simpson&apos;s
                paradox guard).
              </p>
            )}
          </div>
        )}

        {(hasLmdiMode || lmdiFactors.length > 0) && (
          <div
            className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-3"
            data-testid="rca-lmdi-section"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-accent-foreground">
                <Layers className="size-4 text-primary" aria-hidden="true" />
                Phân rã nhân tử chiều dọc (LMDI-I · Orders × AOV)
              </span>
              <Badge variant="secondary">LMDI-I</Badge>
            </div>
            <ul className="m-0 list-none space-y-2 p-0">
              {(lmdiFactors.length > 0
                ? lmdiFactors
                : formulaSteps.map((s) => ({
                    id: s.stepId,
                    label: s.dimensionOrFactor,
                    effectType: "lmdi" as const,
                    delta: s.delta,
                    contributionPct: s.contributionPct,
                    sql: s.sql,
                    description: s.hypothesis,
                  }))
              ).map((factor, idx) => {
                const barWidth = Math.min(100, Math.max(4, Math.abs(factor.contributionPct)));
                return (
                  <li
                    key={factor.id ?? `lmdi-${idx}`}
                    className="space-y-1 rounded-lg border border-border bg-card p-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{effectTypeLabel(factor.effectType)}</Badge>
                        <strong className="text-foreground">{factor.label}</strong>
                      </div>
                      <span className="font-semibold text-foreground">
                        {formatSignedDelta(factor.delta, effectiveMetric, effectiveMetricType)} (
                        {formatSignedPct(factor.contributionPct)})
                      </span>
                    </div>
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      aria-hidden="true"
                    >
                      <div
                        data-testid="rca-contribution-bar"
                        className={cn(
                          "h-full rounded-full",
                          factor.delta < 0 ? "bg-destructive" : "bg-primary",
                        )}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                    {factor.description && (
                      <p className="m-0 text-muted-foreground">{factor.description}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {answer && (
          <div className="space-y-2.5" data-testid="rca-attribution-list">
            <div className="flex items-center justify-between">
              <strong className="text-accent-foreground">
                Nguyên nhân cốt lõi &amp; Đóng góp Waterfall ({answer.primaryCauses.length})
              </strong>
              <span className="text-muted-foreground">
                Sai số toán học: {mathDiffPct}% (ngưỡng ≤ 5%)
              </span>
            </div>

            {answer.primaryCauses.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-3 text-muted-foreground">
                Không xác định được nguyên nhân cốt lõi vượt ngưỡng ý nghĩa.
              </div>
            ) : (
              <ul className="m-0 list-none space-y-2.5 p-0">
                {answer.primaryCauses.map((cause, index) => {
                  const pathLabel =
                    cause.dimensionPath.length > 0
                      ? cause.dimensionPath.join(" → ")
                      : (cause.dimensionValue ?? cause.dimensionOrFactor);
                  const barWidth = Math.min(100, Math.max(4, Math.abs(cause.contributionPct)));
                  const drawerKey = `cause-${cause.stepId}-${index}`;
                  const sqlOpen = Boolean(openSqlDrawers[drawerKey]);
                  const grossShare =
                    offsettingSummary && offsettingSummary.grossMovement > 0
                      ? (Math.abs(cause.delta) / offsettingSummary.grossMovement) * 100
                      : null;

                  return (
                    <li
                      key={`${cause.stepId}-${index}`}
                      data-testid={`rca-cause-card-${cause.stepId}`}
                      className="space-y-2 rounded-xl border border-border bg-muted/30 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline">#{index + 1}</Badge>
                            <Badge variant={cause.axis === "formula" ? "warning" : "secondary"}>
                              {cause.axis === "formula" ? "Formula" : cause.dimensionOrFactor}
                            </Badge>
                            <strong className="text-sm text-accent-foreground">{pathLabel}</strong>
                          </div>
                          {cause.summaryVi && (
                            <p className="m-0 text-foreground leading-relaxed">{cause.summaryVi}</p>
                          )}
                          {!cause.summaryVi && cause.hypothesis && (
                            <p className="m-0 text-muted-foreground">{cause.hypothesis}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <div
                            className={cn(
                              "text-sm font-bold",
                              cause.delta < 0 ? "text-destructive" : "text-primary",
                            )}
                          >
                            {formatSignedDelta(cause.delta, effectiveMetric, effectiveMetricType)}
                          </div>
                          <div className="font-semibold text-foreground">
                            Đóng góp: {formatSignedPct(cause.contributionPct)}
                          </div>
                          {grossShare !== null && (
                            <div className="text-muted-foreground">
                              Tỷ trọng gộp: {grossShare.toFixed(1)}%
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div
                          className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
                          role="progressbar"
                          aria-label={`Mức đóng góp của ${pathLabel}`}
                          aria-valuenow={Math.round(Math.abs(cause.contributionPct))}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            data-testid="rca-contribution-bar"
                            className={cn(
                              "h-full rounded-full transition-all",
                              cause.delta < 0 ? "bg-destructive" : "bg-primary",
                            )}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </div>

                      {cause.sql && (
                        <div className="space-y-1.5">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={sqlOpen}
                            aria-controls={`rca-cause-sql-drawer-${cause.stepId}`}
                            data-testid={`rca-cause-sql-toggle-${cause.stepId}`}
                            onClick={() => toggleSqlDrawer(drawerKey)}
                          >
                            {sqlOpen ? (
                              <ChevronDown className="size-3.5" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="size-3.5" aria-hidden="true" />
                            )}
                            <Code2 className="size-3.5" aria-hidden="true" />
                            <span>
                              {sqlOpen
                                ? `Ẩn SQL bằng chứng (${pathLabel})`
                                : `Xem SQL bằng chứng (${pathLabel})`}
                            </span>
                          </Button>
                          {sqlOpen && (
                            <div
                              id={`rca-cause-sql-drawer-${cause.stepId}`}
                              data-testid={`rca-cause-sql-drawer-${cause.stepId}`}
                              className="rounded-lg border border-border bg-card p-3"
                            >
                              <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
                                <code>{cause.sql}</code>
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {effectiveSteps.length > 0 && (
          <div className="space-y-2" data-testid="rca-steps-tree">
            <div className="flex items-center justify-between">
              <strong className="text-accent-foreground">
                Chi tiết thực thi từng bước ({effectiveSteps.length})
              </strong>
            </div>
            <ul className="m-0 list-none space-y-2 p-0">
              {effectiveSteps.map((step) => {
                const badge = stepStatusBadge(step.status);
                const stepLabel =
                  step.dimensionPath.length > 0
                    ? step.dimensionPath.join(" → ")
                    : (step.dimensionValue ?? step.dimensionOrFactor);
                const stepDrawerKey = `step-${step.stepId}`;
                const sqlOpen = Boolean(openSqlDrawers[stepDrawerKey]);

                return (
                  <li
                    key={step.stepId}
                    data-testid={`rca-step-row-${step.stepId}`}
                    data-step-status={step.status}
                    className="space-y-2 rounded-xl border border-border bg-card p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={badge.variant} data-testid={`rca-step-status-${step.stepId}`}>
                          {badge.label}
                        </Badge>
                        <Badge variant="outline">Tầng {step.depth}</Badge>
                        <Badge variant="secondary">{step.dimensionOrFactor}</Badge>
                        <strong className="text-foreground">{stepLabel}</strong>
                      </div>
                      {step.status === "done" && (
                        <span
                          className={cn(
                            "font-semibold",
                            step.delta < 0 ? "text-destructive" : "text-primary",
                          )}
                        >
                          {formatSignedDelta(step.delta, effectiveMetric, effectiveMetricType)} (
                          {formatSignedPct(step.contributionPct)})
                        </span>
                      )}
                    </div>

                    {step.status === "failed" && step.errorMessage && (
                      <div
                        className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-destructive"
                        role="status"
                      >
                        <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          {step.errorMessage}
                          {step.retryCount > 0 && ` (đã thử lại ${step.retryCount} lần)`}
                        </span>
                      </div>
                    )}

                    {step.hypothesis && (
                      <p className="m-0 text-muted-foreground">{step.hypothesis}</p>
                    )}

                    {step.sql && (
                      <div className="space-y-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-expanded={sqlOpen}
                          aria-controls={`rca-sql-drawer-${step.stepId}`}
                          data-testid={`rca-sql-toggle-${step.stepId}`}
                          onClick={() => toggleSqlDrawer(stepDrawerKey)}
                        >
                          {sqlOpen ? (
                            <ChevronDown className="size-3.5" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="size-3.5" aria-hidden="true" />
                          )}
                          <Code2 className="size-3.5" aria-hidden="true" />
                          <span>
                            {sqlOpen
                              ? `Ẩn SQL bước ${stepLabel}`
                              : `Xem SQL bước ${stepLabel}`}
                          </span>
                        </Button>
                        {sqlOpen && (
                          <div
                            id={`rca-sql-drawer-${step.stepId}`}
                            data-testid={`rca-sql-drawer-${step.stepId}`}
                            className="rounded-lg border border-border bg-muted p-3"
                          >
                            <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
                              <code>{step.sql}</code>
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {answer && answer.unexploredBranches.length > 0 && (
          <div
            className="space-y-1.5 rounded-xl border border-border bg-muted/40 p-3"
            data-testid="rca-unexplored-branches"
          >
            <strong className="block text-accent-foreground">
              Nhánh chưa đào sâu / Giới hạn dừng ({answer.unexploredBranches.length})
            </strong>
            <ul className="m-0 list-disc space-y-1 pl-4 text-muted-foreground">
              {answer.unexploredBranches.map((branch, idx) => (
                <li key={`${branch.dimensionOrFactor}-${branch.dimensionValue ?? idx}`}>
                  <span className="font-medium text-foreground">
                    {branch.dimensionOrFactor}
                    {branch.dimensionValue ? ` = ${branch.dimensionValue}` : ""}
                  </span>
                  {": "}
                  <span>{unexploredReasonLabel(branch.reason)}</span>{" "}
                  <Badge variant="outline" className="font-mono">
                    {branch.reason}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {answer?.finalReportMarkdown && (
          <div className="space-y-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={showMarkdown}
              onClick={() => setShowMarkdown((prev) => !prev)}
            >
              {showMarkdown ? "Ẩn báo cáo Markdown đầy đủ" : "Xem báo cáo Markdown đầy đủ"}
            </Button>
            {showMarkdown && (
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <SafeMarkdown content={answer.finalReportMarkdown} />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
