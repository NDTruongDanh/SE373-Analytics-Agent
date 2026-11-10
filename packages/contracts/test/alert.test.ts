import { describe, expect, it } from "vitest";
import {
  AgentResponseSchema,
  AlertChannelSchema,
  AnomalyAlertResponseSchema,
  AnomalyAlertSchema,
  CoreAnomalyFieldsSchema,
  SendAlertInputSchema,
  SubscriptionsConfigSchema,
  SubscriptionSchema,
} from "../src/index.js";

describe("UC-10 Alert and Subscription Contract Schemas", () => {
  const validSubscription = {
    id: "return-rate-daily",
    metricId: "metric:return_rate",
    primaryDimension: "orders.purchase_date",
    suggestedSecondaryDimensions: ["regions.province", "categories.name_vi"],
    recipientId: "ops_lead",
    recipientRole: "operations",
    channel: "webhook" as const,
    digestPreference: "digest" as const,
    absoluteThreshold: {
      operator: "above" as const,
      value: 0.1,
      unit: "ratio",
    },
    minSupport: 15,
  };

  const validAlert = {
    metric: "metric:return_rate",
    currentValue: 0.285,
    expectedValue: 0.062,
    deviation: "z=+3.8, WoW=+360%",
    drilldownSegment: "province = 'Da Nang'",
    evidenceSql: "SELECT 1",
    dimensionKey: "2026-09-12|Da Nang",
    date: "2026-09-12",
    direction: "spike" as const,
    recipientId: "ops_lead",
    severity: "critical" as const,
  };

  it("validates SubscriptionSchema and defaults", () => {
    const parsed = SubscriptionSchema.parse(validSubscription);
    expect(parsed.id).toBe("return-rate-daily");
    expect(parsed.channel).toBe("webhook");
    expect(parsed.minSupport).toBe(15);
  });

  it("preprocesses snake_case keys from YAML/JSON to canonical camelCase", () => {
    const snakeCaseInput = {
      id: "net-revenue-daily",
      metric_id: "metric:net_revenue",
      primary_dimension: "orders.purchase_date",
      suggested_secondary_dimensions: ["regions.province", "orders.channel_id"],
      recipient_id: "finance_lead",
      recipient_role: "finance",
      channel: "telegram" as const,
      digest_preference: "realtime" as const,
      absolute_threshold: {
        operator: "below" as const,
        value: 10000000,
        unit: "vnd",
      },
      min_support: 20,
    };
    const parsed = SubscriptionSchema.parse(snakeCaseInput);
    expect(parsed.metricId).toBe("metric:net_revenue");
    expect(parsed.primaryDimension).toBe("orders.purchase_date");
    expect(parsed.suggestedSecondaryDimensions).toEqual(["regions.province", "orders.channel_id"]);
    expect(parsed.recipientId).toBe("finance_lead");
    expect(parsed.recipientRole).toBe("finance");
    expect(parsed.channel).toBe("telegram");
    expect(parsed.digestPreference).toBe("realtime");
    expect(parsed.minSupport).toBe(20);
    expect(parsed.absoluteThreshold?.value).toBe(10000000);
  });

  it("accepts all four alert channels (webhook, email, telegram, slack)", () => {
    for (const channel of ["webhook", "email", "telegram", "slack"] as const) {
      expect(AlertChannelSchema.parse(channel)).toBe(channel);
      const parsed = SubscriptionSchema.parse({
        ...validSubscription,
        channel,
      });
      expect(parsed.channel).toBe(channel);
    }
    expect(() => AlertChannelSchema.parse("sms")).toThrow();
  });

  it("supports flexible minSupport definitions (number and config object)", () => {
    const parsedNumber = SubscriptionSchema.parse({
      ...validSubscription,
      minSupport: 15,
    });
    expect(parsedNumber.minSupport).toBe(15);

    const parsedConfig = SubscriptionSchema.parse({
      ...validSubscription,
      minSupport: {
        minOrders: 20,
        minMetricTrimmedMean: 500000,
      },
    });
    expect(parsedConfig.minSupport).toEqual({
      minOrders: 20,
      minMetricTrimmedMean: 500000,
    });
  });

  it("validates SubscriptionsConfigSchema wrapper", () => {
    const config = {
      version: 1,
      subscriptions: [validSubscription],
    };
    const parsed = SubscriptionsConfigSchema.parse(config);
    expect(parsed.subscriptions).toHaveLength(1);
  });

  it("validates CoreAnomalyFieldsSchema with 6 mandatory fields", () => {
    const core = {
      metric: "metric:return_rate",
      currentValue: 0.285,
      expectedValue: 0.062,
      deviation: "z=+3.8, WoW=+360%",
      drilldownSegment: "province = 'Da Nang'",
      evidenceSql: "SELECT 1",
    };
    expect(CoreAnomalyFieldsSchema.parse(core)).toEqual(core);
    expect(() => CoreAnomalyFieldsSchema.parse({ ...core, evidenceSql: "" })).toThrow();
  });

  it("validates strict AnomalyAlertSchema with routing and deduplication fields", () => {
    const parsed = AnomalyAlertSchema.parse(validAlert);
    expect(parsed.metric).toBe("metric:return_rate");
    expect(parsed.currentValue).toBe(0.285);
    expect(parsed.dimensionKey).toBe("2026-09-12|Da Nang");
    expect(parsed.date).toBe("2026-09-12");
    expect(parsed.direction).toBe("spike");

    // Throws if missing dimensionKey or date
    expect(() =>
      AnomalyAlertSchema.parse({
        ...validAlert,
        dimensionKey: "",
      }),
    ).toThrow();

    expect(() =>
      AnomalyAlertSchema.parse({
        ...validAlert,
        date: "not-a-date",
      }),
    ).toThrow();
  });

  it("re-uses core fields in SendAlertInputSchema without duplication", () => {
    const sendInput = {
      metric: "metric:return_rate",
      currentValue: 0.285,
      expectedValue: 0.062,
      deviation: "z=+3.8, WoW=+360%",
      drilldownSegment: "province = 'Da Nang'",
      evidenceSql: "SELECT 1",
      recipientId: "ops_lead",
      severity: "critical" as const,
      message: "Spike detected in Da Nang",
    };
    const parsed = SendAlertInputSchema.parse(sendInput);
    expect(parsed.severity).toBe("critical");
    expect(parsed.metric).toBe("metric:return_rate");
  });

  it("validates AnomalyAlertResponseSchema carrying AnomalyAlert payload", () => {
    const envelope = {
      kind: "anomaly_alert" as const,
      status: "ok" as const,
      summary: "Spike detected in return rate",
      data: validAlert,
    };
    const parsed = AnomalyAlertResponseSchema.parse(envelope);
    expect(parsed.kind).toBe("anomaly_alert");
    expect(parsed.status).toBe("ok");

    // Also discriminates cleanly in AgentResponseSchema
    const agentResp = AgentResponseSchema.parse(envelope);
    expect(agentResp.kind).toBe("anomaly_alert");
  });
});
