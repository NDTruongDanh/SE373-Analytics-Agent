import { Client } from "pg";

const COUNT_TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface GuardOffProbeResult {
  code?: string;
  message: string;
  rowCountBefore: number;
  rowCountAfter: number;
}

// node-pg returns int8 COUNT(*) as decimal strings while JSON paths use numbers; reject non-finite values.
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

function firstCell(rows: unknown, key: string): unknown {
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null) return undefined;
  return (row as Record<string, unknown>)[key];
}

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" && code.length > 0 ? code : undefined;
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
    const role = firstCell(
      (await client.query("SELECT current_user AS role")).rows,
      "role",
    );
    if (role !== "agent_ro") {
      throw new Error(
        `refusing direct-pg probe: connected as '${String(role)}', expected agent_ro`,
      );
    }
    const before = parseCountValue(
      firstCell((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows, "n"),
    );
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
      code = pgErrorCode(error);
      message =
        error instanceof Error ? error.message.slice(0, 500) : String(error);
    } finally {
      await client.query("ROLLBACK");
    }
    const after = parseCountValue(
      firstCell((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows, "n"),
    );
    if (after === undefined) {
      throw new Error(`count re-probe on ${table} returned no numeric n`);
    }
    return { code, message, rowCountBefore: before, rowCountAfter: after };
  } finally {
    await client.end();
  }
}
