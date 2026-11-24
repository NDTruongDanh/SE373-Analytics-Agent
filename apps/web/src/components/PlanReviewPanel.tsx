import {
  PlanStepSchema,
  type AnalysisPlan,
  type PlanStep,
  type PlanStepAxis,
} from "@shared/contracts";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  GitBranch,
  Layers,
  Plus,
  RotateCcw,
  SkipForward,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { StreamHttpError } from "@/stream";

export interface PlanResumeSubmission {
  action: "approve" | "modify" | "reject";
  plan: AnalysisPlan;
  steps: PlanStep[];
  checkpointId?: string;
  value: {
    action: "approve" | "modify" | "reject";
    plan: AnalysisPlan;
    currentPlan: AnalysisPlan;
    updated_plan: AnalysisPlan;
    steps: PlanStep[];
    checkpointId?: string;
  };
}

export interface PlanReviewPanelProps {
  plan: AnalysisPlan;
  runId?: string | null;
  threadId?: string | null;
  checkpointId?: string;
  asOf?: string;
  busy?: boolean;
  disabled?: boolean;
  conflictError?: string | null;
  error?: string | null;
  onResume?: (submission: PlanResumeSubmission) => void | Promise<void>;
  onSubmit?: (submission: PlanResumeSubmission) => void | Promise<void>;
}

const DIMENSION_PRESETS: Array<{
  axis: PlanStepAxis;
  dimensionOrFactor: string;
  label: string;
  defaultHypothesis: string;
}> = [
  {
    axis: "dimension",
    dimensionOrFactor: "region",
    label: "Region (Khu vực)",
    defaultHypothesis: "Phân rã biến động theo khu vực địa lý",
  },
  {
    axis: "dimension",
    dimensionOrFactor: "channel",
    label: "Channel (Kênh bán)",
    defaultHypothesis: "Phân rã biến động theo kênh bán hàng",
  },
  {
    axis: "dimension",
    dimensionOrFactor: "category",
    label: "Category (Ngành hàng)",
    defaultHypothesis: "Phân rã biến động theo ngành hàng",
  },
  {
    axis: "dimension",
    dimensionOrFactor: "product",
    label: "Product (Sản phẩm)",
    defaultHypothesis: "Phân rã biến động theo sản phẩm chi tiết",
  },
  {
    axis: "dimension",
    dimensionOrFactor: "payment_type",
    label: "Payment Type (Thanh toán)",
    defaultHypothesis: "Phân rã biến động theo phương thức thanh toán",
  },
  {
    axis: "formula",
    dimensionOrFactor: "orders",
    label: "Orders (Số đơn hàng)",
    defaultHypothesis: "Phân rã tác động từ số lượng đơn hàng (Orders × AOV)",
  },
  {
    axis: "formula",
    dimensionOrFactor: "aov",
    label: "AOV (Giá trị trung bình đơn)",
    defaultHypothesis: "Phân rã tác động từ giá trị trung bình đơn (Orders × AOV)",
  },
];

function cloneSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((step) => ({
    ...step,
    dimensionPath: [...step.dimensionPath],
  }));
}

function formatMetricValue(
  value: number,
  metricName: string,
  metricType: AnalysisPlan["metricType"],
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
  absDelta: number,
  metricName: string,
  metricType: AnalysisPlan["metricType"],
): string {
  if (!Number.isFinite(absDelta)) return "—";
  const sign = absDelta > 0 ? "+" : absDelta < 0 ? "-" : "";
  return `${sign}${formatMetricValue(Math.abs(absDelta), metricName, metricType)}`;
}

function formatSignedPct(pctDelta: number): string {
  if (!Number.isFinite(pctDelta)) return "0.0%";
  const sign = pctDelta > 0 ? "+" : "";
  return `${sign}${pctDelta.toFixed(1)}%`;
}

function slugifyId(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stepDisplayLabel(step: PlanStep): string {
  if (step.dimensionValue) {
    return `${step.dimensionOrFactor}: ${step.dimensionValue}`;
  }
  return step.dimensionOrFactor;
}

export function PlanReviewPanel({
  plan,
  runId,
  threadId,
  checkpointId,
  asOf,
  busy = false,
  disabled = false,
  conflictError = null,
  error = null,
  onResume,
  onSubmit,
}: PlanReviewPanelProps) {
  const [steps, setSteps] = useState<PlanStep[]>(() => cloneSteps(plan.steps));
  const [isModified, setIsModified] = useState(false);
  const [newAxis, setNewAxis] = useState<PlanStepAxis>("dimension");
  const [newDimension, setNewDimension] = useState("channel");
  const [newValue, setNewValue] = useState("");
  const [newHypothesis, setNewHypothesis] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [internalConflict, setInternalConflict] = useState<string | null>(null);
  const [internalError, setInternalError] = useState<string | null>(null);

  const axisSelectId = useId();
  const dimInputId = useId();
  const valInputId = useId();

  useEffect(() => {
    setSteps(cloneSteps(plan.steps));
    setIsModified(false);
    setInternalConflict(null);
    setInternalError(null);
  }, [plan]);

  const activeStepCount = useMemo(
    () => steps.filter((step) => step.status !== "skipped").length,
    [steps],
  );
  const skippedStepCount = useMemo(
    () => steps.filter((step) => step.status === "skipped").length,
    [steps],
  );

  const isDisabled = busy || disabled || submitting;
  const effectiveConflict = conflictError ?? internalConflict;
  const effectiveError = error ?? internalError;
  const formulaLabel = plan.formulaComponents?.formula ?? "Orders × AOV";

  function handleToggleStep(stepId: string) {
    setSteps((prev) =>
      prev.map((step) =>
        step.stepId === stepId
          ? { ...step, status: step.status === "skipped" ? "todo" : "skipped" }
          : step,
      ),
    );
    setIsModified(true);
  }

  function handleMoveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((prev) => {
      const next = [...prev];
      const current = next[index];
      const swap = next[target];
      if (!current || !swap) return prev;
      next[index] = swap;
      next[target] = current;
      return next;
    });
    setIsModified(true);
  }

  function handleRemoveStep(stepId: string) {
    setSteps((prev) => prev.filter((step) => step.stepId !== stepId));
    setIsModified(true);
  }

  function appendStep(
    axis: PlanStepAxis,
    dimensionOrFactor: string,
    dimensionValue: string | null,
    hypothesis?: string,
  ) {
    const cleanDim = dimensionOrFactor.trim();
    if (!cleanDim) return;
    const cleanVal = dimensionValue?.trim() ? dimensionValue.trim() : null;
    const baseSlug = slugifyId(`${axis}_${cleanDim}_${cleanVal ?? "all"}`) || "custom";
    let candidateId = `step_${baseSlug}`;
    const existingIds = new Set(steps.map((s) => s.stepId));
    let suffix = 2;
    while (existingIds.has(candidateId)) {
      candidateId = `step_${baseSlug}_${suffix}`;
      suffix += 1;
    }

    const stepPath =
      axis === "formula"
        ? ["formula", cleanDim]
        : cleanVal
          ? [cleanDim, cleanVal]
          : [cleanDim];

    const parsedStep = PlanStepSchema.parse({
      stepId: candidateId,
      axis,
      dimensionOrFactor: cleanDim,
      dimensionValue: cleanVal,
      dimensionPath: stepPath,
      parentId: null,
      depth: 0,
      status: "todo",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
      hypothesis:
        hypothesis?.trim() ||
        (axis === "formula"
          ? `Phân rã theo nhân tử ${cleanDim}`
          : cleanVal
            ? `Phân rã theo ${cleanDim} = ${cleanVal}`
            : `Phân rã theo chiều ${cleanDim}`),
    });

    setSteps((prev) => [...prev, parsedStep]);
    setIsModified(true);
  }

  function handleAddStepForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newDimension.trim()) return;
    appendStep(newAxis, newDimension, newValue || null, newHypothesis);
    setNewValue("");
    setNewHypothesis("");
  }

  function handleReset() {
    setSteps(cloneSteps(plan.steps));
    setIsModified(false);
    setInternalConflict(null);
    setInternalError(null);
  }

  async function submitDecision(requestedAction?: "approve" | "modify" | "reject") {
    if (isDisabled) return;
    const action: "approve" | "modify" | "reject" =
      requestedAction ?? (isModified ? "modify" : "approve");
    const updatedPlan: AnalysisPlan = {
      ...plan,
      steps: cloneSteps(steps),
    };
    const submission: PlanResumeSubmission = {
      action,
      plan: updatedPlan,
      steps: updatedPlan.steps,
      ...(checkpointId ? { checkpointId } : {}),
      value: {
        action,
        plan: updatedPlan,
        currentPlan: updatedPlan,
        updated_plan: updatedPlan,
        steps: updatedPlan.steps,
        ...(checkpointId ? { checkpointId } : {}),
      },
    };

    setInternalConflict(null);
    setInternalError(null);

    const handler = onResume ?? onSubmit;
    if (handler) {
      setSubmitting(true);
      try {
        await handler(submission);
      } catch (err) {
        if (
          (err instanceof StreamHttpError && err.status === 409) ||
          (err instanceof Error && /(?:409|conflict|stale)/i.test(err.message))
        ) {
          setInternalConflict(
            err instanceof Error
              ? err.message
              : "Checkpoint đã cũ hoặc có phiên xử lý khác đang hoạt động (409 Conflict).",
          );
        } else {
          setInternalError(
            err instanceof Error ? err.message : "Không thể gửi quyết định duyệt kế hoạch.",
          );
        }
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const targetRunId = runId && runId.trim().length > 0 ? runId : "run-1";
    setSubmitting(true);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(targetRunId)}/resume`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          value: submission.value,
          ...(checkpointId ? { checkpointId } : {}),
        }),
      });
      if (response.status === 409) {
        let serverDetail = "";
        try {
          const parsed: unknown = await response.json();
          if (parsed && typeof parsed === "object" && "message" in parsed) {
            const msg = (parsed as { message?: unknown }).message;
            if (typeof msg === "string" && msg.trim()) {
              serverDetail = ` ${msg.trim()}`;
            }
          }
        } catch {
        }
        setInternalConflict(
          `Checkpoint đã cũ hoặc phiên phân tích đang bị xung đột (HTTP 409 Conflict).${serverDetail}`,
        );
        return;
      }
      if (!response.ok) {
        setInternalError(`Không thể tiếp tục kế hoạch (HTTP ${response.status}).`);
      }
    } catch (err) {
      setInternalError(
        err instanceof Error ? err.message : "Không thể kết nối máy chủ để duyệt kế hoạch.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      className="my-3 border-primary/30 bg-card shadow-sm"
      data-testid="plan-review-panel"
      aria-label="Kiểm duyệt kế hoạch phân tích nguyên nhân gốc rễ UC-05"
    >
      <CardHeader className="gap-2 border-b border-border bg-muted/40 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">
              <GitBranch className="size-3" aria-hidden="true" />
              UC-05 · Duyệt kế hoạch HITL
            </Badge>
            <Badge variant="outline">
              {plan.metricName} ({plan.metricType})
            </Badge>
            {plan.direction && (
              <Badge variant={plan.direction === "decrease" ? "destructive" : "success"}>
                {plan.direction === "decrease" ? "Xu hướng giảm" : "Xu hướng tăng"}
              </Badge>
            )}
            {isModified && <Badge variant="warning">Đã chỉnh sửa</Badge>}
          </div>
          {checkpointId && (
            <Badge variant="secondary" className="font-mono" data-testid="plan-review-checkpoint">
              Checkpoint: {checkpointId}
            </Badge>
          )}
        </div>
        <CardTitle className="text-base text-accent-foreground">{plan.question}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1" data-testid="plan-review-asof">
            <Clock className="size-3.5" aria-hidden="true" />
            Snapshot (asOf): <strong>{asOf ?? "Theo dữ liệu tại thời điểm khởi chạy"}</strong>
          </span>
          {threadId && <span className="font-mono">Thread: {threadId}</span>}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4 pt-4 text-xs">
        <div
          className="grid gap-3 rounded-xl border border-border bg-muted/40 p-3 sm:grid-cols-3"
          data-testid="plan-review-baseline"
        >
          <div className="space-y-1">
            <span className="font-semibold text-muted-foreground">Kỳ cơ sở (V_base)</span>
            <p className="m-0 text-sm font-bold text-foreground">
              {formatMetricValue(plan.baselineVal, plan.metricName, plan.metricType)}
            </p>
            <span className="block text-muted-foreground">
              {plan.baselinePeriod.start} → {plan.baselinePeriod.end}
            </span>
          </div>
          <div className="space-y-1">
            <span className="font-semibold text-muted-foreground">Kỳ phân tích (V_curr)</span>
            <p className="m-0 text-sm font-bold text-foreground">
              {formatMetricValue(plan.currentVal, plan.metricName, plan.metricType)}
            </p>
            <span className="block text-muted-foreground">
              {plan.currentPeriod.start} → {plan.currentPeriod.end}
            </span>
          </div>
          <div className="space-y-1">
            <span className="font-semibold text-muted-foreground">Biến động xác nhận (Δ)</span>
            <p
              className={cn(
                "m-0 text-sm font-bold",
                plan.absDelta < 0 ? "text-destructive" : "text-primary",
              )}
            >
              {formatSignedDelta(plan.absDelta, plan.metricName, plan.metricType)} (
              {formatSignedPct(plan.pctDelta)})
            </p>
            <span className="block text-muted-foreground">
              Tối đa {plan.maxDepthLimit} tầng · {plan.maxQueriesLimit} truy vấn · Ngưỡng ≥{" "}
              {plan.drilldownThreshold}%
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-secondary-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <Layers className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span>
              <strong>Chiều ngang:</strong> Region → Channel → Category → Product
            </span>
            <span className="text-muted-foreground">·</span>
            <span>
              <strong>Chiều dọc:</strong> {formulaLabel}
            </span>
          </div>
          <span className="font-medium">
            {activeStepCount} bước chạy · {skippedStepCount} bỏ qua
          </span>
        </div>

        {effectiveConflict && (
          <div
            role="alert"
            data-testid="plan-review-conflict"
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <strong className="block">Xung đột trạng thái / Checkpoint đã cũ (409 Conflict)</strong>
              <p className="m-0">{effectiveConflict}</p>
            </div>
          </div>
        )}

        {effectiveError && !effectiveConflict && (
          <div
            role="alert"
            data-testid="plan-review-error"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive"
          >
            {effectiveError}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <strong className="text-accent-foreground">Danh sách nhánh &amp; chiều phân rã</strong>
            <span className="text-muted-foreground">Tổng: {steps.length} bước</span>
          </div>

          {steps.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-center text-muted-foreground">
              Chưa có bước phân rã nào. Thêm chiều phân tích bên dưới hoặc khôi phục kế hoạch mặc định.
            </div>
          ) : (
            <ul className="m-0 list-none space-y-2 p-0" data-testid="plan-steps-list">
              {steps.map((step, index) => {
                const isSkipped = step.status === "skipped";
                const label = stepDisplayLabel(step);
                return (
                  <li
                    key={step.stepId}
                    data-testid={`plan-step-row-${step.stepId}`}
                    data-step-status={step.status}
                    className={cn(
                      "flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 transition-colors",
                      isSkipped ? "bg-muted/60 opacity-75" : "bg-card",
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="font-mono">
                          #{index + 1}
                        </Badge>
                        <Badge variant={step.axis === "formula" ? "warning" : "secondary"}>
                          {step.axis === "formula" ? "Chiều dọc · Formula" : "Chiều ngang · Dimension"}
                        </Badge>
                        <Badge variant={isSkipped ? "outline" : "success"}>
                          {isSkipped ? "skipped" : step.status}
                        </Badge>
                        <span className="font-semibold text-foreground">{label}</span>
                        {step.dimensionPath.length > 0 && (
                          <span className="text-muted-foreground">
                            ({step.dimensionPath.join(" → ")})
                          </span>
                        )}
                      </div>
                      {step.hypothesis && (
                        <p className="m-0 text-muted-foreground">{step.hypothesis}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isDisabled || index === 0}
                        onClick={() => handleMoveStep(index, -1)}
                        data-testid={`plan-step-up-${step.stepId}`}
                        aria-label={`Di chuyển bước ${label} lên`}
                      >
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isDisabled || index === steps.length - 1}
                        onClick={() => handleMoveStep(index, 1)}
                        data-testid={`plan-step-down-${step.stepId}`}
                        aria-label={`Di chuyển bước ${label} xuống`}
                      >
                        <ArrowDown className="size-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant={isSkipped ? "secondary" : "outline"}
                        size="sm"
                        disabled={isDisabled}
                        onClick={() => handleToggleStep(step.stepId)}
                        data-testid={`plan-step-toggle-${step.stepId}`}
                        aria-label={isSkipped ? `Kích hoạt bước ${label}` : `Bỏ qua bước ${label}`}
                      >
                        <SkipForward className="size-3.5" aria-hidden="true" />
                        <span>{isSkipped ? "Kích hoạt" : "Bỏ qua"}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isDisabled}
                        onClick={() => handleRemoveStep(step.stepId)}
                        data-testid={`plan-step-remove-${step.stepId}`}
                        aria-label={`Xóa bước ${label}`}
                      >
                        <Trash2 className="size-3.5 text-destructive" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 font-semibold text-accent-foreground">Thêm nhanh chiều:</span>
            {DIMENSION_PRESETS.map((preset) => (
              <Button
                key={`${preset.axis}-${preset.dimensionOrFactor}`}
                type="button"
                variant="outline"
                size="sm"
                disabled={isDisabled}
                onClick={() =>
                  appendStep(preset.axis, preset.dimensionOrFactor, null, preset.defaultHypothesis)
                }
              >
                <Plus className="size-3" aria-hidden="true" />
                {preset.label}
              </Button>
            ))}
          </div>

          <form
            onSubmit={handleAddStepForm}
            className="grid gap-2 sm:grid-cols-4 sm:items-end"
            aria-label="Thêm chiều phân tích tùy chỉnh"
          >
            <div className="space-y-1">
              <label htmlFor={axisSelectId} className="block font-semibold text-foreground">
                Trục phân rã
              </label>
              <select
                id={axisSelectId}
                value={newAxis}
                disabled={isDisabled}
                onChange={(event) => setNewAxis(event.target.value as PlanStepAxis)}
                className="flex h-9 w-full rounded-lg border border-input bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="dimension">Chiều ngang (dimension)</option>
                <option value="formula">Chiều dọc (formula)</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor={dimInputId} className="block font-semibold text-foreground">
                Chiều / Nhân tử
              </label>
              <Input
                id={dimInputId}
                value={newDimension}
                disabled={isDisabled}
                onChange={(event) => setNewDimension(event.target.value)}
                placeholder="VD: channel, payment_type, aov"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor={valInputId} className="block font-semibold text-foreground">
                Giá trị phân khúc (tuỳ chọn)
              </label>
              <Input
                id={valInputId}
                value={newValue}
                disabled={isDisabled}
                onChange={(event) => setNewValue(event.target.value)}
                placeholder="VD: Shopee, Miền Nam"
              />
            </div>

            <div className="space-y-1">
              <Button
                type="submit"
                variant="secondary"
                size="default"
                disabled={isDisabled || !newDimension.trim()}
                data-testid="plan-add-step-btn"
                className="w-full"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Thêm chiều phân tích
              </Button>
            </div>
          </form>
        </div>
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isDisabled || !isModified}
            onClick={handleReset}
            data-testid="plan-reset-btn"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Khôi phục mặc định
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isDisabled}
            onClick={() => void submitDecision("reject")}
            data-testid="plan-reject-btn"
          >
            <XCircle className="size-3.5 text-destructive" aria-hidden="true" />
            Từ chối kế hoạch
          </Button>
        </div>

        <Button
          type="button"
          variant="default"
          size="default"
          disabled={isDisabled || activeStepCount === 0}
          onClick={() => void submitDecision()}
          data-testid="plan-approve-btn"
        >
          <Check className="size-4" aria-hidden="true" />
          {submitting || busy
            ? "Đang tiếp tục phân tích..."
            : isModified
              ? "Lưu chỉnh sửa & Chạy kế hoạch"
              : "Phê duyệt & Chạy kế hoạch"}
        </Button>
      </CardFooter>
    </Card>
  );
}
