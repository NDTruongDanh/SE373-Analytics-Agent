import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactPII } from "@shared/access-policy";
import {
  AnomalyAlertSchema,
  type AnomalyAlert,
} from "@shared/contracts";
import {
  calculateAlertFingerprint,
  type AlertFingerprintInput,
} from "./fingerprint.js";

export interface AlertRecord extends AlertFingerprintInput {
  fingerprint?: string;
  severity?: string;
  sentAt?: string;
}

export interface AlertHistoryStore {
  hasFingerprint(fingerprint: string): Promise<boolean>;
  recordSent(record: AlertRecord): Promise<void>;
}

/**
 * In-memory implementation for tests and the explicitly mocked CLI demo.
 * Production runners must inject the AppStateStore-backed implementation.
 */
export class InMemoryAlertHistoryStore implements AlertHistoryStore {
  private readonly records = new Map<string, AlertRecord>();

  async hasFingerprint(fingerprint: string): Promise<boolean> {
    return this.records.has(fingerprint);
  }

  async recordSent(record: AlertRecord): Promise<void> {
    const fp = record.fingerprint ?? calculateAlertFingerprint(record);
    this.records.set(fp, {
      ...record,
      fingerprint: fp,
      sentAt: new Date().toISOString(),
    });
  }

  get(fingerprint: string): AlertRecord | undefined {
    return this.records.get(fingerprint);
  }

  getAll(): AlertRecord[] {
    return Array.from(this.records.values());
  }

  clear(): void {
    this.records.clear();
  }
}

export type SendAlertTransport = (
  alert: AnomalyAlert,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

export interface AlertDispatcherOptions {
  historyStore: AlertHistoryStore;
  digestQueue?: AlertDigestQueue;
  queueFilePath?: string;
  allowlist?: string[];
  transport?: SendAlertTransport;
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
  flushDigest?: boolean;
  logger?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface DispatchAlertResult {
  sent: boolean;
  fingerprint: string;
  queued?: boolean;
  isDigest?: boolean;
  skippedDuplicate?: boolean;
  blocked?: boolean;
  reason?: string;
  attempts?: number;
  error?: string;
}

export interface QueuedAlertEntry {
  queuedAt: string;
  attempts: number;
  error?: string;
  alert: AnomalyAlert;
}

const DEFAULT_FAILED_QUEUE_FILE = path.resolve(
  process.cwd(),
  "failed_alerts_queue.jsonl",
);

/**
 * Default mock transport that simulates delivery.
 */
export const defaultMockTransport: SendAlertTransport = async () => {
  return { ok: true, status: 200 };
};

/**
 * Checks if an error status or exception is retryable (5xx, timeout, network error).
 */
export function isRetryableError(status?: number, err?: unknown): boolean {
  if (status !== undefined) {
    return status >= 500 || status === 429 || status === 408;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("abort") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("network")
    );
  }
  return true;
}

/** Queue contract for deferred non-critical alerts. */
export interface AlertDigestQueue {
  enqueue(alert: AnomalyAlert): void;
  getAll(): AnomalyAlert[];
  clear(): AnomalyAlert[];
  size(): number;
}

/** Volatile queue for tests. Production defaults to JsonlDigestQueue. */
export class InMemoryDigestQueue implements AlertDigestQueue {
  private readonly items: AnomalyAlert[] = [];

  enqueue(alert: AnomalyAlert): void {
    this.items.push(alert);
  }

  getAll(): AnomalyAlert[] {
    return [...this.items];
  }

  clear(): AnomalyAlert[] {
    return this.items.splice(0, this.items.length);
  }

  size(): number {
    return this.items.length;
  }
}

const DEFAULT_DIGEST_QUEUE_FILE = path.resolve(
  process.cwd(),
  "pending_alert_digests.jsonl",
);

/** Durable pending-alert queue; queued entries survive runner restarts. */
export class JsonlDigestQueue implements AlertDigestQueue {
  constructor(
    private readonly filePath: string = DEFAULT_DIGEST_QUEUE_FILE,
  ) {}

  enqueue(alert: AnomalyAlert): void {
    appendFileSync(this.filePath, `${JSON.stringify(alert)}\n`, "utf8");
  }

  getAll(): AnomalyAlert[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    return lines.map((line, index) => {
      try {
        return AnomalyAlertSchema.parse(JSON.parse(line) as unknown);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Invalid digest queue entry at line ${index + 1}: ${detail}`,
        );
      }
    });
  }

  clear(): AnomalyAlert[] {
    const alerts = this.getAll();
    writeFileSync(this.filePath, "", "utf8");
    return alerts;
  }

  size(): number {
    return this.getAll().length;
  }
}

export const persistentDigestQueue: AlertDigestQueue = new JsonlDigestQueue();

/**
 * Resilient send_alert Dispatcher (UC-10 §7, F10.4, F10.5)
 *
 * Implements:
 * 1. Fingerprint derivation: SHA256(recipientId + "|" + metric + "|" + dimensionKey + "|" + date + "|" + direction)
 * 2. Recipient allowlist check
 * 3. 2nd-pass regex PII scan (phone, email) -> blocks and traces PII_BLOCKED
 * 4. Deduplication check (hasFingerprint) -> skips duplicate within 24h
 * 5. Severity routing:
 *    - critical: sends immediately with <= 3 exponential backoff retries & 10s timeout
 *    - warning/info: queues into digest (or sends if flushDigest=true)
 * 6. Write-after-send order: writes to historyStore ONLY after delivery succeeds.
 *    If retries fail, writes to failed_alerts_queue.jsonl so deduplication never suppresses future retries.
 */
export async function dispatchAlert(
  alert: AnomalyAlert,
  options: AlertDispatcherOptions,
): Promise<DispatchAlertResult> {
  const {
    historyStore,
    digestQueue = persistentDigestQueue,
    queueFilePath = DEFAULT_FAILED_QUEUE_FILE,
    allowlist,
    transport = defaultMockTransport,
    maxRetries = 3,
    initialDelayMs = 50,
    timeoutMs = 10000,
    flushDigest = false,
  } = options;

  // 1. Derive Canonical Fingerprint
  const dateStr = alert.date ?? new Date().toISOString().slice(0, 10);
  const dimensionKey = alert.drilldownSegment || "overall";
  const direction = alert.direction ?? "spike";

  const fingerprint =
    alert.fingerprint ??
    calculateAlertFingerprint({
      recipientId: alert.recipientId,
      metric: alert.metric,
      dimensionKey,
      date: dateStr,
      direction,
    });

  // 2. Recipient Allowlist Check
  if (allowlist && allowlist.length > 0 && !allowlist.includes(alert.recipientId)) {
    return {
      sent: false,
      blocked: true,
      reason: "RECIPIENT_NOT_ALLOWLISTED",
      fingerprint,
    };
  }

  // 3. PII Inspection (quét regex PII lần 2 trước send_alert, §6)
  const textToCheck = [
    alert.message ?? "",
    alert.drilldownSegment ?? "",
    alert.evidenceSql ?? "",
  ].join(" ");
  const piiScan = redactPII(textToCheck);
  if (piiScan.hit) {
    options.logger?.("PII_BLOCKED: alert blocked due to PII detected", {
      fingerprint,
      recipientId: alert.recipientId,
    });
    return {
      sent: false,
      blocked: true,
      reason: "PII_BLOCKED",
      fingerprint,
    };
  }

  // 4. Pre-send Deduplication Check
  const alreadySent = await historyStore.hasFingerprint(fingerprint);
  if (alreadySent) {
    return {
      sent: false,
      skippedDuplicate: true,
      fingerprint,
    };
  }

  // 5. Severity Routing
  const isCritical = alert.severity === "critical";

  if (!isCritical && !flushDigest) {
    // Non-critical alert -> queue to digest
    digestQueue.enqueue(alert);
    return {
      sent: false,
      queued: true,
      isDigest: true,
      fingerprint,
    };
  }

  // 6. Resilient Transport with Timeout & Exponential Backoff Retries
  let lastError = "";
  let attempts = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    let signal: AbortSignal | undefined;
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      signal = AbortSignal.timeout(timeoutMs);
    }

    try {
      const res = await transport(alert, signal);
      if (res.ok) {
        // SUCCESS: WRITE TO HISTORY ONLY NOW (write-after-send)
        await historyStore.recordSent({
          recipientId: alert.recipientId,
          metric: alert.metric,
          dimensionKey,
          date: dateStr,
          direction,
          fingerprint,
          severity: alert.severity,
        });

        return {
          sent: true,
          queued: false,
          fingerprint,
          attempts,
          isDigest: flushDigest && !isCritical,
        };
      }

      lastError = res.error
        ? `${res.status ? `${res.status} ` : ""}${res.error}`
        : `HTTP ${res.status}`;
      if (!isRetryableError(res.status)) {
        break; // 4xx non-retryable
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (!isRetryableError(undefined, err)) {
        break;
      }
    }

    // Exponential backoff wait before next attempt
    if (attempt < maxRetries) {
      const backoff = initialDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  // 7. Retries exhausted: Write to failed_alerts_queue.jsonl
  // DO NOT write to historyStore so deduplication never falsely suppresses future retries
  const queueEntry: QueuedAlertEntry = {
    queuedAt: new Date().toISOString(),
    attempts,
    error: lastError,
    alert: {
      ...alert,
      fingerprint,
    },
  };

  try {
    appendFileSync(queueFilePath, JSON.stringify(queueEntry) + "\n", "utf8");
  } catch (err) {
    options.logger?.("Failed to write to queue file", {
      error: String(err),
      fingerprint,
    });
  }

  options.logger?.("ALERT_QUEUED: alert delivery failed and queued", {
    fingerprint,
    attempts,
    error: lastError,
  });

  return {
    sent: false,
    queued: true,
    fingerprint,
    attempts,
    reason: "RETRY_EXHAUSTED",
    error: lastError,
  };
}

/**
 * Flushes failed alerts queue: attempts to resend all queued alerts.
 * If transport succeeds now that the channel is restored, records to
 * historyStore and removes from the queue file.
 */
export async function flushFailedAlertsQueue(
  options: AlertDispatcherOptions,
): Promise<{ flushed: number; remaining: number }> {
  const { queueFilePath = DEFAULT_FAILED_QUEUE_FILE, transport = defaultMockTransport, historyStore } = options;

  if (!existsSync(queueFilePath)) {
    return { flushed: 0, remaining: 0 };
  }

  const content = readFileSync(queueFilePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const stillFailed: QueuedAlertEntry[] = [];
  let flushedCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as QueuedAlertEntry;
      const res = await transport(entry.alert);
      if (res.ok) {
        flushedCount++;
        const alert = entry.alert;
        const dateStr = alert.date ?? new Date().toISOString().slice(0, 10);
        const dimensionKey = alert.drilldownSegment || "overall";
        const direction = alert.direction ?? "spike";
        const fingerprint =
          alert.fingerprint ??
          calculateAlertFingerprint({
            recipientId: alert.recipientId,
            metric: alert.metric,
            dimensionKey,
            date: dateStr,
            direction,
          });

        await historyStore.recordSent({
          recipientId: alert.recipientId,
          metric: alert.metric,
          dimensionKey,
          date: dateStr,
          direction,
          fingerprint,
          severity: alert.severity,
        });
      } else {
        stillFailed.push(entry);
      }
    } catch {
      // Keep in queue
      try {
        stillFailed.push(JSON.parse(line));
      } catch {
        // ignore unparseable
      }
    }
  }

  // Rewrite queue file with remaining items
  const newContent = stillFailed.map((item) => JSON.stringify(item)).join("\n");
  writeFileSync(queueFilePath, newContent.length > 0 ? newContent + "\n" : "", "utf8");

  return { flushed: flushedCount, remaining: stillFailed.length };
}
