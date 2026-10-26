// Playground: run one SQL string through the real safety path
// (sqlGuard → read-only executor as agent_ro) against the local DB.
//
//   pnpm try:query "SELECT ..."        (from the repo root)
//
// Prints the guard verdict, then rows or the sanitized DbToolError.
import pg from "pg";
import type { SchemaCatalog } from "@se373/contracts";
import { warmupSqlGuard } from "@se373/sql-guard";
import { PgPoolAdapter, runQuery } from "../src/db.js";

const sql = process.argv[2];
if (!sql) {
  console.error('Usage: pnpm try:query "SELECT ..."');
  process.exit(2);
}
if (!process.env["DATABASE_URL"]) {
  console.error("DATABASE_URL is not set (agent_ro). Copy the DB section of .env.example into .env.");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });

// Build the guard's catalog from the live business schema.
async function loadCatalog(): Promise<SchemaCatalog> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'business' ORDER BY table_name, ordinal_position`,
  );
  const tables: Record<string, string[]> = {};
  for (const r of rows) (tables[r.table_name] ??= []).push(r.column_name);
  return { tables };
}

try {
  await warmupSqlGuard();
  const catalog = await loadCatalog();
  const result = await runQuery(new PgPoolAdapter(pool), sql, catalog, { maxRows: 20 });
  if ("code" in result) {
    console.log("BLOCKED / ERROR:", result);
  } else {
    console.log(`rows: ${result.rowCount}  truncated: ${result.truncated}  ${result.durationMs} ms`);
    console.table(result.rows);
  }
} finally {
  await pool.end();
}
