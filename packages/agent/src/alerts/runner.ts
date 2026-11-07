import { sqlGuard } from "@shared/access-policy";
import type { AlertSeverity, AnomalyAlert, SchemaCatalog, Subscription } from "@shared/contracts";
import {
  detectAnomaly,
  type AnomalyDetectorOutput,
  type TimeSeriesPoint,
} from "./anomalyDetector.js";
import { DEFAULT_ANOMALY_CATALOG } from "./catalog.js";
import {
  dispatchAlert,
  globalDigestQueue,
  InMemoryAlertHistoryStore,
  type AlertDispatcherOptions,
  type AlertHistoryStore,
  type DispatchAlertResult,
} from "./dispatcher.js";
import {
  runDrillDownAnalysis,
  type DrillDownResult,
  type McpQueryExecutor,
} from "./drillDown.js";
import { loadSubscriptionsConfigFile } from "./subscription.js";

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
  targetDate?: string; // YYYY-MM-DD
  subscriptionId?: string; // single subscription filter
  manual?: boolean;
  flushDigest?: boolean;
  catalog?: SchemaCatalog;
  mcpExecutor: McpQueryExecutor;
  historyStore?: AlertHistoryStore;
  dispatcherOptions?: Partial<AlertDispatcherOptions>;
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
  mockSeriesProvider?: (subscription: Subscription, targetDate: string) => TimeSeriesPoint[];
}

/**
 * Computes date string minus N days: returns YYYY-MM-DD.
 */
export function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the 35-day time-series query (28-day baseline + 7-day WoW window)
 * with RBAC condition injected from recipient role (UC-10 §6).
 */
export function buildTimeSeriesQuery(options: {
  metricId: string;
  startDate: string;
  endDate: string;
  recipientRole?: string;
}): string {
  const { metricId, startDate, endDate, recipientRole } = options;

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
    return (
      `SELECT reviews.created_at::date::text AS date, ` +
      `COUNT(*) AS support_count, ` +
      `AVG(reviews.score) AS value ` +
      `FROM reviews ` +
      `WHERE reviews.created_at::date >= '${startDate}' AND reviews.created_at::date <= '${endDate}' ` +
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

  // Default: net_revenue
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

/**
 * Periodic Anomaly Detection & Governed Alert Runner (UC-10, F10.1–F10.5)
 *
 * Can be run via scheduled cron (07:00 daily) or manually via CLI:
 * `pnpm alert:run --manual [--date X] [--flush-digest]`
 */
export async function runAnomalyRunner(
  options: AnomalyRunnerOptions,
): Promise<AnomalyRunnerResult> {
  const {
    targetDate = new Date().toISOString().slice(0, 10),
    manual = true,
    flushDigest = false,
    mcpExecutor,
    logger,
    mockSeriesProvider,
  } = options;

  const historyStore = options.historyStore ?? new InMemoryAlertHistoryStore();
  const dispatcherOpts: AlertDispatcherOptions = {
    historyStore,
    flushDigest,
    logger,
    ...options.dispatcherOptions,
  };

  // 1. Load subscriptions
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

  // 2. Iterate each subscription with Fault Isolation (K5 checkpointing per-metric)
  for (const subscription of subs) {
    try {
      let series: TimeSeriesPoint[];

      if (mockSeriesProvider) {
        series = mockSeriesProvider(subscription, targetDate);
      } else {
        // Query historical window: 35 days (28 days baseline + 7 days WoW)
        const startDate = subtractDays(targetDate, 35);
        const querySql = buildTimeSeriesQuery({
          metricId: subscription.metricId,
          startDate,
          endDate: targetDate,
          recipientRole: subscription.recipientRole,
        });

        // sqlGuard validation
        const catalog = options.catalog ?? DEFAULT_ANOMALY_CATALOG;
        const guard = await sqlGuard(querySql, catalog);
        if (!guard.ok) {
          throw new Error(`Guard failed on series SQL: ${guard.error.message}`);
        }

        const queryRes = await mcpExecutor(querySql);
        if (queryRes.error) {
          throw new Error(`Failed to query timeseries: ${queryRes.error}`);
        }

        series = (queryRes.rows || []).map((row) => ({
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

      // Current point is the last point in series
      const current = series[series.length - 1];
      const history = series.slice(0, -1);

      // 3. Statistical Anomaly Detection (Pure Code, 0 LLM cost on normal days)
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
      });

      if (!anomaly.isAnomaly) {
        sliceResults.push({
          subscriptionId: subscription.id,
          metricId: subscription.metricId,
          date: targetDate,
          isAnomaly: false,
          severity: "none",
          status: anomaly.status,
          anomaly,
        });
        continue;
      }

      // 4. Anomaly Found: Invoke 1-2 Dimension Drill-Down Analyzer (LLM)
      anomaliesDetected++;
      const drillDown = await runDrillDownAnalysis({
        subscription,
        dimensionKey: current.date,
        date: targetDate,
        anomaly,
        mcpExecutor,
        recipientRole: subscription.recipientRole,
      });

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
        subscriptionId: subscription.id,
        metricId: subscription.metricId,
        date: targetDate,
        isAnomaly: true,
        severity: anomaly.severity,
        status: anomaly.status,
        anomaly,
        drillDown,
        alert: drillDown.alert,
        dispatchResult,
      });
    } catch (err) {
      // Fault isolation: error in 1 slice/subscription does NOT crash the entire runner!
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
      logger?.(`Subscription ${subscription.id} failed, continuing other slices`, {
        error: errorMsg,
      });
    }
  }

  // 6. Handle digest flushing if requested
  let flushedDigestCount = 0;
  if (flushDigest && globalDigestQueue.size() > 0) {
    const items = globalDigestQueue.clear();
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

/**
 * Lightweight cron scheduler for UC-10 (runs daily at specified hour).
 */
export function scheduleAnomalyCron(
  options: AnomalyRunnerOptions & {
    hour?: number; // 0-23, default 7 (07:00 daily)
    minute?: number; // 0-59, default 0
    onComplete?: (result: AnomalyRunnerResult) => void;
  },
): { stop: () => void } {
  const { hour = 7, minute = 0, onComplete } = options;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const msUntilNext = next.getTime() - now.getTime();

    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const result = await runAnomalyRunner({ ...options, manual: false });
        onComplete?.(result);
      } catch (err) {
        options.logger?.("Scheduled anomaly run failed", { error: String(err) });
      }
      scheduleNext();
    }, msUntilNext);
  };

  scheduleNext();

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
