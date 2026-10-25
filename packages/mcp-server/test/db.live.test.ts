import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { RunQueryOutputSchema } from "@se373/contracts";
import { PgPoolAdapter, runQuery } from "../src/db.js";

// Live executor tests (GUARD-04 live leg, D-04). The whole file skips when
// DATABASE_URL is unset, so CI without Postgres stays green-by-skip and no
// connection is ever attempted. Phase 2 reruns this file against agent_ro
// to prove the 57014 and 25006 paths for real. Credentials never appear in
// assertions or names.
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("db live (requires DATABASE_URL)", () => {
  it("runs a bounded read with truncated false", async () => {
    const pool = new PgPoolAdapter(
      new Pool({ connectionString: process.env.DATABASE_URL }),
    );
    try {
      const result = await runQuery(pool, "SELECT 1 AS one", { tables: {} }, {
        maxRows: 10,
      });
      if ("code" in result) throw new Error(`live query failed: ${result.code}`);
      expect(result.rowCount).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.columns).toEqual(["one"]);
      expect(result.maskedColumns).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(() => RunQueryOutputSchema.parse(result)).not.toThrow();
    } finally {
      await pool.end();
    }
  });
});
