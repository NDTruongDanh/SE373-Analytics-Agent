import { describe, expect, it } from "vitest";
import { calculateAlertFingerprint } from "../src/alerts/fingerprint.js";

describe("Alert Fingerprint (UC-10 §7)", () => {
  const baseInput = {
    recipientId: "ops_lead",
    metric: "metric:return_rate",
    dimensionKey: "regions.province = 'Đà Nẵng'",
    date: "2026-09-12",
    direction: "spike",
  };

  it("produces deterministic SHA-256 hex digest", () => {
    const fp1 = calculateAlertFingerprint(baseInput);
    const fp2 = calculateAlertFingerprint(baseInput);
    expect(fp1).toHaveLength(64);
    expect(fp1).toBe(fp2);
  });

  it("changes fingerprint when recipientId changes (cross-recipient isolation)", () => {
    const fp1 = calculateAlertFingerprint(baseInput);
    const fp2 = calculateAlertFingerprint({
      ...baseInput,
      recipientId: "regional_lead_south",
    });
    // PRD UC-10 §7: National director and regional lead must NOT block each other
    expect(fp1).not.toBe(fp2);
  });

  it("changes fingerprint when date changes", () => {
    const fp1 = calculateAlertFingerprint(baseInput);
    const fp2 = calculateAlertFingerprint({
      ...baseInput,
      date: "2026-09-13",
    });
    expect(fp1).not.toBe(fp2);
  });

  it("changes fingerprint when metric changes", () => {
    const fp1 = calculateAlertFingerprint(baseInput);
    const fp2 = calculateAlertFingerprint({
      ...baseInput,
      metric: "metric:net_revenue",
    });
    expect(fp1).not.toBe(fp2);
  });

  it("changes fingerprint when dimensionKey changes", () => {
    const fp1 = calculateAlertFingerprint(baseInput);
    const fp2 = calculateAlertFingerprint({
      ...baseInput,
      dimensionKey: "regions.province = 'Hà Nội'",
    });
    expect(fp1).not.toBe(fp2);
  });

  it("changes fingerprint when direction changes", () => {
    const fp1 = calculateAlertFingerprint(baseInput);
    const fp2 = calculateAlertFingerprint({
      ...baseInput,
      direction: "drop",
    });
    expect(fp1).not.toBe(fp2);
  });
});

