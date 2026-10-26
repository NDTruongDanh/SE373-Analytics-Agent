// LocalQuerySafetyGate matrix (GUARD-03, 01-11). DB-free: sqlGuard runs the
// WASM parser locally, the gate is pure. No API key, no MCP, no pg.
import { beforeAll, describe, expect, it } from "vitest";
import {
  sqlGuard,
  warmupSqlGuard,
  type GuardSuccess,
} from "@se373/access-policy";
import type { SchemaCatalog } from "@se373/contracts";
import {
  DETAIL_QUERY_LIMIT,
  clampLimit,
  localQuerySafetyGate,
} from "../src/queryExecutor/safetyGate.js";

function col(
  name: string,
  sensitive = false,
  large = false,
): SchemaCatalog["tables"][number]["columns"][number] {
  return { name, type: "text", nullable: true, sensitive, large };
}

const baseCatalog: SchemaCatalog = {
  tables: [
    {
      name: "customers",
      columns: [
        { ...col("id"), type: "integer", nullable: false },
        col("phone", true),
        col("email", true),
        col("address", true),
        col("region"),
      ],
    },
    {
      name: "orders",
      columns: [
        { ...col("id"), type: "integer", nullable: false },
        { ...col("customer_id"), type: "integer" },
        { ...col("status") },
        { ...col("total"), type: "numeric" },
      ],
    },
    {
      name: "sellers",
      columns: [
        { ...col("id"), type: "integer", nullable: false },
        col("name"),
        col("region"),
      ],
    },
    {
      name: "employees",
      columns: [
        { ...col("id"), type: "integer", nullable: false },
        col("name"),
        { ...col("salary"), type: "numeric", sensitive: true },
        col("dept"),
      ],
    },
  ],
};

/** orders flagged large: any large column marks the table large. */
const largeCatalog: SchemaCatalog = {
  tables: baseCatalog.tables.map((table) =>
    table.name === "orders"
      ? { ...table, columns: table.columns.map((c) => ({ ...c, large: true })) }
      : table,
  ),
};

async function gate(sql: string, catalog: SchemaCatalog = baseCatalog) {
  const guard = await sqlGuard(sql, catalog);
  expect(guard.ok).toBe(true);
  if (!guard.ok) {
    throw new Error(`guard unexpectedly failed: ${guard.error.message}`);
  }
  return localQuerySafetyGate(sql, guard as GuardSuccess, catalog);
}

describe("LocalQuerySafetyGate", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("denies a sensitive column referenced in WHERE", async () => {
    const result = await gate(
      "SELECT id FROM customers WHERE email = 'a@b.vn'",
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("SENSITIVE_COLUMN_DENIED");
    expect(result.error.message).toContain("email");
  });

  it("denies a sensitive column smuggled into an aggregate", async () => {
    const result = await gate(
      "SELECT dept, COUNT(salary) AS n FROM employees GROUP BY dept",
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("SENSITIVE_COLUMN_DENIED");
    expect(result.error.message).toContain("salary");
  });

  it("denies CROSS JOIN", async () => {
    const result = await gate("SELECT * FROM orders CROSS JOIN customers");
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
  });

  it("denies a conditionless comma join", async () => {
    const result = await gate("SELECT * FROM orders, customers");
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
  });

  it("returns needs_clarification for an unfiltered large-table scan", async () => {
    const result = await gate(
      "SELECT id, status FROM orders",
      largeCatalog,
    );
    expect(result).toMatchObject({
      verdict: "needs_clarification",
      table: "orders",
    });
    if (result.verdict !== "needs_clarification") return;
    expect(result.reason).toContain("orders");
  });

  it("passes a filtered large-table scan (with the LIMIT clamp)", async () => {
    const result = await gate(
      "SELECT id, status FROM orders WHERE status = 'ok'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
    if (result.verdict !== "pass") return;
    expect(result.sql).toContain(`LIMIT ${DETAIL_QUERY_LIMIT}`);
  });

  it("appends LIMIT 200 to a detail query with no LIMIT", async () => {
    const result = await gate(
      "SELECT id, status FROM orders WHERE status = 'ok'",
    );
    expect(result.verdict).toBe("pass");
    if (result.verdict !== "pass") return;
    expect(result.sql).toBe(
      "SELECT id, status FROM orders WHERE status = 'ok' LIMIT 200",
    );
  });

  it("clamps LIMIT 5000 down to LIMIT 200", async () => {
    const result = await gate(
      "SELECT id, status FROM orders WHERE status = 'ok' LIMIT 5000",
    );
    expect(result.verdict).toBe("pass");
    if (result.verdict !== "pass") return;
    expect(result.sql).toContain("LIMIT 200");
    expect(result.sql).not.toContain("5000");
  });

  it("leaves an aggregate COUNT query without LIMIT untouched", async () => {
    const sql =
      "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n";
    const result = await gate(sql);
    expect(result).toEqual({ verdict: "pass", sql });
  });

  it("passes the v1 alias-in-ORDER-BY regression shape", async () => {
    const sql =
      "SELECT region, COUNT(*) AS revenue FROM sellers GROUP BY region ORDER BY revenue";
    const result = await gate(sql);
    expect(result).toEqual({ verdict: "pass", sql });
  });

  it("passes a conditioned JOIN with ON", async () => {
    const result = await gate(
      "SELECT o.id, c.region FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'ok'",
    );
    expect(result.verdict).toBe("pass");
    if (result.verdict !== "pass") return;
    expect(result.sql).toContain(`LIMIT ${DETAIL_QUERY_LIMIT}`);
  });
});

describe("clampLimit", () => {
  it("keeps a LIMIT already under the cap", () => {
    expect(clampLimit("SELECT 1 LIMIT 50", 200)).toBe("SELECT 1 LIMIT 50");
  });

  it("leaves a non-numeric LIMIT for the server", () => {
    expect(clampLimit("SELECT 1 LIMIT $1", 200)).toBe("SELECT 1 LIMIT $1");
  });
});
