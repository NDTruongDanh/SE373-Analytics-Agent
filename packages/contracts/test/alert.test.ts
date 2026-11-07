import { describe, expect, it } from "vitest";
import {
    AgentResponseSchema,
    AnomalyAlertResponseSchema,
    AnomalyAlertSchema,
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
        recipientId: "ops_lead",
        severity: "critical" as const,
    };

    it("validates SubscriptionSchema and defaults", () => {
        const parsed = SubscriptionSchema.parse(validSubscription);
        expect(parsed.id).toBe("return-rate-daily");
        expect(parsed.minSupport).toBe(15);
    });

    it("validates SubscriptionsConfigSchema wrapper", () => {
        const config = {
            version: 1,
            subscriptions: [validSubscription],
        };
        const parsed = SubscriptionsConfigSchema.parse(config);
        expect(parsed.subscriptions).toHaveLength(1);
    });

    it("validates strict AnomalyAlertSchema with all 6 required fields", () => {
        const parsed = AnomalyAlertSchema.parse(validAlert);
        expect(parsed.metric).toBe("metric:return_rate");
        expect(parsed.currentValue).toBe(0.285);
        expect(parsed.evidenceSql).toBe("SELECT 1");

        // Throws if missing any of the 6 mandatory fields
        expect(() =>
            AnomalyAlertSchema.parse({
                ...validAlert,
                evidenceSql: "",
            }),
        ).toThrow();
    });

    it("strictly enforces AnomalyAlertResponseSchema and rejects arbitrary data", () => {
        // Rejects loose { n: 1 } data
        expect(() =>
            AnomalyAlertResponseSchema.parse({
                kind: "anomaly_alert",
                status: "ok",
                summary: "Spike detected",
                data: { n: 1 },
            }),
        ).toThrow();

        // Accepts valid AnomalyAlert data
        const validEnvelope = {
            kind: "anomaly_alert" as const,
            status: "ok" as const,
            summary: "Spike detected in return rate",
            data: validAlert,
        };
        const parsed = AnomalyAlertResponseSchema.parse(validEnvelope);
        expect(parsed.kind).toBe("anomaly_alert");
        expect(parsed.data.currentValue).toBe(0.285);
    });

    it("discriminates tightened anomaly_alert in AgentResponseSchema", () => {
        const validEnvelope = {
            kind: "anomaly_alert" as const,
            status: "ok" as const,
            summary: "Critical alert",
            data: validAlert,
        };
        const parsed = AgentResponseSchema.parse(validEnvelope);
        expect(parsed.kind).toBe("anomaly_alert");
    });
});