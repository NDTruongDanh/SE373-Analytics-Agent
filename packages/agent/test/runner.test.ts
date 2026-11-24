import { describe, expect, it } from "vitest";
import type { AnomalyAlert, Subscription } from "@shared/contracts";
import {
  buildTimeSeriesQuery,
  calculateEmpiricalPValue,
  calculateFdrSignificance,
  runAnomalyRunner,
  scheduleAnomalyCron,
} from "../src/alerts/runner.js";
import {
  InMemoryAlertHistoryStore,
  InMemoryDigestQueue,
} from "../src/alerts/dispatcher.js";
import type { TimeSeriesPoint } from "../src/alerts/anomalyDetector.js";
import type { AlertQueryExecutor } from "../src/alerts/query.js";
import type { ExecutorPrincipal } from "../src/queryExecutor/executor.js";

const QUERY_PRINCIPAL: ExecutorPrincipal = {
  runId: "runner-test-run",
  userId: "ops_lead",
  roleScope: "operations",
};

function fakeQueryExecutor(
  rows: Record<string, unknown>[],
): AlertQueryExecutor {
  return {
    run: async (input) => {
      if (!input.initialSql) throw new Error("expected deterministic SQL");
      return {
        status: "ok",
        sql: input.initialSql,
        tablesUsed: input.candidateTables,
        columns: [],
        rows,
        maskedColumns: [],
        attempts: 1,
      };
    },
  };
}

describe("Anomaly Detection & Governed Alert Runner (UC-10, F10.1–F10.5)", () => {
  const subReturnRate: Subscription = {
    id: "sub-return-rate",
    metricId: "metric:return_rate",
    primaryDimension: "orders.purchase_date",
    suggestedSecondaryDimensions: ["regions.province", "categories.name_vi"],
    recipientId: "ops_lead",
    recipientRole: "operations",
    channel: "webhook",
    digestPreference: "digest",
    minSupport: 15,
  };

  const subRevenue: Subscription = {
    id: "sub-net-revenue",
    metricId: "metric:net_revenue",
    primaryDimension: "orders.purchase_date",
    suggestedSecondaryDimensions: ["regions.region", "channels.channel_name"],
    recipientId: "finance_lead",
    recipientRole: "finance",
    channel: "webhook",
    digestPreference: "digest",
    minSupport: 15,
  };

  it("handles a normal day with 0 anomalies and 0 alerts sent", async () => {
    // 28 days baseline with normal variance around 0.04
    const normalSeries: TimeSeriesPoint[] = Array.from({ length: 29 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      value: 0.04 + (i % 3) * 0.002,
      supportCount: 40,
    }));

    const result = await runAnomalyRunner({
      subscriptions: [subReturnRate],
      targetDate: "2026-08-29",
      manual: true,
      queryExecutor: fakeQueryExecutor([]),
      queryPrincipal: QUERY_PRINCIPAL,
      historyStore: new InMemoryAlertHistoryStore(),
      digestQueue: new InMemoryDigestQueue(),
      mockSeriesProvider: () => normalSeries,
    });

    expect(result.totalSubscriptions).toBe(1);
    expect(result.anomaliesDetected).toBe(0);
    expect(result.alertsSent).toBe(0);
    expect(result.failures).toHaveLength(0);
    expect(result.sliceResults[0].isAnomaly).toBe(false);
    expect(result.sliceResults[0].status).toBe("ok");
  });

  it("detects an anomaly, triggers drill-down, and dispatches critical alert", async () => {
    // 28 days baseline ~0.04, day 29 spikes to 0.185 (4x spike)
    const spikeSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      value: 0.04,
      supportCount: 50,
    }));
    spikeSeries.push({
      date: "2026-08-29",
      value: 0.185,
      supportCount: 50,
    });

    const queryExecutor = fakeQueryExecutor([
      {
        province: "Đà Nẵng",
        name_vi: "Thực phẩm tươi sống",
        total_orders: 50,
        return_rate: 0.185,
      },
    ]);

    const historyStore = new InMemoryAlertHistoryStore();

    const result = await runAnomalyRunner({
      subscriptions: [subReturnRate],
      targetDate: "2026-08-29",
      manual: true,
      historyStore,
      queryExecutor,
      queryPrincipal: QUERY_PRINCIPAL,
      digestQueue: new InMemoryDigestQueue(),
      mockSeriesProvider: () => spikeSeries,
      dispatcherOptions: {
        transport: async () => ({ ok: true, status: 200 }),
      },
    });

    expect(result.anomaliesDetected).toBe(1);
    expect(result.alertsSent).toBe(1);
    expect(result.sliceResults[0].isAnomaly).toBe(true);
    expect(result.sliceResults[0].severity).toBe("critical");
    expect(result.sliceResults[0].drillDown).toBeDefined();
    expect(result.sliceResults[0].drillDown?.drilldownSegment).toContain("Đà Nẵng");
    expect(result.sliceResults[0].alert?.metric).toBe("metric:return_rate");

    // Second run on the same day: deduplication skips alert
    const reRunResult = await runAnomalyRunner({
      subscriptions: [subReturnRate],
      targetDate: "2026-08-29",
      manual: true,
      historyStore,
      queryExecutor,
      queryPrincipal: QUERY_PRINCIPAL,
      digestQueue: new InMemoryDigestQueue(),
      mockSeriesProvider: () => spikeSeries,
    });

    expect(reRunResult.anomaliesDetected).toBe(1);
    expect(reRunResult.alertsSent).toBe(0);
    expect(reRunResult.alertsSkippedDuplicate).toBe(1);
  });

  it("isolates errors per subscription (checkpointing / fault-tolerance: 1 failure does not crash others)", async () => {
    const normalSeries: TimeSeriesPoint[] = Array.from({ length: 29 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      value: 100000000,
      supportCount: 100,
    }));

    const mockSeriesProvider = (sub: Subscription) => {
      if (sub.id === "sub-return-rate") {
        throw new Error("DB connection timeout on table orders");
      }
      return normalSeries;
    };

    const result = await runAnomalyRunner({
      subscriptions: [subReturnRate, subRevenue],
      targetDate: "2026-08-29",
      manual: true,
      queryExecutor: fakeQueryExecutor([]),
      queryPrincipal: QUERY_PRINCIPAL,
      historyStore: new InMemoryAlertHistoryStore(),
      digestQueue: new InMemoryDigestQueue(),
      mockSeriesProvider,
    });

    expect(result.totalSubscriptions).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].subscriptionId).toBe("sub-return-rate");
    expect(result.failures[0].error).toContain("DB connection timeout");

    // Second subscription (subRevenue) was evaluated successfully!
    expect(result.sliceResults).toHaveLength(2);
    expect(result.sliceResults[0].status).toBe("failed");
    expect(result.sliceResults[1].status).toBe("ok");
    expect(result.sliceResults[1].subscriptionId).toBe("sub-net-revenue");
  });

  it("schedules and stops cron runner cleanly", () => {
    const cron = scheduleAnomalyCron({
      subscriptions: [subReturnRate],
      hour: 7,
      minute: 0,
      queryExecutor: fakeQueryExecutor([]),
      queryPrincipal: QUERY_PRINCIPAL,
      historyStore: new InMemoryAlertHistoryStore(),
      digestQueue: new InMemoryDigestQueue(),
      mockSeriesProvider: () => [],
    });

    expect(typeof cron.stop).toBe("function");
    cron.stop();
  });

  it("flushes persisted warning alerts through send_alert before clearing the queue", async () => {
    const alert: AnomalyAlert = {
      metric: "metric:return_rate",
      currentValue: 0.1,
      expectedValue: 0.04,
      deviation: "z=3.0",
      drilldownSegment: "regions.province = 'Đà Nẵng'",
      evidenceSql: "SELECT 1",
      recipientId: "ops_lead",
      severity: "warning",
      direction: "spike",
      date: "2026-08-29",
    };
    const digestQueue = new InMemoryDigestQueue();
    digestQueue.enqueue(alert);
    const historyStore = new InMemoryAlertHistoryStore();
    let deliveryCount = 0;

    const result = await runAnomalyRunner({
      subscriptions: [],
      targetDate: "2026-08-29",
      manual: true,
      flushDigest: true,
      queryExecutor: fakeQueryExecutor([]),
      queryPrincipal: QUERY_PRINCIPAL,
      historyStore,
      digestQueue,
      dispatcherOptions: {
        transport: async () => {
          deliveryCount++;
          return { ok: true, status: 200 };
        },
      },
    });

    expect(result.flushedDigestCount).toBe(1);
    expect(result.alertsSent).toBe(1);
    expect(deliveryCount).toBe(1);
    expect(digestQueue.size()).toBe(0);
    expect(historyStore.getAll()).toHaveLength(1);
    expect(historyStore.getAll()[0]?.recipientId).toBe(alert.recipientId);
  });

  it("validates date inputs and retains regional scoping for review series", () => {
    expect(() =>
      buildTimeSeriesQuery({
        metricId: "metric:return_rate",
        startDate: "2026-02-31",
        endDate: "2026-03-01",
      }),
    ).toThrow();

    const sql = buildTimeSeriesQuery({
      metricId: "metric:review_score_avg",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      recipientRole: "operations_south",
    });
    expect(sql).toContain("JOIN regions");
    expect(sql).toContain("regions.region = 'Nam'");
  });

  // =========================================================================
  // Hardened 3-Phase Architecture & Statistical Testing (Issue #134)
  // =========================================================================
  describe("3-Phase Anomaly Pipeline & FDR Controls (Issue #134)", () => {
    it("computes empirical p-value against residual pool accurately", () => {
      // Pool of 999 values uniformly between -2 and +2
      const pool = Array.from({ length: 999 }, (_, i) => -2 + (4 * i) / 998);

      // z = 3.0 is outside the pool -> p = (1 + 0) / (999 + 1) = 0.001
      const pExtreme = calculateEmpiricalPValue(3.0, pool);
      expect(pExtreme).toBeCloseTo(0.001, 3);

      // z = 0.0 -> all 999 values satisfy |b| >= 0 -> p = (1 + 999) / 1000 = 1.0
      const pCenter = calculateEmpiricalPValue(0.0, pool);
      expect(pCenter).toBe(1.0);
    });

    it("controls False Discovery Rate with Benjamini-Hochberg (BH) procedure", () => {
      // 4 hypotheses with p-values
      // Sorted: 0.005, 0.010, 0.040, 0.200
      // Thresholds for m=4, q=0.05:
      // k=1: 1/4 * 0.05 = 0.0125 -> 0.005 <= 0.0125 (pass)
      // k=2: 2/4 * 0.05 = 0.0250 -> 0.010 <= 0.0250 (pass)
      // k=3: 3/4 * 0.05 = 0.0375 -> 0.040 > 0.0375 (fail)
      // k=4: 4/4 * 0.05 = 0.0500 -> 0.200 > 0.0500 (fail)
      const pValues = [0.040, 0.005, 0.200, 0.010];
      const rejections = calculateFdrSignificance({ pValues, q: 0.05 });

      expect(rejections).toEqual([false, true, false, true]);
    });

    it("runs in Calibrated Mode when poolingResiduals B >= B_required", async () => {
      // Pool of 600 residuals (>= 500)
      const pool = Array.from({ length: 600 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));

      // Generate spike series for subReturnRate
      const spikeSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 0.04,
        supportCount: 50,
      }));
      spikeSeries.push({
        date: "2026-08-29",
        value: 0.20, // extreme spike
        supportCount: 50,
      });

      const result = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([
          { province: "Đà Nẵng", name_vi: "Thực phẩm", total_orders: 50, return_rate: 0.20 },
        ]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => spikeSeries,
        poolingResiduals: pool,
      });

      expect(result.sliceResults).toHaveLength(1);
      const slice = result.sliceResults[0]!;
      expect(slice.isUncalibrated).toBe(false);
      expect(slice.isFdrSignificant).toBe(true);
      expect(slice.isAnomaly).toBe(true);
      expect(slice.severity).toBe("critical");
      expect(slice.pValue).toBeDefined();
    });

    it("runs in Heuristic Fallback Mode when poolingResiduals B < B_required", async () => {
      // Small or missing pool (< 500)
      const spikeSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 0.04,
        supportCount: 50,
      }));
      spikeSeries.push({
        date: "2026-08-29",
        value: 0.20,
        supportCount: 50,
      });

      const result = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([
          { province: "Đà Nẵng", name_vi: "Thực phẩm", total_orders: 50, return_rate: 0.20 },
        ]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => spikeSeries,
        poolingResiduals: [0.1, 0.2], // Only 2 residuals < 500
      });

      expect(result.sliceResults).toHaveLength(1);
      const slice = result.sliceResults[0]!;
      expect(slice.isUncalibrated).toBe(true);
      expect(slice.isHeuristicAlert).toBe(true);
      expect(slice.isAnomaly).toBe(true);
      expect(slice.severity).toBe("critical");
    });

    it("enforces holiday downgrade on public holidays while preserving Mega Sale severity", async () => {
      // 1. Moderate deviation on 2026-09-02 (Quốc khánh - public_holiday):
      // Baseline around 100 with variance ~8 (std ~8), value 125 gives z ~ 3.1 in [2.0, 3.5), WoW = 25% in [20%, 50%)
      const holidaySeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 100 + (i % 2 === 0 ? 8 : -8),
        supportCount: 50,
      }));
      holidaySeries[25]!.value = 100;
      holidaySeries.push({
        date: "2026-09-02",
        value: 125, // z ~ 3.1 < 3.5, WoW = 25% < 50% -> moderate warning
        supportCount: 50,
      });

      const resHoliday = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-09-02",
        manual: true,
        queryExecutor: fakeQueryExecutor([]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => holidaySeries,
      });

      expect(resHoliday.sliceResults[0]?.severity).toBe("info"); // Downgraded to info

      // 2. Moderate deviation on 2026-09-09 (Mega sale 9.9)
      // History ending 2026-09-08 contains t-7 (2026-09-02)
      const saleSeries: TimeSeriesPoint[] = [];
      const startDate = new Date("2026-08-12T00:00:00.000Z");
      for (let i = 0; i < 28; i++) {
        const d = new Date(startDate);
        d.setUTCDate(d.getUTCDate() + i);
        saleSeries.push({
          date: d.toISOString().slice(0, 10),
          value: 100 + (i % 2 === 0 ? 8 : -8),
          supportCount: 50,
        });
      }
      const weekAgoIdx = saleSeries.findIndex((p) => p.date === "2026-09-02");
      if (weekAgoIdx >= 0) saleSeries[weekAgoIdx]!.value = 100;
      saleSeries.push({
        date: "2026-09-09",
        value: 125, // z ~ 3.1 < 3.5, WoW = 25% >= 20% -> moderate warning
        supportCount: 50,
      });

      const resSale = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-09-09",
        manual: true,
        queryExecutor: fakeQueryExecutor([]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => saleSeries,
      });

      expect(resSale.sliceResults[0]?.severity).toBe("warning"); // NOT downgraded!
    });

    it("bypasses BH FDR for absolute threshold breach and assigns info severity", async () => {
      // Large residual pool where all hypotheses with z < 2.0 will fail FDR (empirical p = 1.0)
      const pool = Array.from({ length: 600 }, (_, i) => (i % 2 === 0 ? 2.5 : -2.5));

      // Series where value gently rises from 0.08 to 0.11 (z ~ 1.0 < 2.0 -> absolute-only breach)
      const gentleRiseSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 0.08 + (i % 2 === 0 ? 0.03 : -0.03),
        supportCount: 50,
      }));
      gentleRiseSeries.push({
        date: "2026-08-29",
        value: 0.11, // breaches absolute threshold 0.10, but z is small
        supportCount: 30, // >= minSupport (15)
      });

      const subWithAbsolute: Subscription = {
        ...subReturnRate,
        id: "sub-abs-breach",
        absoluteThreshold: { operator: "above", value: 0.10 },
      };

      const result = await runAnomalyRunner({
        subscriptions: [subWithAbsolute],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([
          {
            province: "Đà Nẵng",
            name_vi: "Thực phẩm tươi sống",
            total_orders: 30,
            return_rate: 0.11,
          },
        ]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => gentleRiseSeries,
        poolingResiduals: pool,
      });

      expect(result.sliceResults).toHaveLength(1);
      const slice = result.sliceResults[0]!;
      expect(slice.isFdrSignificant).toBe(false); // Failed FDR!
      expect(slice.isAnomaly).toBe(true); // Bypassed FDR and admitted into Phase 3!
      expect(slice.severity).toBe("info"); // Absolute breach is assigned info!
      expect(result.alertsQueued).toBe(1);
    });

    it("deduplicates candidate subscriptions with same (metricId, recipientRole, slice) into single hypothesis", async () => {
      const subSlack: Subscription = {
        id: "sub-slack",
        metricId: "metric:return_rate",
        primaryDimension: "orders.purchase_date",
        recipientId: "ops_slack",
        recipientRole: "operations",
        channel: "slack",
        frequency: "daily",
        minSupport: 15,
      };
      const subEmail: Subscription = {
        id: "sub-email",
        metricId: "metric:return_rate",
        primaryDimension: "orders.purchase_date",
        recipientId: "ops_email",
        recipientRole: "operations",
        channel: "email",
        frequency: "daily",
        minSupport: 15,
      };

      const pool = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? 1.0 : -1.0));
      const spikeSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 0.04,
        supportCount: 50,
      }));
      spikeSeries.push({ date: "2026-08-29", value: 0.20, supportCount: 50 });

      const res = await runAnomalyRunner({
        subscriptions: [subSlack, subEmail],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => spikeSeries,
        poolingResiduals: pool,
      });

      expect(res.sliceResults).toHaveLength(2);
      expect(res.sliceResults[0]!.isFdrSignificant).toBe(true);
      expect(res.sliceResults[1]!.isFdrSignificant).toBe(true);
      // Both evaluated under same m=1 hypothesis
      expect(res.sliceResults[0]!.pValue).toBe(res.sliceResults[1]!.pValue);
    });

    it("enforces supportCount >= minSupport in heuristic fallback mode", async () => {
      // Series with spike (z ~ 3.5, WoW ~ 100%) but supportCount = 5 < minSupport (15)
      const lowSupportSpike: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 100 + (i % 2 === 0 ? 8 : -8),
        supportCount: 50,
      }));
      lowSupportSpike[25]!.value = 100;
      lowSupportSpike.push({
        date: "2026-08-29",
        value: 135,
        supportCount: 5, // < minSupport (15)
      });

      const res = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => lowSupportSpike,
      });

      // Skipped in Phase 1 due to insufficient support
      expect(res.sliceResults[0]!.status).toBe("skipped_insufficient_support");
      expect(res.sliceResults[0]!.isAnomaly).toBe(false);
      expect(res.anomaliesDetected).toBe(0);
    });

    it("disallows heuristic alert when wowPercent is null (requires both z and WoW)", async () => {
      // Series where t-7 point value is 0 (or missing), so wowPercent is null, but |z| >= 3.0
      const missingWowSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 100 + (i % 2 === 0 ? 8 : -8),
        supportCount: 50,
      }));
      // At index 21 (2026-08-22, t-7 for 2026-08-29): set value to 0, causing calculateWoW to return null
      missingWowSeries[21]!.value = 0;
      missingWowSeries.push({
        date: "2026-08-29",
        value: 135, // |z| >= 3.0, supportCount = 50 >= 15
        supportCount: 50,
      });

      const res = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => missingWowSeries,
      });

      // Since wowPercent is null, heuristic alert is NOT activated and candidate is not admitted
      expect(res.sliceResults[0]!.isHeuristicAlert).toBe(false);
      expect(res.sliceResults[0]!.isAnomaly).toBe(false);
      expect(res.anomaliesDetected).toBe(0);
    });

    it("wires model from AnomalyRunnerOptions into drill-down analysis", async () => {
      let modelWasInvoked = false;
      const fakeModel = {
        bindTools: () => ({
          invoke: async () => {
            modelWasInvoked = true;
            return { content: "Phân tích AI: Tỉ lệ hoàn đơn tăng vọt tại Đà Nẵng." };
          },
        }),
        invoke: async () => {
          modelWasInvoked = true;
          return { content: "Phân tích AI: Tỉ lệ hoàn đơn tăng vọt tại Đà Nẵng." };
        },
      };

      const spikeSeries: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: 0.04,
        supportCount: 50,
      }));
      spikeSeries.push({
        date: "2026-08-29",
        value: 0.25,
        supportCount: 50,
      });

      const result = await runAnomalyRunner({
        subscriptions: [subReturnRate],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([
          { province: "Đà Nẵng", name_vi: "Thực phẩm", total_orders: 50, return_rate: 0.25 },
        ]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => spikeSeries,
        model: fakeModel,
      });

      expect(modelWasInvoked).toBe(true);
      expect(result.sliceResults[0]?.drillDown?.explanation).toContain("Phân tích AI");
    });

    it("does not emit warning when absZ >= 2.0 but absWoW < wowThreshold", async () => {
      // Baseline around 100 with sigma ~ 10 -> value 122 gives z ~ 2.2, but WoW is only 10% < 20%
      const history: TimeSeriesPoint[] = Array.from({ length: 28 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        value: i % 2 === 0 ? 95 : 105,
        supportCount: 50,
      }));
      // Week ago (index 21, 2026-08-22): value was 110
      history[21] = { date: "2026-08-22", value: 110, supportCount: 50 };
      // Current: 122 -> WoW = (122 - 110) / 110 = 10.9% < wowThreshold (20%)
      history.push({
        date: "2026-08-29",
        value: 122,
        supportCount: 50,
      });

      const subWithStrictWoW: Subscription = {
        ...subReturnRate,
        wowThreshold: 20,
      };

      const result = await runAnomalyRunner({
        subscriptions: [subWithStrictWoW],
        targetDate: "2026-08-29",
        manual: true,
        queryExecutor: fakeQueryExecutor([]),
        queryPrincipal: QUERY_PRINCIPAL,
        historyStore: new InMemoryAlertHistoryStore(),
        digestQueue: new InMemoryDigestQueue(),
        mockSeriesProvider: () => history,
      });

      expect(result.sliceResults[0]?.isAnomaly).toBe(false);
      expect(result.sliceResults[0]?.severity).toBe("none");
    });
  });
});
