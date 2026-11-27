import { Pool } from "pg";
import Cursor from "pg-cursor";
import { dbToolError, type DbToolError } from "@shared/contracts";
import { sanitizeError } from "./errors.js";

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

export function resetAgentRoPoolForTests(): void {
  if (pool) {
    const old = pool;
    pool = null;
    void old.end().catch(() => undefined);
  }
}

// Engine row-level security (docker/initdb/05_row_security.sql) reads these per
// transaction; a missing or empty row scope returns no rows, "*" means unscoped.
export const UNSCOPED_ROW_SCOPE = "*";
export const RLS_SCOPE_COLUMN = "region_group";
export const SESSION_WORK_MEM = "16MB";

export interface SessionContext {
  role: string;
  rowScope: string;
}

export function sessionContextFor(principal: {
  role: string;
  rowScope?: { column: string; value: string } | null;
}): SessionContext {
  if (principal.rowScope === undefined || principal.rowScope === null) {
    return { role: principal.role, rowScope: UNSCOPED_ROW_SCOPE };
  }
  const supported = principal.rowScope.column.toLowerCase() === RLS_SCOPE_COLUMN;
  return { role: principal.role, rowScope: supported ? principal.rowScope.value : "" };
}

export interface ReadSession {
  beginReadOnly(context: SessionContext): Promise<void>;
  readBounded(
    body: string,
    maxRows: number,
  ): Promise<{
    rows: Record<string, unknown>[];
    truncated: boolean;
    columns: string[];
  }>;
  rollback(): Promise<void>;
  release(): void;
}

export type SessionFactory = () => Promise<ReadSession>;

function stripTrailingSemicolons(sql: string): string {
  return sql.trim().replace(/;+\s*$/u, "");
}

export function defaultSessionFactory(): Promise<ReadSession> {
  return getAgentRoPool()
    .connect()
    .then((client) => {
      let cursor: Cursor | null = null;
      const session: ReadSession = {
        async beginReadOnly(context: SessionContext): Promise<void> {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL statement_timeout = '30s'");
          await client.query(`SET LOCAL work_mem = '${SESSION_WORK_MEM}'`);
          await client.query(
            "SELECT set_config('app.role', $1, true), set_config('app.row_scope', $2, true)",
            [context.role, context.rowScope],
          );
        },
        async readBounded(body: string, maxRows: number) {
          const text = stripTrailingSemicolons(body);
          cursor = client.query(new Cursor(text)) as unknown as Cursor;
          try {
            const raw = (await cursor.read(maxRows + 1)) as Record<
              string,
              unknown
            >[];
            const truncated = raw.length > maxRows;
            const rows = truncated ? raw.slice(0, maxRows) : raw;
            let columns = rows.length > 0 ? Object.keys(rows[0] as object) : [];
            if (columns.length === 0) {
              // Zero rows carry no keys; a LIMIT 0 probe recovers column names in the same tx.
              const probe = await client.query(
                `SELECT * FROM (${text}) AS _cols LIMIT 0`,
              );
              columns = probe.fields.map((field) => field.name);
            }
            return { rows, truncated, columns };
          } finally {
            if (cursor !== null) {
              await cursor.close();
              cursor = null;
            }
          }
        },
        async rollback(): Promise<void> {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Ignore rollback failures — the original error matters.
          }
        },
        release(): void {
          client.release();
        },
      };
      return session;
    });
}

export type ExecutorFailure = { error: DbToolError };

export async function executeReadOnly(
  sql: string,
  maxRows: number,
  factory: SessionFactory,
  context: SessionContext,
): Promise<ReadOnlyResult | ExecutorFailure> {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 1000) {
    return {
      error: dbToolError(
        "INVALID_PARAMS",
        "maxRows must be an integer between 1 and 1000",
      ),
    };
  }
  let session: ReadSession;
  try {
    session = await factory();
  } catch (error) {
    return { error: sanitizeError(error) };
  }
  const started = Date.now();
  try {
    await session.beginReadOnly(context);
    const read = await session.readBounded(
      stripTrailingSemicolons(sql),
      maxRows,
    );
    await session.rollback();
    return {
      columns: read.columns,
      rows: read.rows,
      rowCount: read.rows.length,
      truncated: read.truncated,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    try {
      await session.rollback();
    } catch {
      // Ignore rollback failures — the original error is what matters.
    }
    return { error: sanitizeError(error) };
  } finally {
    session.release();
  }
}
