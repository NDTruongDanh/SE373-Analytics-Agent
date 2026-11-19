import { describe, expect, it } from "vitest";
import {
  InMemoryAlertHistoryStore,
  sendAlert,
} from "../src/alerts/index.js";
import type { SendAlertInput } from "@shared/contracts";

describe("sendAlert local tool (UC-10 / architecture §4.2)", () => {
  const validInput: SendAlertInput = {
    metric: "metric:return_rate",
    currentValue: 0.18,
    expectedValue: 0.04,
    deviation: "z=+4.2, WoW=+120%",
    drilldownSegment: "regions.province = 'TP.HCM'",
    evidenceSql: "SELECT 1",
    recipientId: "ops_lead",
    recipientRole: "operations",
    severity: "critical",
    message: "Critical return rate spike detected in TP.HCM",
  };

  it("validates input, sends alert, and returns SendAlertOutput", async () => {
    const historyStore = new InMemoryAlertHistoryStore();
    const result = await sendAlert(validInput, {
      historyStore,
      transport: async () => ({ ok: true, status: 200 }),
    });

    expect(result.sent).toBe(true);
    expect(result.fingerprint).toBeDefined();
    expect(typeof result.fingerprint).toBe("string");
    expect(await historyStore.hasFingerprint(result.fingerprint)).toBe(true);
  });

  it("handles duplicate alert by returning sent=false with fingerprint", async () => {
    const historyStore = new InMemoryAlertHistoryStore();
    const res1 = await sendAlert(validInput, {
      historyStore,
      transport: async () => ({ ok: true, status: 200 }),
    });
    expect(res1.sent).toBe(true);

    const res2 = await sendAlert(validInput, {
      historyStore,
      transport: async () => ({ ok: true, status: 200 }),
    });
    expect(res2.sent).toBe(false);
    expect(res2.fingerprint).toBe(res1.fingerprint);
  });

  it("queues non-critical alerts when digest is enabled", async () => {
    const historyStore = new InMemoryAlertHistoryStore();
    const warningInput: SendAlertInput = {
      ...validInput,
      severity: "warning",
      message: "Warning level anomaly",
    };

    const result = await sendAlert(warningInput, {
      historyStore,
      flushDigest: false,
    });

    expect(result.sent).toBe(false);
    expect(result.queued).toBe(true);
    expect(result.fingerprint).toBeDefined();
  });

  it("rejects input violating SendAlertInputSchema", async () => {
    const historyStore = new InMemoryAlertHistoryStore();
    const invalidInput = {
      ...validInput,
      severity: "invalid_severity",
    };

    await expect(
      sendAlert(invalidInput as unknown as SendAlertInput, { historyStore }),
    ).rejects.toThrow();
  });
});
