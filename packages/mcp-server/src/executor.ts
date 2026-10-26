import { Pool } from "pg";
import { dbToolError, type DbToolError } from "@se373/contracts";

// TRACER read-only executor (MCP-07 slice): agent_ro Pool, BEGIN READ ONLY,
// SET LOCAL statement_timeout, bounded SELECT with a truncated flag, ROLLBACK
// and release in finally. pg-cursor replaces the bounded select in 01-08.

export interface ReadOnlyResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

let pool: Pool | null = null;

export function getAgentRoPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.AGENT_RO_DATABASE_URL;
  if (!connectionString) {
    throw new Error("AGENT_RO_DATABASE_URL is not set");
  }
  pool = new Pool({ connectionString, max: 5 });
  return pool;
}

/** Test seam: drop the cached pool (tests only). */
export function resetAgentRoPoolForTests(): void {
  if (pool) {
    const old = pool;
    pool = null;
    void old.end().catch(() => undefined);
  }
}

function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

export type ExecutorFailure = { error: DbToolError };

function toExecutorFailure(err: unknown): ExecutorFailure {
  // TRACER error shaping: surface err.message only (never stacks — pg
  // connection failures embed the DSN password in stack text), capped at the
  // 500-char contract limit. sanitizeError (POL-05) replaces this in 01-08.
  const message =
    err instanceof Error ? err.message : "unknown executor failure";
  return {
    error: dbToolError(
      "SQL_EXECUTION_ERROR",
      message.slice(0, 500) || "query failed",
    ),
  };
}

export async function executeReadOnly(
  sql: string,
  maxRows: number,
): Promise<ReadOnlyResult | ExecutorFailure> {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000) {
    return {
      error: dbToolError(
        "INVALID_PARAMS",
        "maxRows must be an integer between 1 and 1000",
      ),
    };
  }
  let client;
  try {
    client = await getAgentRoPool().connect();
  } catch (err) {
    return toExecutorFailure(err);
  }
  const started = Date.now();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const body = stripTrailingSemicolons(sql);
    const res = await client.query(
      `SELECT * FROM (${body}) AS tracer_q LIMIT ${maxRows + 1}`,
      [],
    );
    await client.query("ROLLBACK");
    const truncated = res.rows.length > maxRows;
    const rows = (
      truncated ? res.rows.slice(0, maxRows) : res.rows
    ) as Record<string, unknown>[];
    return {
      columns: res.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures — the original error is what matters.
    }
    return toExecutorFailure(err);
  } finally {
    client.release();
  }
}
