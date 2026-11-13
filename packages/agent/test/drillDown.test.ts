import { describe, expect, it } from "vitest";
import { sqlGuard } from "@shared/access-policy";
import { AnomalyAlertSchema, type Subscription } from "@shared/contracts";
import { DEFAULT_ANOMALY_CATALOG } from "../src/alerts/catalog.js";
import {
  buildDrillDownSql,
  formatDrilldownSegment,
  runDrillDownAnalysis,
} from "../src/alerts/drillDown.js";
import type { AnomalyDetectorOutput } from "../src/alerts/anomalyDetector.js";
import type { AlertQueryExecutor } from "../src/alerts/query.js";
import type { ExecutorPrincipal } from "../src/queryExecutor/executor.js";

const QUERY_PRINCIPAL: ExecutorPrincipal = {
  runId: "alert-test-run",
  userId: "ops_lead",
  roleScope: "operations_south",
};

function fakeQueryExecutor(
  rows: Record<string, unknown>[],
  onRun?: (input: Parameters<AlertQueryExecutor["run"]>[0]) => void,
): AlertQueryExecutor {
  return {
    run: async (input) => {
      if (!input.initialSql) throw new Error("expected deterministic SQL");
      onRun?.(input);
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

describe("1–2 Dim Drill-Down Analyzer (UC-10 §5, F10.3)", () => {
  const sampleSubscription: Subscription = {
    id: "return-rate-daily",
    metricId: "metric:return_rate",
    primaryDimension: "orders.purchase_date",
    suggestedSecondaryDimensions: ["regions.province", "categories.name_vi"],
    recipientId: "ops_lead",
    recipientRole: "operations_south",
    channel: "webhook",
    digestPreference: "digest",
    minSupport: 15,
  };

  const sampleAnomaly: AnomalyDetectorOutput = {
    isAnomaly: true,
    severity: "critical",
    direction: "spike",
    currentValue: 0.185,
    expectedValue: 0.042,
    zScore: 17.8,
    wowPercent: 340.0,
    deviationSummary: "z=+17.80, WoW=+340.0%",
    status: "ok",
  };

  it("builds SQL breakdown selecting 1–2 secondary dimensions and injecting RBAC", async () => {
    const sql = buildDrillDownSql({
      metricId: "metric:return_rate",
      secondaryDimensions: ["regions.province", "categories.name_vi"],
      date: "2026-09-12",
      recipientRole: "operations_south",
    });

    expect(sql).toContain("regions.province");
    expect(sql).toContain("categories.name_vi");
    expect(sql).toContain("regions.region = 'Nam'"); // RBAC where condition
    expect(sql).toContain("LIMIT 10");

    // Must be valid SQL per sqlGuard
    const guard = await sqlGuard(sql, DEFAULT_ANOMALY_CATALOG);
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.tables).toContain("orders");
      expect(guard.tables).toContain("categories");
      expect(guard.tables).toContain("regions");
    }
  });

  it("formats drilldown segment string from row", () => {
    const row = {
      province: "Đà Nẵng",
      name_vi: "Thực phẩm tươi sống",
      total_orders: 45,
      return_rate: 0.185,
    };
    const segment = formatDrilldownSegment(row, [
      "regions.province",
      "categories.name_vi",
    ]);
    expect(segment).toBe(
      "regions.province = 'Đà Nẵng' AND categories.name_vi = 'Thực phẩm tươi sống'",
    );
  });

  it("rejects malformed dates and dimensions before building SQL", () => {
    expect(() =>
      buildDrillDownSql({
        metricId: "metric:return_rate",
        secondaryDimensions: ["regions.province; DROP TABLE orders"],
        date: "2026-09-12",
      }),
    ).toThrow(/Unsupported drill-down dimension/);

    expect(() =>
      buildDrillDownSql({
        metricId: "metric:return_rate",
        secondaryDimensions: ["regions.province"],
        date: "2026-02-31",
      }),
    ).toThrow();

    expect(() =>
      buildDrillDownSql({
        metricId: "metric:return_rate",
        secondaryDimensions: ["customers.phone"],
        date: "2026-09-12",
      }),
    ).toThrow(/Unsupported drill-down dimension/);
  });

  it("executes drill-down and composes strict 6-field alert", async () => {
    let candidateTables: string[] = [];
    const queryExecutor = fakeQueryExecutor(
      [
        {
          province: "Đà Nẵng",
          name_vi: "Thực phẩm tươi sống",
          total_orders: 50,
          return_rate: 0.185,
        },
      ],
      (input) => {
        candidateTables = input.candidateTables;
      },
    );

    const result = await runDrillDownAnalysis({
      subscription: sampleSubscription,
      dimensionKey: "2026-09-12",
      date: "2026-09-12",
      anomaly: sampleAnomaly,
      queryExecutor,
      queryPrincipal: QUERY_PRINCIPAL,
    });

    expect(result.selectedDimensions).toEqual([
      "regions.province",
      "categories.name_vi",
    ]);
    expect(candidateTables).toEqual(
      expect.arrayContaining([
        "orders",
        "regions",
        "order_items",
        "products",
        "categories",
      ]),
    );
    expect(result.drilldownSegment).toContain("regions.province = 'Đà Nẵng'");
    expect(result.drilldownSegment).toContain("categories.name_vi = 'Thực phẩm tươi sống'");

    const alert = result.alert;
    // Verify 6 mandatory PRD UC-10 fields
    expect(alert.metric).toBe("metric:return_rate");
    expect(alert.currentValue).toBe(0.185);
    expect(alert.expectedValue).toBe(0.042);
    expect(alert.deviation).toBe("z=+17.80, WoW=+340.0%");
    expect(alert.drilldownSegment).toBe(result.drilldownSegment);
    expect(alert.evidenceSql).toBe(result.evidenceSql);

    // Verify routing and metadata
    expect(alert.recipientId).toBe("ops_lead");
    expect(alert.severity).toBe("critical");
    expect(alert.fingerprint).toBeDefined();

    // Must be valid according to contracts schema
    expect(AnomalyAlertSchema.safeParse(alert).success).toBe(true);
  });
});
