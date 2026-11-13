import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnomalyAlert } from "@shared/contracts";
import {
  dispatchAlert as dispatchAlertRaw,
  flushFailedAlertsQueue,
  InMemoryDigestQueue,
  InMemoryAlertHistoryStore,
  JsonlDigestQueue,
  type SendAlertTransport,
} from "../src/alerts/dispatcher.js";

describe("Resilient send_alert Dispatcher (UC-10 §7, F10.4, F10.5)", () => {
  let tempDir: string;
  let queueFile: string;
  let historyStore: InMemoryAlertHistoryStore;
  let digestQueue: InMemoryDigestQueue;

  function dispatchAlert(
    alert: AnomalyAlert,
    options: Parameters<typeof dispatchAlertRaw>[1],
  ) {
    return dispatchAlertRaw(alert, { ...options, digestQueue });
  }

  const validAlert: AnomalyAlert = {
    metric: "metric:return_rate",
    currentValue: 0.185,
    expectedValue: 0.042,
    deviation: "z=+17.80, WoW=+340.0%",
    drilldownSegment: "regions.province = 'Đà Nẵng'",
    evidenceSql: "SELECT 1",
    recipientId: "ops_lead",
    recipientRole: "operations",
    severity: "critical",
    direction: "spike",
    date: "2026-09-12",
    message: "Critical return rate spike in Da Nang",
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "alert-dispatcher-test-"));
    queueFile = path.join(tempDir, "failed_alerts_queue.jsonl");
    historyStore = new InMemoryAlertHistoryStore();
    digestQueue = new InMemoryDigestQueue();
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("sends critical alert immediately and records history strictly write-after-send", async () => {
    let callCount = 0;
    const transport: SendAlertTransport = async () => {
      callCount++;
      return { ok: true, status: 200 };
    };

    const res = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
    });

    expect(res.sent).toBe(true);
    expect(res.queued).toBe(false);
    expect(callCount).toBe(1);

    // Verify written to historyStore
    const exists = await historyStore.hasFingerprint(res.fingerprint);
    expect(exists).toBe(true);
  });

  it("skips duplicate alert within 24h when fingerprint already exists", async () => {
    let callCount = 0;
    const transport: SendAlertTransport = async () => {
      callCount++;
      return { ok: true, status: 200 };
    };

    // First send
    const res1 = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
    });
    expect(res1.sent).toBe(true);
    expect(callCount).toBe(1);

    // Second send (same day, same metric, same slice, same recipient)
    const res2 = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
    });
    expect(res2.sent).toBe(false);
    expect(res2.skippedDuplicate).toBe(true);
    expect(callCount).toBe(1); // No transport call made
  });

  it("does not suppress alerts for different recipients (cross-recipient isolation)", async () => {
    let callCount = 0;
    const transport: SendAlertTransport = async () => {
      callCount++;
      return { ok: true, status: 200 };
    };

    const res1 = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
    });
    expect(res1.sent).toBe(true);

    // Different recipient
    const res2 = await dispatchAlert(
      { ...validAlert, recipientId: "country_manager" },
      {
        historyStore,
        queueFilePath: queueFile,
        transport,
      },
    );
    expect(res2.sent).toBe(true);
    expect(callCount).toBe(2);
  });

  it("retries up to 3 times on 5xx errors with exponential backoff and records only on success", async () => {
    let callCount = 0;
    const transport: SendAlertTransport = async () => {
      callCount++;
      if (callCount < 3) {
        return { ok: false, status: 503, error: "Service Unavailable" };
      }
      return { ok: true, status: 200 };
    };

    const res = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
      initialDelayMs: 10,
      maxRetries: 3,
    });

    expect(res.sent).toBe(true);
    expect(res.attempts).toBe(3);
    expect(callCount).toBe(3);

    // Recorded to history because 3rd attempt succeeded
    expect(await historyStore.hasFingerprint(res.fingerprint)).toBe(true);
  });

  it("fails after exhausting retries, writes to failed queue, and NEVER writes to historyStore", async () => {
    let callCount = 0;
    const transport: SendAlertTransport = async () => {
      callCount++;
      return { ok: false, status: 500, error: "Internal Server Error" };
    };

    const res = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
      initialDelayMs: 10,
      maxRetries: 3,
    });

    expect(res.sent).toBe(false);
    expect(res.queued).toBe(true);
    expect(res.attempts).toBe(3);
    expect(callCount).toBe(3);

    // CRITICAL (UC-10 §7): historyStore must NOT contain fingerprint
    // so future retry is not falsely suppressed
    expect(await historyStore.hasFingerprint(res.fingerprint)).toBe(false);

    // Verify written to failed_alerts_queue.jsonl
    const queueContent = readFileSync(queueFile, "utf8");
    expect(queueContent).toContain(validAlert.metric);
    expect(queueContent).toContain("500");
  });

  it("blocks alert and emits PII_BLOCKED when message contains phone or email", async () => {
    let called = false;
    const transport: SendAlertTransport = async () => {
      called = true;
      return { ok: true };
    };

    const alertWithPhone: AnomalyAlert = {
      ...validAlert,
      message: "Liên hệ khách hàng qua số 0912345678 để giải quyết hoàn đơn",
    };

    const res = await dispatchAlert(alertWithPhone, {
      historyStore,
      queueFilePath: queueFile,
      transport,
    });

    expect(res.sent).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.reason).toBe("PII_BLOCKED");
    expect(called).toBe(false);
  });

  it("blocks alert when recipient is not in allowlist", async () => {
    let called = false;
    const transport: SendAlertTransport = async () => {
      called = true;
      return { ok: true };
    };

    const res = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
      allowlist: ["finance_lead", "sales_director"], // ops_lead not allowed
    });

    expect(res.sent).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.reason).toBe("RECIPIENT_NOT_ALLOWLISTED");
    expect(called).toBe(false);
  });

  it("routes warning/info severity to digest queue unless flushDigest=true", async () => {
    let callCount = 0;
    const transport: SendAlertTransport = async () => {
      callCount++;
      return { ok: true };
    };

    const warningAlert: AnomalyAlert = {
      ...validAlert,
      severity: "warning",
    };

    // 1. Without flushDigest -> queued into digest
    const res1 = await dispatchAlert(warningAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
      flushDigest: false,
    });

    expect(res1.sent).toBe(false);
    expect(res1.queued).toBe(true);
    expect(res1.isDigest).toBe(true);
    expect(callCount).toBe(0);
    expect(digestQueue.size()).toBe(1);

    // 2. With flushDigest -> sent immediately
    const res2 = await dispatchAlert(warningAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport,
      flushDigest: true,
    });

    expect(res2.sent).toBe(true);
    expect(res2.isDigest).toBe(true);
    expect(callCount).toBe(1);
    expect(await historyStore.hasFingerprint(res2.fingerprint)).toBe(true);
  });

  it("flushes failed alerts queue when channel recovers and records to history", async () => {
    // 1. Create a failed alert in the queue file
    const transportFail: SendAlertTransport = async () => ({
      ok: false,
      status: 503,
      error: "Down",
    });

    const failRes = await dispatchAlert(validAlert, {
      historyStore,
      queueFilePath: queueFile,
      transport: transportFail,
      initialDelayMs: 5,
      maxRetries: 1,
    });

    expect(await historyStore.hasFingerprint(failRes.fingerprint)).toBe(false);

    // 2. Channel recovers: flush queue with working transport
    const transportSuccess: SendAlertTransport = async () => ({
      ok: true,
      status: 200,
    });

    const flushRes = await flushFailedAlertsQueue({
      historyStore,
      queueFilePath: queueFile,
      transport: transportSuccess,
    });

    expect(flushRes.flushed).toBe(1);
    expect(flushRes.remaining).toBe(0);

    // Now recorded in history
    expect(await historyStore.hasFingerprint(failRes.fingerprint)).toBe(true);
  });

  it("persists digest entries across queue instances", () => {
    const digestFile = path.join(tempDir, "pending_alert_digests.jsonl");
    const first = new JsonlDigestQueue(digestFile);
    first.enqueue(validAlert);

    const restarted = new JsonlDigestQueue(digestFile);
    expect(restarted.getAll()).toEqual([validAlert]);
    expect(restarted.size()).toBe(1);
    expect(restarted.clear()).toEqual([validAlert]);
    expect(new JsonlDigestQueue(digestFile).size()).toBe(0);
  });
});
