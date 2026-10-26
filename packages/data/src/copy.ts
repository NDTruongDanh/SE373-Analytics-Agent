// COPY ingest over the owner role (Phase 2, plan 02-01). Operator tooling —
// never imported by agent code. Mirrors the mcp-server error-path shape
// (db.ts:115-154): connect in its own try, work in a second try, ROLLBACK on
// failure, release() in finally, every driver catch funneled through one
// formatter that redacts credentials and paths.
import { Pool, type PoolClient } from "pg";
import { from as copyFrom } from "pg-copy-streams";

// postgres://user:pass@host:port/db — kills credentials, host, port, dbname.
const DSN_PATTERN = /postgres(ql)?:\/\/[^\s"'`]+/gi;
// host=… fragments in connection errors.
const HOST_ASSIGN_PATTERN = /host\s*=\s*[^\s;,]+/gi;
// Bare IPv4 literals.
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Filesystem paths. The copy path streams in-memory rows only, but a driver
// error may still embed a path — redact it (message may contain SQL `/`).
const PATH_PATTERN = /\/[\w.\-/~]+(\.\w{1,5})?/g;

function redactInfra(text: string): string {
  return text
    .replace(DSN_PATTERN, "postgres://<redacted>")
    .replace(HOST_ASSIGN_PATTERN, "host=<redacted>")
    .replace(IPV4_PATTERN, "<redacted>");
}

// Single choke point for copy-path driver errors: redacted message, pg `code`
// preserved so callers can assert on SQLSTATE.
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

// Owner pool for load/verify runs. Throws fail-fast when the URL is unset so
// a misconfigured shell cannot silently load into the wrong database.
export function createOwnerPool(): Pool {
  const connectionString = process.env["OWNER_DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "OWNER_DATABASE_URL is not set — export the owner URL before running the loader",
    );
  }
  return new Pool({ connectionString });
}

// BEGIN / COMMIT with ROLLBACK-on-failure and release-in-finally.
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

// COPY TEXT escaping: tab-delimited lines, backslash escapes, \N for NULL.
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

// Streams row arrays through `COPY <table> (<columns>) FROM STDIN` inside the
// caller's transaction (pair with withOwnerTx). Table/column names come from
// the internal TABLE_LOADERS registry — never from user input.
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
