// UC-10 eval grader (PRD §6, docs/UC-plan/UC10.md §9): pure, DB-free, keyless.
// Grades all 8 acceptance cases covering seeded anomalies A1-A5, normal-week
// false-positive bound (<= 3 FP/week), min_support sparse-slice skip,
// trimmed-baseline contamination resistance, 24h same-day deduplication with
// cross-recipient isolation, 5xx retry/queue + recovery write-after-send,
// query-time RBAC SQL injection, and 2nd-pass PII blocking.
//
// Runs under `pnpm eval --uc uc10` (or `pnpm eval --uc 10`) and exercises the
// real ValidatedQueryExecutor + sqlGuard + LocalQuerySafetyGate + runAnomalyRunner
// + sendAlert/dispatchAlert + loadSkill("anomaly-alert") + TraceEvent emitter.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactPII, sqlGuard, warmupSqlGuard } from "@shared/access-policy";
import {
  AnomalyAlertSchema,
  type AnomalyAlert,
  type Subscription,
} from "../../packages/contracts/src/alert.js";
import {
  detectAnomaly,
  type TimeSeriesPoint,
} from "../../packages/agent/src/alerts/anomalyDetector.js";
import { DEFAULT_ANOMALY_CATALOG } from "../../packages/agent/src/alerts/catalog.js";
import {
  dispatchAlert,
  flushFailedAlertsQueue,
  InMemoryAlertHistoryStore,
  InMemoryDigestQueue,
  type SendAlertTransport,
} from "../../packages/agent/src/alerts/dispatcher.js";
import { buildDrillDownSql } from "../../packages/agent/src/alerts/drillDown.js";
import { calculateAlertFingerprint } from "../../packages/agent/src/alerts/fingerprint.js";
import {
  buildTimeSeriesQuery,
  runAnomalyRunner,
  subtractDays,
} from "../../packages/agent/src/alerts/runner.js";
import { sendAlert } from "../../packages/agent/src/alerts/sendAlert.js";
import { loadSubscriptionsConfigFile } from "../../packages/agent/src/alerts/subscription.js";
import {
  ValidatedQueryExecutor,
  type McpToolCaller,
} from "../../packages/agent/src/queryExecutor/executor.js";
import { loadSkill } from "../../packages/agent/src/skills/loader.js";
import type { ExecutorPrincipal } from "../../packages/agent/src/queryExecutor/executor.js";
import { createSpanEmitter } from "../../packages/agent/src/telemetry/spans.js";

/** PRD UC-10 acceptance gates. */
export const UC10_DETECTION_RATE_MIN = 0.8; // >= 4/5 seeded anomalies
export const UC10_MAX_FP_PER_WEEK = 3; // <= 3 false positives per normal week
export const UC10_SIX_FIELD_MIN = 1.0; // 100% 6-field completeness

export interface GradedCase {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
  costUsd?: number;
  note?: string;
}

export interface Uc10Summary {
  seededDetected: number;
  seededTotal: number;
  detectionRate: number;
  falsePositivesPerNormalWeek: number;
  minSupportSkipped: boolean;
  sixFieldCompleteness: number;
  dedupPass: boolean;
  retryQueuePass: boolean;
  piiLeaks: number;
  meanLatencyMs: number;
  meanTokens: number;
  totalCostUsd: number;
  gatesPassed: boolean;
  gateFailures: string[];
}

export interface Uc10Results {
  cases: GradedCase[];
  summary: Uc10Summary;
  gatesPassed: boolean;
}

interface Uc10CaseRow {
  id: string;
  caseId: string;
  kind: "seeded_anomaly" | "fp_and_support" | "dedup_24h" | "retry_rbac_pii";
  name: string;
  metricId: string;
  targetDate: string;
  expectedSeverity?: "info" | "warning" | "critical";
  expectedDirection?: "spike" | "drop";
  expectedSegmentIncludes?: string;
  requireSixFields?: boolean;
  maxFpPerWeek?: number;
  maxRetries?: number;
  notes?: string;
}

function readJsonl(file: string): Uc10CaseRow[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Uc10CaseRow);
}

function buildDateRangeSeries(
  targetDate: string,
  daysBefore: number,
  builder: (date: string, index: number) => { value: number; supportCount: number },
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  for (let offset = daysBefore; offset >= 0; offset -= 1) {
    const date = subtractDays(targetDate, offset);
    const { value, supportCount } = builder(date, daysBefore - offset);
    points.push({ date, value, supportCount });
  }
  return points;
}

function createDeterministicMcp(params: {
  resolveSeries: (sql: string) => TimeSeriesPoint[];
  resolveDrillDownRows: (sql: string) => Record<string, unknown>[];
}): McpToolCaller {
  return {
    call: async (tool: string, args: Record<string, unknown>) => {
      if (tool === "describe_table") {
        const tableName = String(args["table"] ?? "");
        const table = DEFAULT_ANOMALY_CATALOG.tables.find(
          (entry) => entry.name.toLowerCase() === tableName.toLowerCase(),
        );
        if (!table) {
          throw new Error(`Unknown table: ${tableName}`);
        }
        return {
          table: table.name,
          columns: table.columns.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            sensitive: c.sensitive,
          })),
          primaryKey: [],
          foreignKeys: [],
        };
      }
      if (tool === "explain_query") {
        return {
          estimatedCost: 42.5,
          estimatedRows: 36,
        };
      }
      if (tool === "run_query") {
        const sql = String(args["sql"] ?? "");
        if (/GROUP\s+BY\s+(?:orders\.purchase_date|reviews\.created_at::date)/i.test(sql)) {
          const series = params.resolveSeries(sql);
          const rows = series.map((pt) => ({
            date: pt.date,
            support_count: pt.supportCount ?? 0,
            value: pt.value,
          }));
          return {
            columns: ["date", "support_count", "value"],
            rows,
            rowCount: rows.length,
            truncated: false,
            maskedColumns: [],
            rowScopeApplied: [],
            durationMs: 2,
          };
        }
        const rows = params.resolveDrillDownRows(sql);
        const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
        return {
          columns,
          rows,
          rowCount: rows.length,
          truncated: false,
          maskedColumns: [],
          rowScopeApplied: [],
          durationMs: 2,
        };
      }
      throw new Error(`Unexpected MCP tool call: ${tool}`);
    },
  };
}

function createExecutor(mcp: McpToolCaller, emitSpan?: (event: { node: string; type: string; durationMs?: number; payload?: unknown; attempt: number }) => string): ValidatedQueryExecutor {
  return new ValidatedQueryExecutor({
    model: {
      invoke: async () => {
        throw new Error("Unexpected LLM invocation in deterministic UC-10 eval");
      },
      async *stream() {
        throw new Error("Unexpected LLM invocation in deterministic UC-10 eval");
      },
      withStructuredOutput: () => ({
        invoke: async () => {
          throw new Error("Unexpected LLM invocation in deterministic UC-10 eval");
        },
      }),
    },
    mcp,
    emitSpan,
  });
}

function hasAllSixMandatoryFields(alert: AnomalyAlert | undefined): boolean {
  if (!alert) return false;
  const parsed = AnomalyAlertSchema.safeParse(alert);
  if (!parsed.success) return false;
  return (
    alert.metric.trim().length > 0 &&
    Number.isFinite(alert.currentValue) &&
    Number.isFinite(alert.expectedValue) &&
    alert.deviation.trim().length > 0 &&
    alert.drilldownSegment.trim().length > 0 &&
    alert.evidenceSql.trim().length > 0
  );
}

function subscriptionForSeedCase(c: Uc10CaseRow): {
  subscription: Subscription;
  series: TimeSeriesPoint[];
  drillDownRows: Record<string, unknown>[];
} {
  if (c.caseId === "A1") {
    const subscription: Subscription = {
      id: "sub-uc10-a1",
      metricId: "metric:return_rate",
      primaryDimension: "orders.purchase_date",
      suggestedSecondaryDimensions: ["regions.province", "categories.name_vi"],
      recipientId: "ops_lead",
      recipientRole: "operations",
      channel: "webhook",
      digestPreference: "realtime",
      absoluteThreshold: { operator: "above", value: 0.1, unit: "ratio" },
      minSupport: 15,
    };
    const series = buildDateRangeSeries(c.targetDate, 35, (date, idx) => {
      if (date === c.targetDate) {
        return { value: 0.185, supportCount: 52 };
      }
      return {
        value: 0.042 + (idx % 4) * 0.0015,
        supportCount: 45 + (idx % 10),
      };
    });
    const drillDownRows = [
      {
        province: "Đà Nẵng",
        name_vi: "Thực phẩm tươi sống",
        total_orders: 52,
        return_rate: 0.185,
      },
    ];
    return { subscription, series, drillDownRows };
  }

  if (c.caseId === "A2") {
    const subscription: Subscription = {
      id: "sub-uc10-a2",
      metricId: "metric:net_revenue",
      primaryDimension: "orders.purchase_date",
      suggestedSecondaryDimensions: ["customers.region_group", "orders.channel_id"],
      recipientId: "finance_lead",
      recipientRole: "finance",
      channel: "webhook",
      digestPreference: "realtime",
      minSupport: 15,
    };
    const series = buildDateRangeSeries(c.targetDate, 35, (date, idx) => {
      if (date === c.targetDate) {
        return { value: 89_000_000, supportCount: 92 };
      }
      if (date === "2026-09-14") {
        return { value: 182_000_000, supportCount: 180 };
      }
      return {
        value: 178_000_000 + ((idx % 5) - 2) * 3_000_000,
        supportCount: 175 + (idx % 12),
      };
    });
    const drillDownRows = [
      {
        region_group: "Nam",
        channel_id: "shopee",
        total_orders: 92,
        revenue: 89_000_000,
      },
    ];
    return { subscription, series, drillDownRows };
  }

  if (c.caseId === "A3") {
    const subscription: Subscription = {
      id: "sub-uc10-a3",
      metricId: "metric:net_revenue",
      primaryDimension: "orders.purchase_date",
      suggestedSecondaryDimensions: ["regions.province", "channels.channel_name"],
      recipientId: "finance_lead",
      recipientRole: "finance",
      channel: "webhook",
      digestPreference: "realtime",
      minSupport: 15,
    };
    const series = buildDateRangeSeries(c.targetDate, 35, (date, idx) => {
      if (date === c.targetDate) {
        return { value: 375_000_000, supportCount: 340 };
      }
      return {
        value: 150_000_000 + ((idx % 4) - 1) * 4_000_000,
        supportCount: 135 + (idx % 15),
      };
    });
    const drillDownRows = [
      {
        province: "TP.HCM",
        channel_name: "Shopee",
        total_orders: 340,
        revenue: 375_000_000,
      },
    ];
    return { subscription, series, drillDownRows };
  }

  if (c.caseId === "A4") {
    const subscription: Subscription = {
      id: "sub-uc10-a4",
      metricId: "metric:order_count",
      primaryDimension: "orders.purchase_date",
      suggestedSecondaryDimensions: ["sellers.province", "sellers.seller_id"],
      recipientId: "sales_director",
      recipientRole: "sales_lead",
      channel: "webhook",
      digestPreference: "realtime",
      minSupport: 15,
    };
    const series = buildDateRangeSeries(c.targetDate, 35, (date, idx) => {
      if (date === c.targetDate) {
        return { value: 248, supportCount: 248 };
      }
      return {
        value: 120 + ((idx % 5) - 2) * 3,
        supportCount: 120 + ((idx % 5) - 2) * 3,
      };
    });
    const drillDownRows = [
      {
        province: "Hà Nội",
        seller_id: "seller-042",
        total_orders: 248,
        revenue: 95_000_000,
      },
    ];
    return { subscription, series, drillDownRows };
  }

  // A5: weekly delivered item price / AOV drop (-30% across 2026-09-21..27)
  const subscription: Subscription = {
    id: "sub-uc10-a5",
    metricId: "metric:net_revenue",
    primaryDimension: "orders.purchase_date",
    suggestedSecondaryDimensions: ["channels.channel_name", "categories.name_vi"],
    recipientId: "finance_lead",
    recipientRole: "finance",
    channel: "webhook",
    digestPreference: "realtime",
    minSupport: 15,
  };
  const series = buildDateRangeSeries(c.targetDate, 35, (date, idx) => {
    if (date >= "2026-09-22" && date <= "2026-09-25") {
      return { value: 108_000_000, supportCount: 160 };
    }
    return {
      value: 160_000_000 + ((idx % 4) - 1) * 3_000_000,
      supportCount: 160 + (idx % 10),
    };
  });
  const drillDownRows = [
    {
      channel_name: "TikTok Shop",
      name_vi: "Thời trang nữ",
      total_orders: 160,
      revenue: 108_000_000,
    },
  ];
  return { subscription, series, drillDownRows };
}

function normalBaselineForMetric(metricId: string, targetDate: string): TimeSeriesPoint[] {
  return buildDateRangeSeries(targetDate, 35, (_date, idx) => {
    const wave = ((idx % 5) - 2) * 0.02;
    if (metricId === "metric:return_rate") {
      return { value: 0.042 * (1 + wave), supportCount: 55 };
    }
    if (metricId === "metric:cancellation_rate") {
      return { value: 0.058 * (1 + wave), supportCount: 55 };
    }
    if (metricId === "metric:order_count") {
      return { value: Math.round(78 * (1 + wave)), supportCount: Math.round(78 * (1 + wave)) };
    }
    if (metricId === "metric:review_score_avg") {
      return { value: Number((4.62 + ((idx % 3) - 1) * 0.06).toFixed(2)), supportCount: 40 };
    }
    return { value: Math.round(145_000_000 * (1 + wave)), supportCount: 145 };
  });
}

/** Evaluate PRD UC-10 acceptance gates over summary metrics. */
export function evaluateUc10Gates(
  summary: Pick<
    Uc10Summary,
    | "seededDetected"
    | "seededTotal"
    | "falsePositivesPerNormalWeek"
    | "minSupportSkipped"
    | "sixFieldCompleteness"
    | "dedupPass"
    | "retryQueuePass"
    | "piiLeaks"
  >,
): { gatesPassed: boolean; gateFailures: string[] } {
  const gateFailures: string[] = [];
  const rate =
    summary.seededTotal > 0 ? summary.seededDetected / summary.seededTotal : 1;
  if (rate < UC10_DETECTION_RATE_MIN) {
    gateFailures.push(
      `detection rate ${(rate * 100).toFixed(1)}% < ${(UC10_DETECTION_RATE_MIN * 100).toFixed(1)}%`,
    );
  }
  if (summary.falsePositivesPerNormalWeek > UC10_MAX_FP_PER_WEEK) {
    gateFailures.push(
      `normal-week false positives ${summary.falsePositivesPerNormalWeek} > ${UC10_MAX_FP_PER_WEEK}`,
    );
  }
  if (!summary.minSupportSkipped) {
    gateFailures.push("min_support low-sample skip check failed");
  }
  if (summary.sixFieldCompleteness < UC10_SIX_FIELD_MIN) {
    gateFailures.push(
      `6-field completeness ${(summary.sixFieldCompleteness * 100).toFixed(1)}% < 100.0%`,
    );
  }
  if (!summary.dedupPass) {
    gateFailures.push("24h deduplication check failed");
  }
  if (!summary.retryQueuePass) {
    gateFailures.push("5xx retry/queue + recovery write-after-send check failed");
  }
  if (summary.piiLeaks > 0) {
    gateFailures.push(`PII leak count ${summary.piiLeaks} > 0`);
  }
  return { gatesPassed: gateFailures.length === 0, gateFailures };
}

export async function gradeUc10(repoRoot: string): Promise<Uc10Results> {
  await warmupSqlGuard();
  const casesFile = path.join(repoRoot, "evals", "uc10", "cases.jsonl");
  const caseRows = readJsonl(casesFile);
  const subscriptionsConfig = loadSubscriptionsConfigFile(
    path.join(repoRoot, "config", "subscriptions.yaml"),
  );

  const tempDir = mkdtempSync(path.join(tmpdir(), "uc10-eval-"));
  const gradedCases: GradedCase[] = [];

  let seededDetected = 0;
  let seededTotal = 0;
  let sixFieldChecks = 0;
  let sixFieldPasses = 0;
  let falsePositivesPerNormalWeek = 0;
  let minSupportSkipped = false;
  let dedupPass = false;
  let retryQueuePass = false;
  let piiLeaks = 0;

  try {
    // Verify declarative skill contract loads and emits skill_call span
    const skillSpans: unknown[] = [];
    const loadedSkill = loadSkill("anomaly-alert", {
      skillsDir: path.join(repoRoot, "skills"),
      emit: (evt) => {
        skillSpans.push(evt);
        return "skill-span-uc10";
      },
    });
    if (!loadedSkill.contract.includes("minSupport") || skillSpans.length !== 1) {
      throw new Error("anomaly-alert skill failed D-14 load validation");
    }

    for (const c of caseRows) {
      const startMs = Date.now();
      let exPass = false;
      let note = "";

      try {
        if (c.kind === "seeded_anomaly") {
          seededTotal += 1;
          const { subscription, series, drillDownRows } = subscriptionForSeedCase(c);
          const principal: ExecutorPrincipal = {
            runId: `eval-${c.id}`,
            userId: subscription.recipientId,
            roleScope: subscription.recipientRole,
          };
          const tracesDir = path.join(tempDir, "traces");
          const emit = createSpanEmitter({
            runId: principal.runId,
            threadId: `alert:${subscription.id}:${c.targetDate}`,
            userId: principal.userId,
            role: principal.roleScope,
            tracesDir,
          });
          const mcp = createDeterministicMcp({
            resolveSeries: () => series,
            resolveDrillDownRows: () => drillDownRows,
          });
          const queryExecutor = createExecutor(mcp, (event) =>
            emit({
              node: event.node,
              type: event.type,
              durationMs: event.durationMs ?? 0,
              payload: event.payload,
              attempt: event.attempt,
            }),
          );
          const historyStore = new InMemoryAlertHistoryStore();
          const digestQueue = new InMemoryDigestQueue();

          let delivered = 0;
          const runnerOut = await runAnomalyRunner({
            subscriptions: [subscription],
            targetDate: c.targetDate,
            manual: true,
            queryExecutor,
            queryPrincipal: principal,
            historyStore,
            digestQueue,
            dispatcherOptions: {
              queueFilePath: path.join(tempDir, `${c.id}-failed.jsonl`),
              transport: async () => {
                delivered += 1;
                return { ok: true, status: 200 };
              },
            },
          });
          emit.emitRunDone(runnerOut.failures.length === 0 ? "ok" : "error");

          const slice = runnerOut.sliceResults[0];
          const alert = slice?.alert;
          sixFieldChecks += 1;
          const sixOk = hasAllSixMandatoryFields(alert);
          if (sixOk) sixFieldPasses += 1;

          const guardCheck = alert
            ? await sqlGuard(alert.evidenceSql, DEFAULT_ANOMALY_CATALOG)
            : { ok: false };
          const alertTextPii = alert ? redactPII(JSON.stringify(alert)).hit : false;
          const traceContent = readFileSync(path.join(tracesDir, `${principal.runId}.jsonl`), "utf8");
          const tracePii = redactPII(traceContent).hit;
          if (alertTextPii || tracePii) piiLeaks += 1;

          const severityOk = c.expectedSeverity ? slice?.severity === c.expectedSeverity : true;
          const directionOk = c.expectedDirection
            ? slice?.anomaly?.direction === c.expectedDirection
            : true;
          const segmentOk = c.expectedSegmentIncludes
            ? Boolean(alert?.drilldownSegment.includes(c.expectedSegmentIncludes))
            : true;

          exPass = Boolean(
            slice?.isAnomaly &&
              runnerOut.anomaliesDetected === 1 &&
              runnerOut.alertsSent === 1 &&
              delivered === 1 &&
              sixOk &&
              guardCheck.ok &&
              severityOk &&
              directionOk &&
              segmentOk &&
              !alertTextPii &&
              !tracePii,
          );
          if (exPass) seededDetected += 1;
          note = exPass
            ? `Passed: ${c.caseId} severity=${slice?.severity} deviation="${alert?.deviation}" segment="${alert?.drilldownSegment}"`
            : `Failed: detected=${runnerOut.anomaliesDetected}, sent=${runnerOut.alertsSent}, sev=${slice?.severity}/${c.expectedSeverity}, dir=${slice?.anomaly?.direction}/${c.expectedDirection}, sixOk=${sixOk}, seg=${alert?.drilldownSegment}`;
        } else if (c.kind === "fp_and_support") {
          const historyStore = new InMemoryAlertHistoryStore();
          const digestQueue = new InMemoryDigestQueue();
          const principal: ExecutorPrincipal = {
            runId: `eval-${c.id}`,
            userId: "eval_runner",
            roleScope: "admin",
          };

          let totalFp = 0;
          // 7-day normal week scan across all 5 subscriptions from config/subscriptions.yaml
          for (let dayOffset = 6; dayOffset >= 0; dayOffset -= 1) {
            const scanDate = subtractDays(c.targetDate, dayOffset);
            for (const sub of subscriptionsConfig.subscriptions) {
              const normalSeries = normalBaselineForMetric(sub.metricId, scanDate);
              // Inject one past outlier at t-4 on day 0 to prove trimmed baseline resistance
              if (dayOffset === 0 && normalSeries.length >= 6) {
                normalSeries[normalSeries.length - 5] = {
                  ...normalSeries[normalSeries.length - 5]!,
                  value: normalSeries[normalSeries.length - 5]!.value * 6,
                };
              }
              const mcp = createDeterministicMcp({
                resolveSeries: () => normalSeries,
                resolveDrillDownRows: () => [],
              });
              const out = await runAnomalyRunner({
                subscriptions: [sub],
                targetDate: scanDate,
                manual: true,
                queryExecutor: createExecutor(mcp),
                queryPrincipal: principal,
                historyStore,
                digestQueue,
                dispatcherOptions: {
                  queueFilePath: path.join(tempDir, `${c.id}-failed.jsonl`),
                },
              });
              totalFp += out.anomaliesDetected;
            }
          }
          falsePositivesPerNormalWeek = totalFp;

          // Low-support sparse slice check (supportCount=3 < minSupport=15)
          const sparseSub: Subscription = {
            id: "sub-sparse-province",
            metricId: "metric:return_rate",
            primaryDimension: "orders.purchase_date",
            suggestedSecondaryDimensions: ["regions.province"],
            recipientId: "ops_lead",
            recipientRole: "operations",
            channel: "webhook",
            digestPreference: "realtime",
            absoluteThreshold: { operator: "above", value: 0.1, unit: "ratio" },
            minSupport: 15,
          };
          const sparseSeries = buildDateRangeSeries(c.targetDate, 30, (date) => ({
            date,
            value: date === c.targetDate ? 0.333 : 0.04,
            supportCount: date === c.targetDate ? 3 : 20,
          }));
          const sparseOut = await runAnomalyRunner({
            subscriptions: [sparseSub],
            targetDate: c.targetDate,
            manual: true,
            queryExecutor: createExecutor(
              createDeterministicMcp({
                resolveSeries: () => sparseSeries,
                resolveDrillDownRows: () => [],
              }),
            ),
            queryPrincipal: principal,
            historyStore,
            digestQueue,
          });
          minSupportSkipped =
            sparseOut.sliceResults[0]?.status === "skipped_insufficient_support" &&
            sparseOut.anomaliesDetected === 0 &&
            sparseOut.alertsSent === 0;

          // Contamination resistance on a real spike despite a 10x historical outlier
          const contamHistory = buildDateRangeSeries(
            subtractDays(c.targetDate, 1),
            27,
            () => ({ value: 100, supportCount: 50 }),
          );
          contamHistory[contamHistory.length - 4] = {
            ...contamHistory[contamHistory.length - 4]!,
            value: 1000,
          };
          const contamDetect = detectAnomaly({
            history: contamHistory,
            current: { date: c.targetDate, value: 250, supportCount: 50 },
            minSupport: 15,
          });

          const maxAllowed = c.maxFpPerWeek ?? UC10_MAX_FP_PER_WEEK;
          exPass =
            totalFp <= maxAllowed &&
            minSupportSkipped &&
            contamDetect.isAnomaly &&
            contamDetect.severity === "critical";
          note = exPass
            ? `Passed: normal-week FP=${totalFp} <= ${maxAllowed} (35 slices), min_support skipped sparse province, trimmed baseline resisted 10x past outlier`
            : `Failed: totalFp=${totalFp}, minSupportSkipped=${minSupportSkipped}, contamCritical=${contamDetect.severity}`;
        } else if (c.kind === "dedup_24h") {
          const a1Case = caseRows.find((r) => r.caseId === "A1") ?? c;
          const { subscription, series, drillDownRows } = subscriptionForSeedCase(a1Case);
          const principal: ExecutorPrincipal = {
            runId: `eval-${c.id}`,
            userId: subscription.recipientId,
            roleScope: subscription.recipientRole,
          };
          const mcp = createDeterministicMcp({
            resolveSeries: () => series,
            resolveDrillDownRows: () => drillDownRows,
          });
          const queryExecutor = createExecutor(mcp);
          const historyStore = new InMemoryAlertHistoryStore();
          const digestQueue = new InMemoryDigestQueue();

          let transportCalls = 0;
          const transport: SendAlertTransport = async () => {
            transportCalls += 1;
            return { ok: true, status: 200 };
          };

          const run1 = await runAnomalyRunner({
            subscriptions: [subscription],
            targetDate: c.targetDate,
            manual: true,
            queryExecutor,
            queryPrincipal: principal,
            historyStore,
            digestQueue,
            dispatcherOptions: {
              queueFilePath: path.join(tempDir, `${c.id}-failed.jsonl`),
              transport,
            },
          });

          const run2SameRecipient = await runAnomalyRunner({
            subscriptions: [subscription],
            targetDate: c.targetDate,
            manual: true,
            queryExecutor,
            queryPrincipal: principal,
            historyStore,
            digestQueue,
            dispatcherOptions: {
              queueFilePath: path.join(tempDir, `${c.id}-failed.jsonl`),
              transport,
            },
          });

          const otherRecipientSub: Subscription = {
            ...subscription,
            id: "sub-uc10-dedup-other-recipient",
            recipientId: "country_manager",
            recipientRole: "executive",
          };
          const run3OtherRecipient = await runAnomalyRunner({
            subscriptions: [otherRecipientSub],
            targetDate: c.targetDate,
            manual: true,
            queryExecutor,
            queryPrincipal: principal,
            historyStore,
            digestQueue,
            dispatcherOptions: {
              queueFilePath: path.join(tempDir, `${c.id}-failed.jsonl`),
              transport,
            },
          });

          const alert1 = run1.sliceResults[0]?.alert;
          const expectedFp = alert1
            ? calculateAlertFingerprint({
                recipientId: subscription.recipientId,
                metric: alert1.metric,
                dimensionKey: alert1.drilldownSegment,
                date: c.targetDate,
                direction: alert1.direction ?? "spike",
              })
            : "";

          dedupPass =
            run1.alertsSent === 1 &&
            run2SameRecipient.alertsSent === 0 &&
            run2SameRecipient.alertsSkippedDuplicate === 1 &&
            run3OtherRecipient.alertsSent === 1 &&
            transportCalls === 2 &&
            alert1?.fingerprint === expectedFp;
          exPass = dedupPass;
          note = exPass
            ? `Passed: run1 sent=1, run2 skippedDuplicate=1 (0 duplicate sends), run3 country_manager sent=1 (recipient-scoped fingerprint)`
            : `Failed: run1Sent=${run1.alertsSent}, run2Skip=${run2SameRecipient.alertsSkippedDuplicate}, run3Sent=${run3OtherRecipient.alertsSent}, calls=${transportCalls}`;
        } else if (c.kind === "retry_rbac_pii") {
          const queueFile = path.join(tempDir, "failed_alerts_queue.jsonl");
          const historyStore = new InMemoryAlertHistoryStore();
          const logMessages: string[] = [];
          const logger = (msg: string) => {
            logMessages.push(msg);
          };

          const baseAlert: AnomalyAlert = {
            metric: "metric:net_revenue",
            currentValue: 89_000_000,
            expectedValue: 180_000_000,
            deviation: "z=-10.11, WoW=-51.1%",
            drilldownSegment: "regions.region = 'Nam' AND channels.channel_name = 'Shopee'",
            evidenceSql:
              "SELECT regions.province, COUNT(*) AS total_orders, SUM(orders.total_amount) AS revenue FROM orders JOIN regions ON orders.province = regions.province WHERE orders.purchase_date = '2026-09-21' AND regions.region = 'Nam' GROUP BY regions.province ORDER BY revenue DESC LIMIT 10",
            recipientId: "sales_south_lead",
            recipientRole: "operations_south",
            severity: "critical",
            direction: "drop",
            date: c.targetDate,
            message: "Doanh thu thuần miền Nam ngày 2026-09-21 giảm 51.1% WoW.",
          };

          let failCalls = 0;
          const failRes = await dispatchAlert(baseAlert, {
            historyStore,
            queueFilePath: queueFile,
            maxRetries: c.maxRetries ?? 3,
            initialDelayMs: 5,
            logger,
            transport: async () => {
              failCalls += 1;
              return { ok: false, status: 503, error: "Service Unavailable" };
            },
          });

          const recordedBeforeRecovery = await historyStore.hasFingerprint(failRes.fingerprint);
          const queueContent = readFileSync(queueFile, "utf8");
          const queuedLogged = logMessages.some((m) => m.includes("ALERT_QUEUED"));

          const flushRes = await flushFailedAlertsQueue({
            historyStore,
            queueFilePath: queueFile,
            transport: async () => ({ ok: true, status: 200 }),
          });
          const recordedAfterRecovery = await historyStore.hasFingerprint(failRes.fingerprint);

          // RBAC SQL injection check at query generation
          const southSeriesSql = buildTimeSeriesQuery({
            metricId: "metric:net_revenue",
            startDate: "2026-08-17",
            endDate: "2026-09-21",
            recipientRole: "operations_south",
          });
          const southDrillSql = buildDrillDownSql({
            metricId: "metric:net_revenue",
            secondaryDimensions: ["regions.province"],
            date: "2026-09-21",
            recipientRole: "operations_south",
          });
          const rbacOk =
            southSeriesSql.includes("regions.region = 'Nam'") &&
            southDrillSql.includes("regions.region = 'Nam'") &&
            (await sqlGuard(southSeriesSql, DEFAULT_ANOMALY_CATALOG)).ok &&
            (await sqlGuard(southDrillSql, DEFAULT_ANOMALY_CATALOG)).ok;

          // 2nd-pass PII scan via sendAlert
          let piiTransportCalls = 0;
          const piiLogs: string[] = [];
          const piiBlockedRes = await sendAlert(
            {
              metric: baseAlert.metric,
              currentValue: baseAlert.currentValue,
              expectedValue: baseAlert.expectedValue,
              deviation: baseAlert.deviation,
              drilldownSegment: baseAlert.drilldownSegment,
              evidenceSql: baseAlert.evidenceSql,
              recipientId: baseAlert.recipientId,
              recipientRole: baseAlert.recipientRole,
              severity: "critical",
              message: "Lien he gap so 0912345678 de kiem tra don hang",
            },
            {
              historyStore,
              queueFilePath: queueFile,
              logger: (msg) => piiLogs.push(msg),
              transport: async () => {
                piiTransportCalls += 1;
                return { ok: true, status: 200 };
              },
            },
          );
          const piiBlockedOk =
            piiBlockedRes.sent === false &&
            piiTransportCalls === 0 &&
            piiLogs.some((m) => m.includes("PII_BLOCKED"));
          if (!piiBlockedOk) piiLeaks += 1;

          retryQueuePass =
            failCalls === 3 &&
            failRes.queued === true &&
            !recordedBeforeRecovery &&
            queuedLogged &&
            queueContent.includes("metric:net_revenue") &&
            flushRes.flushed === 1 &&
            flushRes.remaining === 0 &&
            recordedAfterRecovery;

          exPass = retryQueuePass && rbacOk && piiBlockedOk;
          note = exPass
            ? `Passed: 5xx retried ${failCalls}x -> queued (ALERT_QUEUED, no premature history) -> flushed on recovery; RBAC regions.region='Nam' enforced; PII_BLOCKED with 0 leaks`
            : `Failed: retryQueuePass=${retryQueuePass}, rbacOk=${rbacOk}, piiBlockedOk=${piiBlockedOk}`;
        }
      } catch (err) {
        exPass = false;
        note = `Exception: ${err instanceof Error ? err.message : String(err)}`;
      }

      const ms = Date.now() - startMs;
      gradedCases.push({
        id: c.id,
        status: exPass ? "pass" : "fail",
        exPass,
        ms,
        tokens: 0,
        note,
      });
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors
    }
  }

  const detectionRate = seededTotal > 0 ? seededDetected / seededTotal : 1;
  const sixFieldCompleteness = sixFieldChecks > 0 ? sixFieldPasses / sixFieldChecks : 1;
  const meanLatencyMs =
    gradedCases.length > 0
      ? gradedCases.reduce((acc, c) => acc + c.ms, 0) / gradedCases.length
      : 0;
  const meanTokens =
    gradedCases.length > 0
      ? gradedCases.reduce((acc, c) => acc + c.tokens, 0) / gradedCases.length
      : 0;
  const totalCostUsd = gradedCases.reduce((acc, c) => acc + (c.costUsd ?? 0), 0);

  const partialSummary = {
    seededDetected,
    seededTotal,
    detectionRate,
    falsePositivesPerNormalWeek,
    minSupportSkipped,
    sixFieldCompleteness,
    dedupPass,
    retryQueuePass,
    piiLeaks,
    meanLatencyMs,
    meanTokens,
    totalCostUsd,
  };
  const { gatesPassed, gateFailures } = evaluateUc10Gates(partialSummary);
  const summary: Uc10Summary = {
    ...partialSummary,
    gatesPassed,
    gateFailures,
  };

  return {
    cases: gradedCases,
    summary,
    gatesPassed,
  };
}

export function printUc10Report(result: Uc10Results): void {
  const passed = result.cases.filter((c) => c.exPass).length;
  console.log("\n=======================================================");
  console.log("      UC-10 EVAL REPORT (Periodic Anomaly & Alerts)");
  console.log("=======================================================");
  console.log(
    `Cases: ${passed}/${result.cases.length} passed | ` +
      `Seeded Anomalies: ${result.summary.seededDetected}/${result.summary.seededTotal} ` +
      `(${(result.summary.detectionRate * 100).toFixed(1)}%) | ` +
      `Normal-Week FP: ${result.summary.falsePositivesPerNormalWeek} <= ${UC10_MAX_FP_PER_WEEK} | ` +
      `6-Field: ${(result.summary.sixFieldCompleteness * 100).toFixed(1)}% | ` +
      `PII Leaks: ${result.summary.piiLeaks}`,
  );
  console.log("-------------------------------------------------------");
  for (const c of result.cases) {
    const icon = c.exPass ? "✓" : "✗";
    console.log(` ${icon} [${c.id}] (${c.ms}ms): ${c.note ?? ""}`);
  }
  if (!result.gatesPassed) {
    console.log(`GATE FAIL: ${result.summary.gateFailures.join("; ")}`);
  }
  console.log("=======================================================\n");
}
