import type { MinSupport } from "@shared/contracts";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertDirection = "spike" | "drop";

export interface AbsoluteThreshold {
  operator: "above" | "below";
  value: number;
}

export interface TimeSeriesPoint {
  date: string; // YYYY-MM-DD
  value: number; // numeric metric value
  supportCount?: number; // total count/volume for the slice on that day (e.g. order count)
}

export interface AnomalyDetectorInput {
  history: TimeSeriesPoint[]; // historical window (t-28 .. t-1)
  current: TimeSeriesPoint; // current point to evaluate (t)
  metricId?: string;
  minSupport?: MinSupport; // default 15 orders; metric floors are an explicit alternative
  absoluteThreshold?: AbsoluteThreshold;
  eps?: number; // default 1e-6 (or floor for small numbers/currency)
  trimRatio?: number; // default 0.05 (5% - 95% trimming)
}

export interface AnomalyDetectorOutput {
  isAnomaly: boolean;
  severity: AlertSeverity | "none";
  direction: AlertDirection | "none";
  currentValue: number;
  expectedValue: number; // mu_trim
  zScore: number;
  wowPercent: number | null;
  deviationSummary: string;
  status: "ok" | "skipped_insufficient_support" | "insufficient_history";
  caveat?: string;
}

/**
 * Robust Trimmed Mean (cắt trimRatio đầu và cuối để loại trừ ngoại lai / quá khứ ô nhiễm)
 */
export function trimmedMean(values: number[], trimRatio = 0.05): number {
  if (values.length === 0) return 0;
  if (values.length < 4) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(sorted.length * trimRatio));
  const trimmed = sorted.slice(cut, sorted.length - cut);
  if (trimmed.length === 0) {
    return sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  }
  return trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
}

/**
 * Robust Trimmed Standard Deviation
 */
export function trimmedStd(values: number[], trimRatio = 0.05): number {
  if (values.length <= 1) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(sorted.length * trimRatio));
  const trimmed = sorted.slice(cut, sorted.length - cut);
  if (trimmed.length <= 1) return 0;

  const mean = trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
  const variance =
    trimmed.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) /
    (trimmed.length - 1);
  return Math.sqrt(variance);
}

/**
 * Calculate effective sigma (sigma_eff) with noise floor and signal proportion
 * sigma_eff = max(sigma_raw, EPS, 0.05 * |mu_trim|)
 */
export function calculateEffectiveSigma(
  sigmaRaw: number,
  muTrim: number,
  eps = 1e-6,
): number {
  return Math.max(sigmaRaw, eps, 0.05 * Math.abs(muTrim));
}

/**
 * Week-over-Week percentage change:
 * WoW% = (x_t - x_{t-7}) / max(|x_{t-7}|, EPS) * 100%
 */
export function calculateWoW(
  currentValue: number,
  weekAgoValue: number,
  eps = 1e-6,
): number | null {
  if (weekAgoValue === 0) return null;
  return (
    ((currentValue - weekAgoValue) / Math.max(Math.abs(weekAgoValue), eps)) * 100
  );
}

function dateDaysBefore(date: string, days: number): string | undefined {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    return undefined;
  }
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Check if current value breaches absolute threshold
 */
export function isAbsoluteThresholdBreached(
  currentValue: number,
  threshold?: AbsoluteThreshold,
): boolean {
  if (!threshold) return false;
  if (threshold.operator === "above") {
    return currentValue > threshold.value;
  }
  if (threshold.operator === "below") {
    return currentValue < threshold.value;
  }
  return false;
}

/**
 * Pure-Code Contamination-Resistant Statistical Anomaly Detector
 *
 * Implements UC-10 §4 statistical specification:
 * - Deterministic pure code (0 LLM cost on normal days)
 * - Contamination resistance via trimmed mean/std (5%-95% historical baseline)
 * - Immune to indirect prompt injection (operates on numeric aggregates only)
 * - Division by zero guarded via EPS floor
 * - Low-support suppression (minSupport >= 15) to prevent false positives in sparse slices
 */
export function detectAnomaly(input: AnomalyDetectorInput): AnomalyDetectorOutput {
  const {
    history,
    current,
    minSupport = 15,
    absoluteThreshold,
    eps = 1e-6,
    trimRatio = 0.05,
  } = input;

  const minOrders =
    typeof minSupport === "number" ? minSupport : minSupport.minOrders;
  const minMetricTrimmedMean =
    typeof minSupport === "number" ? undefined : minSupport.minMetricTrimmedMean;
  const historyValues = history.map((h) => h.value);
  const insufficientHistory = historyValues.length < 14;

  // 1. Min support check (chống FP ở tỉnh/kênh có quá ít đơn hàng)
  const muTrim = trimmedMean(historyValues, trimRatio);
  const hasMetricFloor =
    minMetricTrimmedMean !== undefined && muTrim >= minMetricTrimmedMean;
  if (
    current.supportCount === undefined ||
    (current.supportCount < minOrders && !hasMetricFloor)
  ) {
    return {
      isAnomaly: false,
      severity: "none",
      direction: "none",
      currentValue: current.value,
      expectedValue: current.value,
      zScore: 0,
      wowPercent: null,
      deviationSummary:
        current.supportCount === undefined
          ? `Insufficient support: supportCount is missing; minOrders=${minOrders}`
          : `Insufficient support: sample=${current.supportCount} < minOrders=${minOrders}`,
      status: "skipped_insufficient_support",
    };
  }

  // 2. Contamination-resistant baseline calculation
  const sigmaRaw = trimmedStd(historyValues, trimRatio);
  const sigmaEff = calculateEffectiveSigma(sigmaRaw, muTrim, eps);

  // 3. Z-score calculation
  const zScore = (current.value - muTrim) / sigmaEff;

  // 4. Week-over-Week (t-7) calculation if available
  let wowPercent: number | null = null;
  const weekAgoDate = dateDaysBefore(current.date, 7);
  if (weekAgoDate !== undefined) {
    const weekAgoPoint = history.find((point) => point.date === weekAgoDate);
    if (weekAgoPoint !== undefined) {
      wowPercent = calculateWoW(current.value, weekAgoPoint.value, eps);
    }
  }

  // 5. Direction classification
  const direction: AlertDirection = current.value >= muTrim ? "spike" : "drop";

  // 6. Absolute threshold check
  const breachedAbsolute = isAbsoluteThresholdBreached(
    current.value,
    absoluteThreshold,
  );

  // 7. Severity classification (UC-10 §4.4)
  const absZ = Math.abs(zScore);
  const absWoW = wowPercent !== null ? Math.abs(wowPercent) : 0;

  let severity: AlertSeverity | "none" = "none";
  if (breachedAbsolute) {
    severity = "critical";
  } else if (!insufficientHistory) {
    if (absZ >= 3.0 || absWoW >= 50.0) {
      severity = "critical";
    } else if (absZ >= 2.0) {
      severity = "warning";
    }
  }

  const isAnomaly = severity !== "none";

  const zSign = zScore > 0 ? "+" : "";
  const wowText =
    wowPercent !== null
      ? `, WoW=${wowPercent > 0 ? "+" : ""}${wowPercent.toFixed(1)}%`
      : "";
  const deviationSummary = `z=${zSign}${zScore.toFixed(2)}${wowText}`;

  return {
    isAnomaly,
    severity,
    direction: isAnomaly ? direction : "none",
    currentValue: current.value,
    expectedValue: muTrim,
    zScore,
    wowPercent,
    deviationSummary,
    status: insufficientHistory ? "insufficient_history" : "ok",
    caveat: insufficientHistory ? "insufficient_history" : undefined,
  };
}

/**
 * Convenient helper to run detection on a chronological series of points
 * The last point is treated as current, all preceding points as history.
 */
export function detectAnomalyFromSeries(
  series: TimeSeriesPoint[],
  options?: Omit<AnomalyDetectorInput, "history" | "current">,
): AnomalyDetectorOutput {
  if (series.length === 0) {
    throw new Error("Cannot detect anomaly from empty time-series");
  }
  const history = series.slice(0, -1);
  const current = series[series.length - 1];
  return detectAnomaly({
    history,
    current,
    ...options,
  });
}
