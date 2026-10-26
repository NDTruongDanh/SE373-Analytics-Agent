// PORT-02 AppStateStore DAO (01-13, wave 5). pg lives ONLY in apps/api:
// the agent package must never import this module (ESLint ban).
//
// Write-after-send contract (Tier 3, 01-RESEARCH-db.md): the 01-14 host
// calls recordSent(row) ONLY after send_alert succeeds — never
// speculatively, never inside the send path itself — so retries of failed
// sends are never falsely suppressed. hasFingerprint() is the pre-send
// 24h dedup check.
//
// All queries are parameterized ($1..$6); no dynamic SQL, no table-name
// interpolation. Fingerprints are SHA-256 over the canonical pipe-joined
// field order recipientId|metric|dimensionKey|date|direction so UC-10
// computes identical fingerprints through sha256Fingerprint().

import { createHash } from "node:crypto";
import { Pool } from "pg";

/** Fields identifying one sent alert. `date` is YYYY-MM-DD (alert_date). */
export interface AlertRecord {
  recipientId: string;
  metric: string;
  dimensionKey: string;
  date: string;
  direction: string;
  /**
   * Precomputed fingerprint. When omitted, recordSent() derives it via
   * sha256Fingerprint() so callers can never insert a row whose key
   * disagrees with the canonical normalization.
   */
  fingerprint?: string;
}

/** Subset of AlertRecord used as fingerprint input (no stored fingerprint). */
export type FingerprintInput = Omit<AlertRecord, "fingerprint">;

/**
 * Canonical alert fingerprint: SHA-256 hex over
 * recipientId|metric|dimensionKey|date|direction. One helper owns the field
 * order (T-01-13-04) so DAO rows and UC-10 dedup checks cannot diverge;
 * any field change flips the digest (pinned by unit legs).
 */
export function sha256Fingerprint(input: FingerprintInput): string {
  return createHash("sha256")
    .update(
      [
        input.recipientId,
        input.metric,
        input.dimensionKey,
        input.date,
        input.direction,
      ].join("|"),
      "utf8",
    )
    .digest("hex");
}

/**
 * Minimal pool surface the DAO needs. pg.Pool satisfies it; tests inject
 * a stub at this boundary so unit legs stay DB-free without module mocks
 * (live legs in the same file keep the real driver).
 */
export interface PoolLike {
  query(
    text: string,
    params: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

/**
 * DAO over app_state.alert_history as harness_state (owns app_state.*,
 * zero grants on public.* per D-08). Constructed solely from the
 * HARNESS_STATE_DATABASE_URL string; the optional second argument injects
 * a pool for tests only. The pool is owned by this instance and drained
 * via close().
 */
export class AppStateStore {
  private readonly pool: PoolLike;

  constructor(harnessStateConn: string, pool?: PoolLike) {
    if (typeof harnessStateConn !== "string" || harnessStateConn.length === 0) {
      throw new Error(
        "AppStateStore: harnessStateConn must be a non-empty connection string " +
          "(HARNESS_STATE_DATABASE_URL).",
      );
    }
    this.pool = pool ?? new Pool({ connectionString: harnessStateConn, max: 2 });
  }

  /** Pre-send dedup check: true when this fingerprint was already recorded. */
  async hasFingerprint(fingerprint: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM app_state.alert_history WHERE fingerprint = $1",
      [fingerprint],
    );
    return result.rows.length > 0;
  }

  /**
   * Post-send record: INSERT exactly one row. Call ONLY after the alert was
   * actually sent (write-after-send). A duplicate fingerprint violates the
   * PRIMARY KEY (23505) — the caller treats that as already-sent, never as
   * a retryable transport error.
   */
  async recordSent(row: AlertRecord): Promise<void> {
    const fingerprint = row.fingerprint ?? sha256Fingerprint(row);
    await this.pool.query(
      "INSERT INTO app_state.alert_history " +
        "(fingerprint, recipient_id, metric, dimension_key, alert_date, direction) " +
        "VALUES ($1, $2, $3, $4, $5, $6)",
      [
        fingerprint,
        row.recipientId,
        row.metric,
        row.dimensionKey,
        row.date,
        row.direction,
      ],
    );
  }

  /** Drain the owned pool (host shutdown, test teardown). */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
