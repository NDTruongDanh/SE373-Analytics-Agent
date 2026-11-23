import { createHash } from "node:crypto";
import { Pool } from "pg";

export interface AlertRecord {
  recipientId: string;
  metric: string;
  dimensionKey: string;
  date: string;
  direction: string;
  fingerprint?: string;
}

export type FingerprintInput = Omit<AlertRecord, "fingerprint">;

// Single canonical field order shared between DAO rows and UC-10 dedup checks.
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

export interface PoolLike {
  query(
    text: string,
    params: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

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

  async hasFingerprint(fingerprint: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM app_state.alert_history " +
        "WHERE fingerprint = $1 AND sent_at >= NOW() - INTERVAL '24 hours'",
      [fingerprint],
    );
    return result.rows.length > 0;
  }

  // Call only after send_alert succeeds (write-after-send) so failed sends are not suppressed.
  // Updates expired (>24h) fingerprints in place so the primary key does not block future alerts.
  async recordSent(row: AlertRecord): Promise<void> {
    const fingerprint = row.fingerprint ?? sha256Fingerprint(row);
    await this.pool.query(
      "INSERT INTO app_state.alert_history " +
        "(fingerprint, recipient_id, metric, dimension_key, alert_date, direction) " +
        "VALUES ($1, $2, $3, $4, $5, $6) " +
        "ON CONFLICT (fingerprint) DO UPDATE SET " +
        "recipient_id = EXCLUDED.recipient_id, metric = EXCLUDED.metric, " +
        "dimension_key = EXCLUDED.dimension_key, alert_date = EXCLUDED.alert_date, " +
        "direction = EXCLUDED.direction, sent_at = NOW() " +
        "WHERE app_state.alert_history.sent_at < NOW() - INTERVAL '24 hours'",
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

  async close(): Promise<void> {
    await this.pool.end();
  }
}
