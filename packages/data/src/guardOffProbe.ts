// Direct agent_ro write-refusal probe (issue #39, D-03). Operator tooling:
// packages/data is the pg exemption precedent (COPY/load/verify already hold
// role connections here), so the eval harness borrows a probe from this
// package instead of importing pg from unscoped eval code (unresolvable under
// pnpm isolation). No server switch, no guard bypass: the probe connects with
// the given role URL, asserts the role reads back agent_ro, attempts one
// bounded single-row DELETE inside a rolled-back transaction, and reports the
// SQLSTATE plus before/after counts. Never call with an owner/indexer URL.
import { Client } from "pg";

const COUNT_TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface GuardOffProbeResult {
  code?: string;
  message: string;
  rowCountBefore: number;
  rowCountAfter: number;
}

/**
 * Coerce a COUNT(*) cell to a finite number. node-pg returns int8 counts as
 * decimal strings, while the gateway JSON path may already carry numbers —
 * accept both, reject everything else so callers fail closed instead of
 * comparing against NaN.
 */
export function parseCountValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function probeAgentRoWriteRefused(
  url: string,
  table: string,
  sql: string,
): Promise<GuardOffProbeResult> {
  if (!COUNT_TABLE_PATTERN.test(table)) {
    throw new Error(`refusing to probe untrusted table name '${table}'`);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const roleRows = (await client.query("SELECT current_user AS role"))
      .rows as Array<{ role?: unknown }>;
    if (roleRows[0]?.role !== "agent_ro") {
      throw new Error(
        `refusing direct-pg probe: connected as '${String(roleRows[0]?.role)}', expected agent_ro`,
      );
    }
    const beforeRaw = (await client.query(`SELECT COUNT(*) AS n FROM ${table}`))
      .rows[0].n;
    const before = parseCountValue(beforeRaw);
    if (before === undefined) {
      throw new Error(`count probe on ${table} returned no numeric n`);
    }
    await client.query("BEGIN");
    let code: string | undefined;
    let message: string;
    try {
      const statement =
        typeof sql === "string" && sql.length > 0
          ? sql
          : `DELETE FROM ${table} WHERE true`;
      await client.query(statement);
      message = "write unexpectedly succeeded";
    } catch (error) {
      code = (error as { code?: unknown }).code as string | undefined;
      message =
        error instanceof Error ? error.message.slice(0, 500) : String(error);
    } finally {
      await client.query("ROLLBACK");
    }
    const afterRaw = (await client.query(`SELECT COUNT(*) AS n FROM ${table}`))
      .rows[0].n;
    const after = parseCountValue(afterRaw);
    if (after === undefined) {
      throw new Error(`count re-probe on ${table} returned no numeric n`);
    }
    return { code, message, rowCountBefore: before, rowCountAfter: after };
  } finally {
    await client.end();
  }
}
