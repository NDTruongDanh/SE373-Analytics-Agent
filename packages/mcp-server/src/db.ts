import { Pool, type PoolClient } from "pg";
import Cursor from "pg-cursor";
import type {
  DbToolError,
  RunQueryOutput,
  SchemaCatalog,
} from "@se373/contracts";
import { dbToolError } from "@se373/contracts";
import { sqlGuard } from "@se373/sql-guard";
import { sanitizeError } from "./errors.js";

// Read-only executor (GUARD-04, D-02/D-04, T-3-07/T-3-08/T-3-10). This is the
// only module allowed to touch pg/pg-cursor. The fixed pipeline order is
// guard-then-execute: sqlGuard runs BEFORE any pool checkout, so rejected SQL
// never touches a connection. Session setup emits only a validated-int
// SET LOCAL — caller SQL is never interpolated.

// Structural seams for tests: fakes implement these interfaces, so no test
// imports the driver (module mocks would leak across files).
export interface CursorLike {
  read(n: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface ClientLike {
  query(text: string): Promise<unknown>;
  queryCursor(cursor: CursorLike): CursorLike;
  release(): void;
}

export interface PoolLike {
  connect(): Promise<ClientLike>;
  end?(): Promise<void>;
}

// Production adapter: the pg client's Submittable overload
// (`query(cursor)`) submits the cursor on the checked-out client.
class PgClientAdapter implements ClientLike {
  constructor(private readonly client: PoolClient) {}

  query(text: string): Promise<unknown> {
    return this.client.query(text);
  }

  queryCursor(cursor: CursorLike): CursorLike {
    this.client.query(cursor as unknown as Cursor);
    return cursor;
  }

  release(): void {
    this.client.release();
  }
}

export class PgPoolAdapter implements PoolLike {
  constructor(private readonly pool: Pool) {}

  async connect(): Promise<ClientLike> {
    return new PgClientAdapter(await this.pool.connect());
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

function defaultCursorFactory(sql: string): CursorLike {
  return new Cursor(sql) as unknown as CursorLike;
}

export const DEFAULT_MAX_ROWS = 200;
export const MAX_MAX_ROWS = 1000;
export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 300000;

export interface RunQueryOptions {
  maxRows?: number;
  timeoutMs?: number;
  cursorFactory?: (sql: string) => CursorLike;
}

// Guard-first read-only query over cursor-bounded reads. Returns the output
// row page on success or a sanitized DbToolError (guard rejection, invalid
// options, or any driver failure funneled through sanitizeError).
export async function runQuery(
  pool: PoolLike,
  sql: string,
  catalog: SchemaCatalog,
  options: RunQueryOptions = {},
): Promise<RunQueryOutput | DbToolError> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_MAX_ROWS) {
    return dbToolError(
      "INVALID_PARAMS",
      `maxRows must be an integer between 1 and ${MAX_MAX_ROWS}`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return dbToolError(
      "INVALID_PARAMS",
      `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }

  const guarded = await sqlGuard(sql, catalog);
  if (!guarded.ok) {
    return guarded.error;
  }

  const start = Date.now();
  let client: ClientLike;
  try {
    client = await pool.connect();
  } catch (err) {
    return sanitizeError(err);
  }
  try {
    await client.query("BEGIN READ ONLY");
    // SET LOCAL takes no bind parameters: only a server-side validated
    // integer is ever interpolated (options check above).
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}'`);
    const cursor = (options.cursorFactory ?? defaultCursorFactory)(sql);
    const submitted = client.queryCursor(cursor);
    const rows = await submitted.read(maxRows + 1);
    const truncated = rows.length > maxRows;
    const page = truncated ? rows.slice(0, maxRows) : rows;
    await submitted.close();
    await client.query("ROLLBACK");
    return {
      columns: page.length > 0 ? Object.keys(page[0] as Record<string, unknown>) : [],
      rows: page,
      rowCount: page.length,
      truncated,
      maskedColumns: [],
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // A failed statement poisons the pooled session (25P02 on next use):
    // roll back before returning so the connection is clean for release.
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection already broken — release in finally still runs.
    }
    return sanitizeError(err);
  } finally {
    client.release();
  }
}
