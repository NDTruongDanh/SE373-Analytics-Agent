import type { MinSupport } from "@shared/contracts";
import {
  getDefaultCalendarConfig,
  isExcludedFromBaseline,
  isMegaSale,
  isPublicHoliday,
  type CalendarConfig,
} from "./calendar.js";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertDirection = "spike" | "drop";

export interface AbsoluteThreshold {
  operator: "above" | "below";
  value: number;
}

export interface TimeSeriesPoint {
  date: string;
  value: number;
  supportCount?: number;
}

export interface AnomalyDetectorInput {
  history: TimeSeriesPoint[];
  current: TimeSeriesPoint;
  metricId?: string;
  minSupport?: MinSupport;
  absoluteThreshold?: AbsoluteThreshold;
  eps?: number;
  trimRatio?: number;
  sameWeekday?: boolean;
  calendarConfig?: CalendarConfig;
  wowThreshold?: number;
}

export interface AnomalyDetectorOutput {
  isAnomaly: boolean;
  severity: AlertSeverity | "none";
  direction: AlertDirection | "none";
  currentValue: number;
  expectedValue: number;
  zScore: number;
  wowPercent: number | null;
  deviationSummary: string;
  status: "ok" | "skipped_insufficient_support" | "insufficient_history";
  caveat?: string;
  sep?: number;
  sigmaEff?: number;
  baselineSampleSize?: number;
  isSameWeekday?: boolean;
  isPublicHoliday?: boolean;
  isMegaSale?: boolean;
  absoluteBreached?: boolean;
  supportCount?: number;
  minSupport?: number;
}

/**
 * Returns minimum noise floor eps for standard metric families.
 * - Currency (VND): 1.0 VND
 * - Rates/Ratios: 0.001 (0.1%)
 * - Review score: 0.01 stars
 * - Default: 1e-6
 */
export function getMetricEpsFloor(metricId?: string): number {
  if (!metricId) return 1e-6;
  const lower = metricId.toLowerCase();
  if (
    lower.includes("revenue") ||
    lower.includes("price") ||
    lower.includes("amount") ||
    lower.includes("vnd") ||
    lower.includes("gmv")
  ) {
    return 1.0;
  }
  if (
    lower.includes("rate") ||
    lower.includes("ratio") ||
    lower.includes("percentage") ||
    lower.includes("pct")
  ) {
    return 0.001;
  }
  if (lower.includes("review") || lower.includes("score")) {
    return 0.01;
  }
  if (lower.includes("count") || lower.includes("orders")) {
    return 1.0;
  }
  return 1e-6;
}

/**
 * Returns minimum support sample count by metric:
 * - review_score_avg: 5 reviews
 * - orders, revenue, return_rate, cancellation_rate: 15 orders
 */
export function getMinSupportCount(
  metricId?: string,
  explicitMinSupport?: MinSupport,
): number {
  if (typeof explicitMinSupport === "number") return explicitMinSupport;
  if (
    explicitMinSupport &&
    typeof explicitMinSupport === "object" &&
    typeof explicitMinSupport.minOrders === "number"
  ) {
    return explicitMinSupport.minOrders;
  }
  if (metricId && metricId.toLowerCase().includes("review")) {
    return 5;
  }
  return 15;
}

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

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function medianAbsoluteDeviation(values: number[], med?: number): number {
  if (values.length === 0) return 0;
  const m = med ?? median(values);
  const absDiffs = values.map((v) => Math.abs(v - m));
  return median(absDiffs);
}

/**
 * sigma_eff = max(sigma_raw, max(eps, 0.05 * |mu|)) to prevent noise spikes on flat metrics.
 */
export function calculateEffectiveSigma(
  sigmaRaw: number,
  mu: number,
  eps = 1e-6,
): number {
  const sigmaFloor = Math.max(eps, 0.05 * Math.abs(mu));
  return Math.max(sigmaRaw, sigmaFloor);
}

/**
 * Standard Error of Prediction (SEP)
 * SEP = sigma_eff * sqrt(1 + c_estimator / n_eff)
 */
export function calculateSEP(options: {
  sigmaEff: number;
  n: number;
  estimatorType: "trimmed_mean" | "median_mad";
}): number {
  const { sigmaEff, n, estimatorType } = options;
  let cEstimator: number;
  let nEff: number;

  if (estimatorType === "trimmed_mean") {
    cEstimator = 1.05;
    nEff = Math.max(1, n - 2);
  } else {
    // Median / MAD for small samples (4 <= n < 6)
    cEstimator = Math.PI / 2; // ~1.570796
    nEff = Math.max(1, n);
  }

  return sigmaEff * Math.sqrt(1 + cEstimator / nEff);
}

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

export function dateDaysBefore(date: string, days: number): string | undefined {
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

export function getUTCDayOfWeek(date: string): number {
  const d = new Date(`${date}T00:00:00.000Z`);
  return d.getUTCDay();
}

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

export function detectAnomaly(input: AnomalyDetectorInput): AnomalyDetectorOutput {
  const {
    history,
    current,
    metricId,
    minSupport,
    absoluteThreshold,
    eps: userEps,
    trimRatio = 0.05,
    sameWeekday,
    calendarConfig,
    wowThreshold = 20,
  } = input;

  const calConfig = calendarConfig ?? getDefaultCalendarConfig();
  const metricEps = Math.max(userEps ?? 0, getMetricEpsFloor(metricId));
  const minOrders =
    typeof minSupport === "number"
      ? minSupport
      : minSupport?.minOrders ?? (metricId?.toLowerCase().includes("review") ? 5 : 15);
  const minMetricTrimmedMean =
    typeof minSupport === "object" ? minSupport.minMetricTrimmedMean : undefined;

  const rawValues = history.map((h) => h.value);
  const rawMu = trimmedMean(rawValues, trimRatio);
  const hasMetricFloor =
    minMetricTrimmedMean !== undefined && rawMu >= minMetricTrimmedMean;

  const hasSupport =
    current.supportCount !== undefined &&
    (current.supportCount >= minOrders || hasMetricFloor);

  if (!hasSupport) {
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
          ? `Insufficient support: supportCount is missing; minSupport=${minOrders}`
          : `Insufficient support: sample=${current.supportCount} < minSupport=${minOrders}`,
      status: "skipped_insufficient_support",
      supportCount: current.supportCount,
      minSupport: minOrders,
    };
  }

  const absoluteBreached = isAbsoluteThresholdBreached(
    current.value,
    absoluteThreshold,
  );

  const currentWeekday = getUTCDayOfWeek(current.date);
  const weekAgoDate = dateDaysBefore(current.date, 7);

  // Separate candidate points having the same day of week and not t-7, excluding holidays/sales
  const sameWeekdayCandidates = history.filter((pt) => {
    if (getUTCDayOfWeek(pt.date) !== currentWeekday) return false;
    if (weekAgoDate !== undefined && pt.date === weekAgoDate) return false;
    if (isExcludedFromBaseline(pt.date, calConfig)) return false;
    return true;
  });

  let baselinePoints: TimeSeriesPoint[];
  let isUsingSameWeekday = false;
  let insufficientHistory = false;

  if (sameWeekday === true) {
    // Strict same-weekday requirement: 4 <= n <= 8
    if (sameWeekdayCandidates.length < 4) {
      insufficientHistory = true;
      baselinePoints = sameWeekdayCandidates.length > 0 ? sameWeekdayCandidates : history;
    } else {
      baselinePoints = sameWeekdayCandidates;
      isUsingSameWeekday = true;
    }
  } else if (sameWeekday === false) {
    // Explicitly disabled same-weekday: use all history points except t-7 and holidays
    baselinePoints = history.filter((pt) => {
      if (weekAgoDate !== undefined && pt.date === weekAgoDate) return false;
      return true;
    });
    isUsingSameWeekday = false;
    insufficientHistory = baselinePoints.length < 14;
  } else {
    // Auto-detection mode:
    // If we have >= 4 valid same-weekday points, use same-weekday!
    if (sameWeekdayCandidates.length >= 4) {
      baselinePoints = sameWeekdayCandidates;
      isUsingSameWeekday = true;
      insufficientHistory = false;
    } else {
      // Legacy fallback for tests with 14-28 consecutive days
      baselinePoints = history;
      isUsingSameWeekday = false;
      insufficientHistory = baselinePoints.length < 14;
    }
  }

  const n = baselinePoints.length;
  const baselineValues = baselinePoints.map((pt) => pt.value);

  // 3. Robust Estimators & SEP calculation
  let mu: number;
  let sigmaRaw: number;
  let estimatorType: "trimmed_mean" | "median_mad";

  if (n >= 6) {
    estimatorType = "trimmed_mean";
    mu = trimmedMean(baselineValues, trimRatio);
    sigmaRaw = trimmedStd(baselineValues, trimRatio);
  } else {
    // 4 <= n < 6 (or fallback): Median / MAD
    estimatorType = "median_mad";
    mu = median(baselineValues);
    const mad = medianAbsoluteDeviation(baselineValues, mu);
    sigmaRaw = 1.4826 * mad;
  }

  const sigmaEff = calculateEffectiveSigma(sigmaRaw, mu, metricEps);
  const sep = calculateSEP({ sigmaEff, n, estimatorType });

  // 4. Z-score (uses SEP if same-weekday mode, sigmaEff otherwise)
  const zScore = isUsingSameWeekday
    ? (sep > 0 ? (current.value - mu) / sep : 0)
    : (sigmaEff > 0 ? (current.value - mu) / sigmaEff : 0);

  // 5. Week-over-Week (t-7) calculation
  let wowPercent: number | null = null;
  if (weekAgoDate !== undefined) {
    const weekAgoPoint = history.find((point) => point.date === weekAgoDate);
    if (weekAgoPoint !== undefined) {
      wowPercent = calculateWoW(current.value, weekAgoPoint.value, metricEps);
    }
  }

  // 6. Direction
  const direction: AlertDirection = current.value >= mu ? "spike" : "drop";

  // 7. Calendar classification for current date
  const isCurrentPublicHoliday = isPublicHoliday(current.date, calConfig);
  const isCurrentMegaSale = isMegaSale(current.date, calConfig);

  const zSign = zScore > 0 ? "+" : "";
  const wowText =
    wowPercent !== null
      ? `, WoW=${wowPercent > 0 ? "+" : ""}${wowPercent.toFixed(1)}%`
      : "";
  const deviationSummary = `z=${zSign}${zScore.toFixed(2)}${wowText}`;

  // Handle insufficient history: absolute threshold alerts are preserved as info
  if (insufficientHistory) {
    if (absoluteBreached) {
      return {
        isAnomaly: true,
        severity: "info",
        direction,
        currentValue: current.value,
        expectedValue: mu,
        zScore,
        wowPercent,
        deviationSummary,
        status: "insufficient_history",
        caveat: "insufficient_history",
        sep,
        sigmaEff,
        baselineSampleSize: n,
        isSameWeekday: isUsingSameWeekday,
        isPublicHoliday: isCurrentPublicHoliday,
        isMegaSale: isCurrentMegaSale,
        absoluteBreached: true,
        supportCount: current.supportCount,
        minSupport: minOrders,
      };
    }
    return {
      isAnomaly: false,
      severity: "none",
      direction: "none",
      currentValue: current.value,
      expectedValue: mu,
      zScore,
      wowPercent,
      deviationSummary,
      status: "insufficient_history",
      caveat: "insufficient_history",
      sep,
      sigmaEff,
      baselineSampleSize: n,
      isSameWeekday: isUsingSameWeekday,
      isPublicHoliday: isCurrentPublicHoliday,
      isMegaSale: isCurrentMegaSale,
      absoluteBreached: false,
      supportCount: current.supportCount,
      minSupport: minOrders,
    };
  }

  // 8. Severity Determination with Precedence Hierarchy:
  const absZ = Math.abs(zScore);
  const absWoW = wowPercent !== null ? Math.abs(wowPercent) : 0;

  let severity: AlertSeverity | "none" = "none";

  const isStatisticalCritical =
    absZ >= 3.5 ||
    (absWoW >= 50.0 && (current.supportCount ?? 0) >= 2 * minOrders);

  const isStatisticalWarning =
    absZ >= 2.0 && (wowPercent !== null && absWoW >= wowThreshold);

  if (isStatisticalCritical) {
    severity = "critical";
  } else if (isCurrentPublicHoliday && (isStatisticalWarning || absoluteBreached)) {
    // Public holiday downgrade: non-critical alerts downgraded to "info"
    severity = "info";
  } else if (isStatisticalWarning) {
    severity = "warning";
  } else if (absoluteBreached) {
    severity = "info";
  }

  const isAnomaly = severity !== "none";

  return {
    isAnomaly,
    severity,
    direction: isAnomaly ? direction : "none",
    currentValue: current.value,
    expectedValue: mu,
    zScore,
    wowPercent,
    deviationSummary,
    status: "ok",
    sep,
    sigmaEff,
    baselineSampleSize: n,
    isSameWeekday: isUsingSameWeekday,
    isPublicHoliday: isCurrentPublicHoliday,
    isMegaSale: isCurrentMegaSale,
    absoluteBreached,
    supportCount: current.supportCount,
    minSupport: minOrders,
  };
}

export function detectAnomalyFromSeries(
  series: TimeSeriesPoint[],
  options?: Omit<AnomalyDetectorInput, "history" | "current">,
): AnomalyDetectorOutput {
  if (series.length === 0) {
    throw new Error("Cannot detect anomaly from empty time-series");
  }
  const history = series.slice(0, -1);
  const current = series[series.length - 1]!;
  return detectAnomaly({
    history,
    current,
    ...options,
  });
}
