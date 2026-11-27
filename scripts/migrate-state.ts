import { Pool } from "pg";
import { ensureAuditSchema, type AuditPoolLike } from "../packages/mcp-server/src/audit.js";

export interface MigrationClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean | Error): void;
}

export interface MigrationPoolLike {
  connect(): Promise<MigrationClientLike>;
}

export async function migrateSemanticCorpusVersion(
  pool: MigrationPoolLike,
): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ddl:corpus_version', 0))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS semantic.corpus_version (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        version BIGINT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO semantic.corpus_version (id, version)
       VALUES (1, 1)
       ON CONFLICT (id) DO NOTHING`,
    );
    await client.query("GRANT SELECT ON TABLE semantic.corpus_version TO agent_ro");
    await client.query(
      "GRANT SELECT, INSERT, UPDATE ON TABLE semantic.corpus_version TO indexer",
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken || undefined);
  }
}

export async function runStateMigration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const ownerUrl = env["OWNER_DATABASE_URL"] ?? env["DATABASE_URL"];
  if (!ownerUrl) {
    throw new Error("OWNER_DATABASE_URL or DATABASE_URL is required for semantic migration");
  }
  const harnessUrl = env["HARNESS_STATE_DATABASE_URL"];
  if (!harnessUrl) {
    throw new Error("HARNESS_STATE_DATABASE_URL is required for app_state audit migration");
  }

  const ownerPool = new Pool({ connectionString: ownerUrl, max: 2 });
  try {
    await migrateSemanticCorpusVersion(ownerPool);
  } finally {
    await ownerPool.end();
  }

  const harnessPool = new Pool({ connectionString: harnessUrl, max: 2 });
  try {
    await ensureAuditSchema(harnessPool as unknown as AuditPoolLike);
  } finally {
    await harnessPool.end();
  }
}

if (
  process.argv[1] !== undefined &&
  (await import("node:path")).resolve(process.argv[1]) ===
    (await import("node:url")).fileURLToPath(import.meta.url)
) {
  await runStateMigration();
  console.log("[db:migrate] semantic.corpus_version and app_state.mcp_audit_* up to date.");
}
