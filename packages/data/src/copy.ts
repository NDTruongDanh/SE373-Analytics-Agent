import { Pool, type PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";

const DSN_PATTERN = /postgres(ql)?:\/\/[^\s"'`]+/gi;
const HOST_ASSIGN_PATTERN = /host\s*=\s*[^\s;,]+/gi;
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const PATH_PATTERN = /\/[\w.\-/~]+(\.\w{1,5})?/g;

function redactInfra(text: string): string {
  return text
    .replace(DSN_PATTERN, "postgres://<redacted>")
    .replace(HOST_ASSIGN_PATTERN, "host=<redacted>")
    .replace(IPV4_PATTERN, "<redacted>");
}

// Redacts DSN/IP/path leaks from driver errors while preserving pg SQLSTATE code.
export function sanitizeCopyError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactInfra(raw).replace(PATH_PATTERN, "<redacted-path>");
  const wrapped = new Error(
    message.length > 500 ? message.slice(0, 500) : message,
  );
  if (typeof err === "object" && err !== null && "code" in err) {
    (wrapped as { code?: unknown }).code = (err as { code?: unknown }).code;
  }
  return wrapped;
}

export function createOwnerPool(): Pool {
  const connectionString = process.env["OWNER_DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "OWNER_DATABASE_URL is not set — export the owner URL before running the loader",
    );
  }
  return new Pool({ connectionString });
}

export async function withOwnerTx<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    throw sanitizeCopyError(err);
  }
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection already broken — release in finally still runs.
    }
    throw sanitizeCopyError(err);
  } finally {
    client.release();
  }
}

function toCopyLine(values: readonly unknown[]): string {
  return (
    values
      .map((value) => {
        if (value === null || value === undefined) return "\\N";
        return String(value)
          .replace(/\\/g, "\\\\")
          .replace(/\t/g, "\\t")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\r");
      })
      .join("\t") + "\n"
  );
}

// Callers must pass table/column names only from TABLE_LOADERS, never user input.
export async function copyTable(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<number> {
  const stream = client.query(
    copyFrom(`COPY ${table} (${columns.join(", ")}) FROM STDIN`),
  );
  await new Promise<void>((resolve, reject) => {
    stream.on("error", (err: unknown) => {
      stream.destroy();
      reject(sanitizeCopyError(err));
    });
    stream.on("finish", () => resolve());
    for (const row of rows) {
      stream.write(toCopyLine(row));
    }
    stream.end();
  });
  return rows.length;
}
