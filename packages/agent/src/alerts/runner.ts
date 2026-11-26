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
  AlertDateSchema,
  executeAlertQuery,
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
  AlertDateSchema.parse(dateStr);
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function seriesCandidateTables(
  metricId: string,
  recipientRole: string | undefined,
): string[] {
  if (metricId !== "metric:review_score_avg") {
    return ["orders", "regions"];
  }
  if (!recipientRole) return ["reviews"];
  const roleLower = recipientRole.toLowerCase();
  const hasRegionScope =
    roleLower.includes("south") ||
    roleLower.includes("nam") ||
    roleLower.includes("north") ||
    roleLower.includes("bac") ||
    roleLower.includes("central") ||
    roleLower.includes("trung");
  return hasRegionScope ? ["reviews", "orders", "regions"] : ["reviews"];
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

  const rbacClauses: string[] = [];
  if (recipientRole) {
    const roleLower = recipientRole.toLowerCase();
    if (roleLower.includes("south") || roleLower.includes("nam")) {
      rbacClauses.push("regions.region = 'Nam'");
    } else if (roleLower.includes("north") || roleLower.includes("bac")) {
      rbacClauses.push("regions.region = 'Bắc'");
    } else if (roleLower.includes("central") || roleLower.includes("trung")) {
      rbacClauses.push("regions.region = 'Trung'");
    }
  }

  const rbacSql = rbacClauses.length > 0 ? ` AND ${rbacClauses.join(" AND ")}` : "";

  if (metricId === "metric:return_rate") {
    return (
      `SELECT orders.purchase_date::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(CASE WHEN orders.status = 'returned' THEN 1.0 ELSE 0.0 END) AS value ` +
      `FROM orders ` +
      `JOIN regions ON orders.province = regions.province ` +
      `WHERE orders.purchase_date >= '${startDate}' AND orders.purchase_date <= '${endDate}'${rbacSql} ` +
      `GROUP BY orders.purchase_date ` +
      `ORDER BY orders.purchase_date ASC`
    );
  }

  if (metricId === "metric:cancellation_rate") {
    return (
      `SELECT orders.purchase_date::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(CASE WHEN orders.status = 'canceled' THEN 1.0 ELSE 0.0 END) AS value ` +
      `FROM orders ` +
      `JOIN regions ON orders.province = regions.province ` +
      `WHERE orders.purchase_date >= '${startDate}' AND orders.purchase_date <= '${endDate}'${rbacSql} ` +
      `GROUP BY orders.purchase_date ` +
      `ORDER BY orders.purchase_date ASC`
    );
  }

  if (metricId === "metric:review_score_avg") {
    const reviewRbacSql =
      rbacClauses.length > 0
        ? `JOIN orders ON reviews.order_id = orders.order_id ` +
        `JOIN regions ON orders.province = regions.province `
        : "";
    const reviewWhereSql =
      rbacClauses.length > 0 ? ` AND ${rbacClauses.join(" AND ")}` : "";
    return (
      `SELECT reviews.created_at::date::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(reviews.score) AS value ` +
      `FROM reviews ` +
      `${reviewRbacSql}` +
      `WHERE reviews.created_at::date >= '${startDate}' AND reviews.created_at::date <= '${endDate}'${reviewWhereSql} ` +
      `GROUP BY reviews.created_at::date ` +
      `ORDER BY reviews.created_at::date ASC`
    );
  }

  if (metricId === "metric:order_count") {
    return (
      `SELECT orders.purchase_date::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `COUNT(*) AS value ` +
      `FROM orders ` +
      `JOIN regions ON orders.province = regions.province ` +
      `WHERE orders.purchase_date >= '${startDate}' AND orders.purchase_date <= '${endDate}'${rbacSql} ` +
      `GROUP BY orders.purchase_date ` +
      `ORDER BY orders.purchase_date ASC`
    );
  }

  return (
    `SELECT orders.purchase_date::text AS date, ` +
    `COUNT(*) AS support_count, ` +
    `SUM(orders.total_amount) AS value ` +
    `FROM orders ` +
    `JOIN regions ON orders.province = regions.province ` +
    `WHERE orders.purchase_date >= '${startDate}' AND orders.purchase_date <= '${endDate}'${rbacSql} ` +
    `GROUP BY orders.purchase_date ` +
    `ORDER BY orders.purchase_date ASC`
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

  // Phase 2: Hypothesis Space m, Residual Pooling & FDR vs Heuristic Fallback
  // Deduplicate candidate subscriptions into unique hypotheses: (metricId, recipientRole, slice)
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
  const isCalibrated = pool.length >= bRequired;

  const candidateFdrSignificant = new Map<CandidateItem, boolean>();
  const candidateHeuristicAlert = new Map<CandidateItem, boolean>();
  const candidatePValues = new Map<CandidateItem, number>();

  if (isCalibrated) {
    // Calibrated Mode: compute empirical p-values per unique hypothesis & Benjamini-Hochberg FDR
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
        candidatePValues.set(c, p);
      }
    });
  } else {
    // Heuristic Fallback Mode (insufficient pooling resolution)
    for (const c of candidateItems) {
      candidateFdrSignificant.set(c, false);
      const absZ = Math.abs(c.anomaly.zScore);
      const absWoW = c.anomaly.wowPercent !== null ? Math.abs(c.anomaly.wowPercent) : 0;
      const wowThreshold = c.subscription.wowThreshold ?? 20;
      const supportCount = c.anomaly.supportCount ?? 0;
      const minSupportCount = c.anomaly.minSupport ?? 15;

      // Heuristic criteria: |z| >= 3.0 AND |WoW%| >= wowThreshold AND supportCount >= minSupport
      const isHeuristic =
        absZ >= 3.0 &&
        c.anomaly.wowPercent !== null &&
        absWoW >= wowThreshold &&
        supportCount >= minSupportCount;

      candidateHeuristicAlert.set(c, isHeuristic);
    }
  }

  // Phase 3: Routing & Severity Precedence (Critical > Holiday > Warning > Info)
  for (const c of candidateItems) {
    try {
      const isFdr = candidateFdrSignificant.get(c) ?? false;
      const isHeuristic = candidateHeuristicAlert.get(c) ?? false;
      const absoluteBreached = Boolean(c.anomaly.absoluteBreached);

      // Admitted candidates into Phase 3 (Strict gate: FDR, Heuristic, or Absolute Breach with support):
      const isEligible = isFdr || isHeuristic || absoluteBreached;

      if (!isEligible) {
        sliceResults.push({
          subscriptionId: c.subscription.id,
          metricId: c.subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: c.anomaly.status,
          anomaly: c.anomaly,
          isFdrSignificant: false,
          isHeuristicAlert: false,
          isUncalibrated: !isCalibrated,
          pValue: candidatePValues.get(c),
        });
        continue;
      }

      // Severity Precedence Hierarchy:
      // 1. Critical: (isFdr || isHeuristic || statisticalCritical) AND (|z| >= 3.5 || (|WoW| >= 50% && support >= 2 * minSupport))
      //    NEVER downgraded, even during public holidays.
      // 2. Holiday Downgrade: public_holiday AND not Critical -> "info"
      // 3. Warning: (isFdr || isHeuristic || absZ >= 2.0) AND not holiday-downgraded
      // 4. Info: absoluteBreached or holiday-downgraded
      const absZ = Math.abs(c.anomaly.zScore);
      const absWoW = c.anomaly.wowPercent !== null ? Math.abs(c.anomaly.wowPercent) : 0;
      const minSupportCount = c.anomaly.minSupport ?? 15;
      const supportCount = c.anomaly.supportCount ?? 0;
      const isPublicHoliday = Boolean(c.anomaly.isPublicHoliday);

      let finalSeverity: AlertSeverity = "info";

      const wowThreshold = c.subscription.wowThreshold ?? 20;

      const isCritical =
        (isFdr || isHeuristic) &&
        (absZ >= 3.5 || (absWoW >= 50.0 && supportCount >= 2 * minSupportCount));

      const isStatisticalWarning =
        (isFdr || isHeuristic) &&
        absZ >= 2.0 &&
        c.anomaly.wowPercent !== null &&
        absWoW >= wowThreshold;

      if (isCritical) {
        finalSeverity = "critical";
      } else if (isPublicHoliday && (isStatisticalWarning || absoluteBreached)) {
        // Holiday downgrade: non-critical alerts on public holidays downgraded to info
        finalSeverity = "info";
      } else if (isStatisticalWarning) {
        finalSeverity = "warning";
      } else if (absoluteBreached) {
        finalSeverity = "info";
      }

      anomaliesDetected++;

      const updatedAnomaly: AnomalyDetectorOutput = {
        ...c.anomaly,
        isAnomaly: true,
        severity: finalSeverity,
      };

      // 4. Anomaly Found: Invoke 1-2 Dimension Drill-Down Analyzer (LLM)
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

      // 5. Dispatch Alert via Resilient send_alert Dispatcher
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
        isUncalibrated: !isCalibrated,
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
