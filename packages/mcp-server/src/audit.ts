import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import pino from "pino";
import { redactPII, type RowScopeApplied } from "@shared/access-policy";

export interface AuditRecord {
  ts: string;
  runId: string;
  userId: string;
  role: string;
  clientId: string;
  scopes: string[];
  tool: string;
  params: unknown;
  outputSummary?: unknown;
  rowCount: number;
  durationMs: number;
  decision: "allow" | "deny";
  errorCode?: string;
  explainCost?: number | null;
  piiHits: number;
  maskedColumns: string[];
  /** Server-minted `{ table, column }` pairs only — never filter values. */
  rowScopeApplied: RowScopeApplied[];
}

export interface AuditClientLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean | Error): void;
}

export interface AuditPoolLike {
  connect(): Promise<AuditClientLike>;
  end(): Promise<void>;
}

type Destination = { write(line: string): unknown };

let destination: Destination | null = null;
let pgAuditPool: AuditPoolLike | null = null;
let ownPgAuditPool = false;

export const GENESIS_AUDIT_HASH = "0".repeat(64);

export function initAudit(auditPath: string): void {
  mkdirSync(path.dirname(auditPath), { recursive: true });
  destination = pino.destination({
    dest: auditPath,
    sync: true,
  }) as unknown as Destination;
}

export async function initPgAudit(options: {
  connString?: string;
  pool?: AuditPoolLike;
}): Promise<void> {
  if (options.pool) {
    pgAuditPool = options.pool;
    ownPgAuditPool = false;
  } else if (options.connString) {
    pgAuditPool = new Pool({
      connectionString: options.connString,
      max: 5,
    }) as unknown as AuditPoolLike;
    ownPgAuditPool = true;
  } else {
    throw new Error("initPgAudit requires connString or pool");
  }
  await ensureAuditSchema(pgAuditPool);
}

export async function closePgAudit(): Promise<void> {
  if (pgAuditPool && ownPgAuditPool) {
    await pgAuditPool.end();
  }
  pgAuditPool = null;
  ownPgAuditPool = false;
}

export function setAuditDestinationForTests(sink: Destination | null): void {
  destination = sink;
}

export function setPgAuditPoolForTests(pool: AuditPoolLike | null): void {
  pgAuditPool = pool;
  ownPgAuditPool = false;
}

export async function ensureAuditSchema(pool: AuditPoolLike): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize idempotent DDL across replicas sharing an existing volume.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ddl:mcp_audit', 0))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_state.mcp_audit_head (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        seq BIGINT NOT NULL DEFAULT 0,
        current_hash TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO app_state.mcp_audit_head (id, seq, current_hash)
       VALUES (1, 0, $1)
       ON CONFLICT (id) DO NOTHING`,
      [GENESIS_AUDIT_HASH],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_state.mcp_audit_log (
        seq BIGINT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL,
        input_hash TEXT NOT NULL,
        output_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        current_hash TEXT NOT NULL,
        record JSONB NOT NULL
      )
    `);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw err;
  } finally {
    client.release();
  }
}

// Lexicographical ASCII key ordering and IEEE 754 float formatting for canonical SHA-256 hashing.
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? Number.prototype.toString.call(value) : "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      item === undefined ? "null" : canonicalJsonStringify(item),
    );
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const toJson = obj["toJSON"];
    if (typeof toJson === "function") {
      return canonicalJsonStringify((toJson as () => unknown).call(obj));
    }
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined && typeof obj[key] !== "function")
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJsonStringify(obj[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return "null";
}

export function sha256Utf8(payload: string): string {
  return createHash("sha256")
    .update(Buffer.from(payload, "utf8"))
    .digest("hex");
}

export function computeAuditChainHash(parts: {
  seq: number;
  runId: string;
  tool: string;
  caller: string;
  ts: string;
  inputHash: string;
  outputHash: string;
  prevHash: string;
}): string {
  const payload = [
    String(parts.seq),
    parts.runId,
    parts.tool,
    parts.caller,
    parts.ts,
    parts.inputHash,
    parts.outputHash,
    parts.prevHash,
  ].join("|");
  return sha256Utf8(payload);
}

// Mask SQL string literals so filter secrets or PII never reach the audit log.
function maskSqlLiterals(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(maskSqlLiterals);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] =
        key === "sql" && typeof entry === "string"
          ? entry.replace(/'[^']*'/g, "'?'")
          : maskSqlLiterals(entry);
    }
    return out;
  }
  return value;
}

export async function auditCall(record: AuditRecord): Promise<void> {
  const maskedParams = maskSqlLiterals(record.params);
  const { outputSummary: _omitted, ...persistable } = record;
  void _omitted;
  const redactedLine = redactPII(
    JSON.stringify({ ...persistable, params: maskedParams }),
  ).redacted;

  if (pgAuditPool !== null) {
    const caller =
      record.userId || record.role || record.clientId || "anonymous";
    const redactedParamsObj = JSON.parse(redactedLine) as Record<
      string,
      unknown
    >;
    const inputHash = sha256Utf8(
      canonicalJsonStringify(redactedParamsObj["params"] ?? {}),
    );
    const outputSummary = record.outputSummary ?? {
      decision: record.decision,
      rowCount: record.rowCount,
      errorCode: record.errorCode ?? null,
      piiHits: record.piiHits,
    };
    const outputHash = sha256Utf8(
      redactPII(canonicalJsonStringify(outputSummary)).redacted,
    );

    const client = await pgAuditPool.connect();
    try {
      await client.query("BEGIN");
      const headRes = await client.query(
        "SELECT current_hash, seq FROM app_state.mcp_audit_head WHERE id = 1 FOR UPDATE",
      );
      let prevHash = GENESIS_AUDIT_HASH;
      let currentSeq = 0;
      if (headRes.rows.length > 0) {
        prevHash = String(headRes.rows[0]?.["current_hash"] ?? GENESIS_AUDIT_HASH);
        currentSeq = Number(headRes.rows[0]?.["seq"] ?? 0);
      } else {
        await client.query(
          "INSERT INTO app_state.mcp_audit_head (id, seq, current_hash) VALUES (1, 0, $1)",
          [GENESIS_AUDIT_HASH],
        );
      }
      const nextSeq = currentSeq + 1;
      const currentHash = computeAuditChainHash({
        seq: nextSeq,
        runId: record.runId,
        tool: record.tool,
        caller,
        ts: record.ts,
        inputHash,
        outputHash,
        prevHash,
      });

      await client.query(
        `INSERT INTO app_state.mcp_audit_log
           (seq, run_id, tool, caller, ts, input_hash, output_hash, prev_hash, current_hash, record)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10::jsonb)`,
        [
          nextSeq,
          record.runId,
          record.tool,
          caller,
          record.ts,
          inputHash,
          outputHash,
          prevHash,
          currentHash,
          redactedLine,
        ],
      );
      await client.query(
        "UPDATE app_state.mcp_audit_head SET current_hash = $1, seq = $2, updated_at = now() WHERE id = 1",
        [currentHash, nextSeq],
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failure so the original DB failure surfaces.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  if (destination !== null) {
    destination.write(`${redactedLine}\n`);
  }
}
