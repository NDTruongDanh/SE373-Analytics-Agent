import cron from "node-cron";
import type { AlertSeverity, AnomalyAlert, SchemaCatalog, Subscription } from "@shared/contracts";
import {
  detectAnomaly,
  type AnomalyDetectorOutput,
  type TimeSeriesPoint,
} from "./anomalyDetector.js";
import { type CalendarConfig } from "./calendar.js";
import { DEFAULT_ANOMALY_CATALOG } from "./catalog.js";
import {
  dispatchAlert,
  persistentDigestQueue,
  type AlertDispatcherOptions,
  type AlertDigestQueue,
  type AlertHistoryStore,
  type DispatchAlertResult,
} from "./dispatcher.js";
import {
  runDrillDownAnalysis,
  type DrillDownResult,
} from "./drillDown.js";
import {
  addDaysToDate,
  AlertDateSchema,
  bangkokDayBounds,
  executeAlertQuery,
  parseRegionScope,
  type AlertQueryExecutor,
} from "./query.js";
import { loadSubscriptionsConfigFile } from "./subscription.js";
import type { ExecutorPrincipal } from "../queryExecutor/executor.js";

export interface AnomalyRunnerSliceResult {
  subscriptionId: string;
  metricId: string;
  date: string;
  isAnomaly: boolean;
  severity: AlertSeverity | "none";
  status: "ok" | "skipped_insufficient_support" | "insufficient_history" | "failed";
  error?: string;
  anomaly?: AnomalyDetectorOutput;
  drillDown?: DrillDownResult;
  alert?: AnomalyAlert;
  dispatchResult?: DispatchAlertResult;
  isFdrSignificant?: boolean;
  isHeuristicAlert?: boolean;
  isUncalibrated?: boolean;
  pValue?: number;
}

export interface AnomalyRunnerResult {
  date: string;
  manual: boolean;
  totalSubscriptions: number;
  evaluatedSubscriptions: number;
  anomaliesDetected: number;
  alertsSent: number;
  alertsQueued: number;
  alertsSkippedDuplicate: number;
  alertsBlocked: number;
  failures: Array<{ subscriptionId: string; error: string }>;
  sliceResults: AnomalyRunnerSliceResult[];
  flushedDigestCount?: number;
}

export interface AnomalyRunnerOptions {
  subscriptions?: Subscription[];
  configPath?: string;
  targetDate?: string;
  subscriptionId?: string;
  manual?: boolean;
  flushDigest?: boolean;
  catalog?: SchemaCatalog;
  queryExecutor: AlertQueryExecutor;
  queryPrincipal: ExecutorPrincipal;
  historyStore: AlertHistoryStore;
  digestQueue?: AlertDigestQueue;
  dispatcherOptions?: Partial<AlertDispatcherOptions>;
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
  mockSeriesProvider?: (subscription: Subscription, targetDate: string) => TimeSeriesPoint[];
  poolingResiduals?: number[];
  calendarConfig?: CalendarConfig;
  byFallback?: boolean;
  model?: unknown;
}

/**
 * Computes two-tailed empirical p-value against pooled decorrelated residuals:
 * p = (1 + sum_b I(|z_b| >= |z_i|)) / (B + 1)
 */
export function calculateEmpiricalPValue(z: number, pool: number[]): number {
  if (pool.length === 0) return 1.0;
  const absZ = Math.abs(z);
  let count = 0;
  for (const residual of pool) {
    if (Math.abs(residual) >= absZ) {
      count++;
    }
  }
  return (1 + count) / (pool.length + 1);
}

// Numerical Recipes erfc approximation (~1.2e-7 max relative error) avoids external stats dependencies.
function erfcApprox(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

export function normalTwoTailedPValue(z: number): number {
  if (!Number.isFinite(z)) return 1.0;
  return Math.min(1.0, Math.max(0.0, erfcApprox(Math.abs(z) / Math.SQRT2)));
}

function logGamma(xx: number): number {
  const cof = [
    76.18009172947146,
    -86.50532032941677,
    24.01409824083091,
    -1.231739572450155,
    0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  let y = xx;
  const x = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j]! / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  return h;
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b;
}

export function studentTTwoTailedPValue(t: number, df: number): number {
  if (!Number.isFinite(t) || df < 1) return 1.0;
  if (t === 0) return 1.0;
  const x = df / (df + t * t);
  return Math.min(1.0, Math.max(0.0, regularizedIncompleteBeta(df / 2, 0.5, x)));
}

/**
 * Use Student's t (df = n - 1) for small same-weekday samples (4 <= n <= 8) to avoid
 * anticonservative tails when SEP scale is estimated from few observations; otherwise Normal.
 */
export function calculateStatisticalPValue(anomaly: AnomalyDetectorOutput): number {
  if (!Number.isFinite(anomaly.zScore)) return 1.0;
  const n = anomaly.baselineSampleSize;
  if (anomaly.isSameWeekday && n !== undefined && n >= 4 && n <= 8) {
    return studentTTwoTailedPValue(anomaly.zScore, Math.max(1, n - 1));
  }
  return normalTwoTailedPValue(anomaly.zScore);
}

/**
 * Benjamini-Hochberg (BH) or Benjamini-Yekutieli (BY) FDR control procedure:
 * Controls False Discovery Proportion at level q (default 0.05).
 */
export function calculateFdrSignificance(options: {
  pValues: number[];
  q?: number;
  useByFallback?: boolean;
}): boolean[] {
  const { pValues, q = 0.05, useByFallback = false } = options;
  const m = pValues.length;
  if (m === 0) return [];

  const indexed = pValues.map((p, idx) => ({ p, idx }));
  indexed.sort((a, b) => a.p - b.p);

  let byFactor = 1.0;
  if (useByFallback) {
    let harmonicSum = 0;
    for (let i = 1; i <= m; i++) harmonicSum += 1 / i;
    byFactor = harmonicSum;
  }

  let maxK = -1;
  for (let k = 1; k <= m; k++) {
    const threshold = (k / m) * (q / byFactor);
    if (indexed[k - 1]!.p <= threshold) {
      maxK = k;
    }
  }

  const rejected = new Array<boolean>(m).fill(false);
  if (maxK > 0) {
    for (let k = 0; k < maxK; k++) {
      rejected[indexed[k]!.idx] = true;
    }
  }
  return rejected;
}

export function subtractDays(dateStr: string, days: number): string {
  return addDaysToDate(dateStr, -days);
}

export function seriesCandidateTables(
  metricId: string,
  recipientRole: string | undefined,
): string[] {
  const hasRegionScope = parseRegionScope(recipientRole) !== null;
  if (metricId === "metric:review_score_avg") {
    return hasRegionScope ? ["reviews", "orders", "customers"] : ["reviews"];
  }
  if (
    metricId === "metric:return_rate" ||
    metricId === "metric:cancellation_rate" ||
    metricId === "metric:order_count"
  ) {
    return hasRegionScope ? ["orders", "customers"] : ["orders"];
  }
  return hasRegionScope
    ? ["orders", "order_items", "customers"]
    : ["orders", "order_items"];
}

export function buildTimeSeriesQuery(options: {
  metricId: string;
  startDate: string;
  endDate: string;
  recipientRole?: string;
}): string {
  const { metricId, startDate, endDate, recipientRole } = options;
  AlertDateSchema.parse(startDate);
  AlertDateSchema.parse(endDate);
  if (startDate > endDate) {
    throw new Error("Time-series startDate must not be after endDate");
  }

  const { startIso, endExclusiveIso } = bangkokDayBounds(startDate, endDate);
  const regionScope = parseRegionScope(recipientRole);
  const customerJoin = regionScope
    ? " JOIN customers ON orders.customer_id = customers.customer_id"
    : "";
  const rbacSql = regionScope ? ` AND customers.region_group = '${regionScope}'` : "";
  const localOrderDate = "(orders.purchase_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
  const orderDateWhere =
    `orders.purchase_date >= '${startIso}' AND orders.purchase_date < '${endExclusiveIso}'`;

  if (metricId === "metric:return_rate") {
    return (
      `SELECT ${localOrderDate}::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(CASE WHEN orders.status = 'returned' THEN 1.0 ELSE 0.0 END) AS value ` +
      `FROM orders${customerJoin} ` +
      `WHERE ${orderDateWhere}${rbacSql} ` +
      `GROUP BY ${localOrderDate} ` +
      `ORDER BY ${localOrderDate} ASC`
    );
  }

  if (metricId === "metric:cancellation_rate") {
    return (
      `SELECT ${localOrderDate}::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(CASE WHEN orders.status = 'canceled' THEN 1.0 ELSE 0.0 END) AS value ` +
      `FROM orders${customerJoin} ` +
      `WHERE ${orderDateWhere}${rbacSql} ` +
      `GROUP BY ${localOrderDate} ` +
      `ORDER BY ${localOrderDate} ASC`
    );
  }

  if (metricId === "metric:review_score_avg") {
    const localReviewDate = "(reviews.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date";
    const reviewJoins = regionScope
      ? `JOIN orders ON reviews.order_id = orders.order_id${customerJoin} `
      : "";
    const reviewOrderBound = regionScope
      ? ` AND orders.purchase_date >= '2020-01-01T00:00:00+07:00' AND orders.purchase_date < '${endExclusiveIso}'`
      : "";
    return (
      `SELECT ${localReviewDate}::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(reviews.score) AS value ` +
      `FROM reviews ` +
      `${reviewJoins}` +
      `WHERE reviews.created_at >= '${startIso}' AND reviews.created_at < '${endExclusiveIso}'` +
      `${reviewOrderBound}${rbacSql} ` +
      `GROUP BY ${localReviewDate} ` +
      `ORDER BY ${localReviewDate} ASC`
    );
  }

  if (metricId === "metric:order_count") {
    return (
      `SELECT ${localOrderDate}::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `COUNT(*) AS value ` +
      `FROM orders${customerJoin} ` +
      `WHERE ${orderDateWhere}${rbacSql} ` +
      `GROUP BY ${localOrderDate} ` +
      `ORDER BY ${localOrderDate} ASC`
    );
  }

  return (
    `WITH order_net AS (` +
    `SELECT orders.order_id, ${localOrderDate} AS order_date, ` +
    `SUM(CASE WHEN orders.status = 'delivered' THEN order_items.price_vnd ` +
    `WHEN orders.status = 'returned' THEN -order_items.price_vnd ELSE 0 END) AS net_amount ` +
    `FROM orders ` +
    `JOIN order_items ON orders.order_id = order_items.order_id${customerJoin} ` +
    `WHERE ${orderDateWhere} AND orders.status IN ('delivered', 'returned')${rbacSql} ` +
    `GROUP BY orders.order_id, ${localOrderDate}` +
    `) ` +
    `SELECT order_net.order_date::text AS date, ` +
    `COUNT(*) AS support_count, ` +
    `COALESCE(SUM(order_net.net_amount), 0) AS value ` +
    `FROM order_net ` +
    `GROUP BY order_net.order_date ` +
    `ORDER BY order_net.order_date ASC`
  );
}

export async function runAnomalyRunner(
  options: AnomalyRunnerOptions,
): Promise<AnomalyRunnerResult> {
  const {
    targetDate = new Date().toISOString().slice(0, 10),
    manual = true,
    flushDigest = false,
    logger,
    mockSeriesProvider,
  } = options;

  AlertDateSchema.parse(targetDate);
  const historyStore = options.historyStore;
  const digestQueue = options.digestQueue ?? persistentDigestQueue;
  const dispatcherOpts: AlertDispatcherOptions = {
    ...options.dispatcherOptions,
    historyStore,
    digestQueue,
    flushDigest,
    logger,
  };

  let subs = options.subscriptions;
  if (!subs) {
    const config = loadSubscriptionsConfigFile(options.configPath);
    subs = config.subscriptions;
  }

  if (options.subscriptionId) {
    subs = subs.filter((s) => s.id === options.subscriptionId);
  }

  const failures: Array<{ subscriptionId: string; error: string }> = [];
  const sliceResults: AnomalyRunnerSliceResult[] = [];
  let anomaliesDetected = 0;
  let alertsSent = 0;
  let alertsQueued = 0;
  let alertsSkippedDuplicate = 0;
  let alertsBlocked = 0;

  interface CandidateItem {
    subscription: Subscription;
    series: TimeSeriesPoint[];
    current: TimeSeriesPoint;
    history: TimeSeriesPoint[];
    anomaly: AnomalyDetectorOutput;
    hypothesisKey: string;
  }
  const candidateItems: CandidateItem[] = [];

  for (const subscription of subs) {
    try {
      let series: TimeSeriesPoint[];

      if (mockSeriesProvider) {
        series = mockSeriesProvider(subscription, targetDate);
      } else {
        const startDate = subtractDays(targetDate, 63);
        const querySql = buildTimeSeriesQuery({
          metricId: subscription.metricId,
          startDate,
          endDate: targetDate,
          recipientRole: subscription.recipientRole,
        });

        const catalog = options.catalog ?? DEFAULT_ANOMALY_CATALOG;
        const queryRes = await executeAlertQuery({
          queryExecutor: options.queryExecutor,
          principal: options.queryPrincipal,
          catalog,
          question:
            `Query the ${subscription.metricId} daily time series from ` +
            `${startDate} through ${targetDate} using the supplied SQL.`,
          sql: querySql,
          candidateTables: seriesCandidateTables(
            subscription.metricId,
            subscription.recipientRole,
          ),
        });

        series = queryRes.rows.map((row) => ({
          date: String(row.date),
          value: Number(row.value ?? 0),
          supportCount:
            row.support_count !== undefined ? Number(row.support_count) : undefined,
        }));
      }

      if (series.length === 0) {
        sliceResults.push({
          subscriptionId: subscription.id,
          metricId: subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: "insufficient_history",
        });
        continue;
      }

      const current = series[series.length - 1]!;
      // Do not score stale data when targetDate itself has no row yet.
      if (current.date !== targetDate) {
        sliceResults.push({
          subscriptionId: subscription.id,
          metricId: subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: "skipped_insufficient_support",
        });
        continue;
      }
      const history = series.slice(0, -1);

      const anomaly = detectAnomaly({
        history,
        current,
        metricId: subscription.metricId,
        minSupport: subscription.minSupport,
        absoluteThreshold: subscription.absoluteThreshold
          ? {
            operator: subscription.absoluteThreshold.operator,
            value: subscription.absoluteThreshold.value,
          }
          : undefined,
        calendarConfig: options.calendarConfig,
        wowThreshold: subscription.wowThreshold,
      });

      if (anomaly.status === "skipped_insufficient_support") {
        sliceResults.push({
          subscriptionId: subscription.id,
          metricId: subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: "skipped_insufficient_support",
          anomaly,
        });
        continue;
      }

      if (anomaly.status === "insufficient_history" && !anomaly.absoluteBreached) {
        sliceResults.push({
          subscriptionId: subscription.id,
          metricId: subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: "insufficient_history",
          anomaly,
        });
        continue;
      }

      const slice = subscription.primaryDimension ?? "overall";
      const role = subscription.recipientRole ?? "all";
      const hypothesisKey = `${subscription.metricId}|${role}|${slice}`;
      candidateItems.push({
        subscription,
        series,
        current,
        history,
        anomaly,
        hypothesisKey,
      });
    } catch (err) {
      // Isolate failures per subscription so one bad slice does not abort the batch.
      const errorMsg = err instanceof Error ? err.message : String(err);
      failures.push({
        subscriptionId: subscription.id,
        error: errorMsg,
      });
      sliceResults.push({
        subscriptionId: subscription.id,
        metricId: subscription.metricId,
        date: targetDate,
        isAnomaly: false,
        severity: "none",
        status: "failed",
        error: errorMsg,
      });
      logger?.(`Subscription ${subscription.id} failed in Phase 1, continuing other slices`, {
        error: errorMsg,
      });
    }
  }

  // Deduplicate candidate subscriptions into unique hypotheses: (metricId, recipientRole, slice).
  const hypothesisGroups = new Map<string, CandidateItem[]>();
  for (const c of candidateItems) {
    const list = hypothesisGroups.get(c.hypothesisKey) ?? [];
    list.push(c);
    hypothesisGroups.set(c.hypothesisKey, list);
  }

  const uniqueHypothesisEntries = Array.from(hypothesisGroups.entries());
  const m = Math.max(1, uniqueHypothesisEntries.length);
  const q = 0.05;
  const bRequired = Math.max(500, Math.ceil(m / q) * 2);

  const pool = options.poolingResiduals ?? [];
  const hasEmpiricalPool = pool.length >= bRequired;

  const candidateFdrSignificant = new Map<CandidateItem, boolean>();
  const candidateHeuristicAlert = new Map<CandidateItem, boolean>();
  const candidateUncalibrated = new Map<CandidateItem, boolean>();
  const candidatePValues = new Map<CandidateItem, number>();

  const evalHeuristicFallback = (c: CandidateItem): boolean => {
    const absZ = Math.abs(c.anomaly.zScore);
    const absWoW = c.anomaly.wowPercent !== null ? Math.abs(c.anomaly.wowPercent) : 0;
    const wowThreshold = c.subscription.wowThreshold ?? 20;
    const supportCount = c.anomaly.supportCount ?? 0;
    const minSupportCount = c.anomaly.minSupport ?? 15;
    return (
      Number.isFinite(absZ) &&
      absZ >= 3.0 &&
      c.anomaly.wowPercent !== null &&
      absWoW >= wowThreshold &&
      supportCount >= minSupportCount
    );
  };

  if (hasEmpiricalPool) {
    const hypothesisPValues = uniqueHypothesisEntries.map(([, group]) => {
      const rep = group[0]!;
      return calculateEmpiricalPValue(rep.anomaly.zScore, pool);
    });

    const rejections = calculateFdrSignificance({
      pValues: hypothesisPValues,
      q,
      useByFallback: options.byFallback,
    });

    uniqueHypothesisEntries.forEach(([, group], idx) => {
      const isRejected = rejections[idx] ?? false;
      const p = hypothesisPValues[idx] ?? 1.0;
      for (const c of group) {
        candidateFdrSignificant.set(c, isRejected);
        candidateHeuristicAlert.set(c, false);
        candidateUncalibrated.set(c, false);
        candidatePValues.set(c, p);
      }
    });
  } else {
    const fdrEntries: Array<{ group: CandidateItem[]; pValue: number }> = [];
    for (const [, group] of uniqueHypothesisEntries) {
      const rep = group[0]!;
      const hasValidZ =
        rep.anomaly.status === "ok" && Number.isFinite(rep.anomaly.zScore);
      if (hasValidZ) {
        fdrEntries.push({
          group,
          pValue: calculateStatisticalPValue(rep.anomaly),
        });
      } else {
        for (const c of group) {
          candidateFdrSignificant.set(c, false);
          candidateUncalibrated.set(c, true);
          candidateHeuristicAlert.set(c, evalHeuristicFallback(c));
        }
      }
    }

    if (fdrEntries.length > 0) {
      const rejections = calculateFdrSignificance({
        pValues: fdrEntries.map((entry) => entry.pValue),
        q,
        useByFallback: options.byFallback,
      });
      fdrEntries.forEach((entry, idx) => {
        const isRejected = rejections[idx] ?? false;
        for (const c of entry.group) {
          candidateFdrSignificant.set(c, isRejected);
          candidateHeuristicAlert.set(c, false);
          candidateUncalibrated.set(c, false);
          candidatePValues.set(c, entry.pValue);
        }
      });
    }
  }

  for (const c of candidateItems) {
    try {
      const isFdr = candidateFdrSignificant.get(c) ?? false;
      const isHeuristic = candidateHeuristicAlert.get(c) ?? false;
      const isUncalibrated = candidateUncalibrated.get(c) ?? false;
      const absoluteBreached = Boolean(c.anomaly.absoluteBreached);

      const absZ = Math.abs(c.anomaly.zScore);
      const absWoW = c.anomaly.wowPercent !== null ? Math.abs(c.anomaly.wowPercent) : 0;
      const minSupportCount = c.anomaly.minSupport ?? 15;
      const supportCount = c.anomaly.supportCount ?? 0;
      const isPublicHoliday = Boolean(c.anomaly.isPublicHoliday);
      const wowThreshold = c.subscription.wowThreshold ?? 20;

      const isCritical =
        (isFdr || isHeuristic) &&
        (absZ >= 3.5 || (absWoW >= 50.0 && supportCount >= 2 * minSupportCount));

      const isStatisticalWarning =
        (isFdr || isHeuristic) &&
        absZ >= 2.0 &&
        c.anomaly.wowPercent !== null &&
        absWoW >= wowThreshold;

      let finalSeverity: AlertSeverity | "none" = "none";
      if (isCritical) {
        finalSeverity = "critical";
      } else if (isPublicHoliday && (isStatisticalWarning || absoluteBreached)) {
        finalSeverity = "info";
      } else if (isStatisticalWarning) {
        finalSeverity = "warning";
      } else if (absoluteBreached) {
        finalSeverity = "info";
      }

      if (finalSeverity === "none") {
        sliceResults.push({
          subscriptionId: c.subscription.id,
          metricId: c.subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: c.anomaly.status,
          anomaly: c.anomaly,
          isFdrSignificant: isFdr,
          isHeuristicAlert: isHeuristic,
          isUncalibrated,
          pValue: candidatePValues.get(c),
        });
        continue;
      }

      anomaliesDetected++;

      const updatedAnomaly: AnomalyDetectorOutput = {
        ...c.anomaly,
        isAnomaly: true,
        severity: finalSeverity,
      };

      const drillDown = await runDrillDownAnalysis({
        subscription: c.subscription,
        dimensionKey: c.current.date,
        date: targetDate,
        anomaly: updatedAnomaly,
        queryExecutor: options.queryExecutor,
        queryPrincipal: options.queryPrincipal,
        recipientRole: c.subscription.recipientRole,
        catalog: options.catalog,
        model: options.model,
      });

      drillDown.alert.severity = finalSeverity;

      const dispatchResult = await dispatchAlert(drillDown.alert, dispatcherOpts);

      if (dispatchResult.sent) {
        alertsSent++;
      } else if (dispatchResult.skippedDuplicate) {
        alertsSkippedDuplicate++;
      } else if (dispatchResult.queued) {
        alertsQueued++;
      } else if (dispatchResult.blocked) {
        alertsBlocked++;
      }

      sliceResults.push({
        subscriptionId: c.subscription.id,
        metricId: c.subscription.metricId,
        date: targetDate,
        isAnomaly: true,
        severity: finalSeverity,
        status: c.anomaly.status,
        anomaly: updatedAnomaly,
        drillDown,
        alert: drillDown.alert,
        dispatchResult,
        isFdrSignificant: isFdr,
        isHeuristicAlert: isHeuristic,
        isUncalibrated,
        pValue: candidatePValues.get(c),
      });
    } catch (err) {
      // Fault isolation: error in drilldown or dispatch does NOT crash runner
      const errorMsg = err instanceof Error ? err.message : String(err);
      failures.push({
        subscriptionId: c.subscription.id,
        error: errorMsg,
      });
      sliceResults.push({
        subscriptionId: c.subscription.id,
        metricId: c.subscription.metricId,
        date: targetDate,
        isAnomaly: false,
        severity: "none",
        status: "failed",
        error: errorMsg,
      });
      logger?.(`Subscription ${c.subscription.id} failed in Phase 3, continuing other slices`, {
        error: errorMsg,
      });
    }
  }

  let flushedDigestCount = 0;
  if (flushDigest && digestQueue.size() > 0) {
    const items = digestQueue.getAll();
    for (const alert of items) {
      const dispatchResult = await dispatchAlert(alert, {
        ...dispatcherOpts,
        flushDigest: true,
      });
      if (dispatchResult.sent) {
        alertsSent++;
      } else if (dispatchResult.skippedDuplicate) {
        alertsSkippedDuplicate++;
      } else if (dispatchResult.queued) {
        alertsQueued++;
      } else if (dispatchResult.blocked) {
        alertsBlocked++;
      }
    }
    digestQueue.clear();
    flushedDigestCount = items.length;
    logger?.(`Flushed ${flushedDigestCount} alerts from digest queue`);
  }

  return {
    date: targetDate,
    manual,
    totalSubscriptions: subs.length,
    evaluatedSubscriptions: sliceResults.length,
    anomaliesDetected,
    alertsSent,
    alertsQueued,
    alertsSkippedDuplicate,
    alertsBlocked,
    failures,
    sliceResults,
    flushedDigestCount,
  };
}

export function scheduleAnomalyCron(
  options: AnomalyRunnerOptions & {
    cronExpression?: string;
    hour?: number;
    minute?: number;
    onComplete?: (result: AnomalyRunnerResult) => void;
  },
): { stop: () => void } {
  const { hour = 7, minute = 0, cronExpression, onComplete } = options;
  const expr = cronExpression ?? `${minute} ${hour} * * *`;

  const task = cron.schedule(expr, async () => {
    try {
      const result = await runAnomalyRunner({ ...options, manual: false });
      onComplete?.(result);
    } catch (err) {
      options.logger?.("Scheduled anomaly run failed", { error: String(err) });
    }
  });

  return {
    stop: () => {
      task.stop();
    },
  };
}
