import { beforeAll, describe, expect, it } from "vitest";
import { sqlGuard, warmupSqlGuard } from "@se373/sql-guard";
import type { SchemaCatalog } from "@se373/contracts";

// Proves the D-01 dual-consumer layout: the agent imports the guard package
// by its workspace specifier for UC-01 local pre-flight, without touching
// the DB-import ban (no pg / pg-cursor / mcp-server imports here).
const catalog: SchemaCatalog = {
  tables: {
    orders: ["id", "total", "status"],
  },
};

describe("agent guard pre-flight", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("accepts a no-FROM SELECT", async () => {
    const result = await sqlGuard("SELECT 1", catalog);
    expect(result.ok).toBe(true);
  });

  it("rejects DELETE with FORBIDDEN_STATEMENT", async () => {
    const result = await sqlGuard("DELETE FROM orders", catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
    }
  });
});
