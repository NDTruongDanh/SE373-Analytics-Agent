import { beforeAll, describe, expect, it } from "vitest";
import type { SchemaCatalog } from "@se373/contracts";
import { sqlGuard, warmupSqlGuard } from "../src/guard.js";

// Smoke set only: one accept plus three reject shapes. The full guard matrix
// (valid + malicious + error-shape cases) lands in plan 03-02.
const catalog: SchemaCatalog = {
  tables: {
    customers: ["id", "name", "phone", "email", "address", "city", "region"],
    orders: ["id", "customer_id", "total", "status", "created_at"],
  },
};

describe("sqlGuard smoke", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("accepts one aliased SELECT", async () => {
    const result = await sqlGuard(
      "SELECT o.id, o.total FROM orders o WHERE o.total > 100",
      catalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("rejects DELETE with FORBIDDEN_STATEMENT", async () => {
    const result = await sqlGuard("DELETE FROM orders", catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
    }
  });

  it("rejects stacked statements", async () => {
    const result = await sqlGuard("SELECT 1; DROP TABLE orders", catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
    }
  });

  it("rejects empty input with INVALID_SQL carrying a numeric position", async () => {
    const result = await sqlGuard("", catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SQL");
      expect(result.error.message).toMatch(/\d+/);
    }
  });
});
