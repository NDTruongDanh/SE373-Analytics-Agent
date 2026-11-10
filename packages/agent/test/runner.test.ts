import { describe, expect, it } from "vitest";
import type { AnomalyAlert, Subscription } from "@shared/contracts";
import {
  buildTimeSeriesQuery,
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
});
