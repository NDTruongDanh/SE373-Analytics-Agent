// LocalQuerySafetyGate matrix (GUARD-03, 01-11). DB-free: sqlGuard runs the
// WASM parser locally, the gate is pure. No API key, no MCP, no pg.
import { beforeAll, describe, expect, it } from "vitest";
import {
  sqlGuard,
  warmupSqlGuard,
  type GuardSuccess,
} from "@shared/access-policy";
import type { SchemaCatalog } from "@shared/contracts";
import {
  clampLimit,
  localQuerySafetyGate,
} from "../src/queryExecutor/safetyGate.js";
import { DETAIL_QUERY_LIMIT } from "../src/constants.js";

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
        { ...col("order_id") },
        { ...col("customer_id"), type: "integer" },
        { ...col("status") },
        { ...col("purchase_date"), type: "timestamp" },
        { ...col("delivered_date"), type: "timestamp" },
        { ...col("total"), type: "numeric" },
      ],
    },
    {
      name: "order_items",
      columns: [
        { ...col("id"), type: "integer", nullable: false },
        { ...col("order_id"), type: "integer", nullable: false },
        { ...col("product_id"), type: "integer", nullable: false },
        { ...col("price"), type: "numeric" },
      ],
    },
    {
      name: "payments",
      columns: [
        { ...col("order_id"), nullable: false },
        { ...col("amount"), type: "numeric" },
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
    table.name === "orders" || table.name === "order_items"
      ? { ...table, columns: table.columns.map((c) => ({ ...c, large: true })) }
      : table,
  ),
};

async function gate(sql: string, catalog: SchemaCatalog = baseCatalog) {
  const guard = await sqlGuard(sql, catalog);
  if (!guard.ok) {
    throw new Error(`guard unexpectedly failed: ${guard.error.message}`);
  }
  expect(guard.ok).toBe(true);
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

  it("requires the indexed purchase_date filter, not an arbitrary WHERE clause", async () => {
    const result = await gate(
      "SELECT id, status FROM orders WHERE status = 'ok'",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("passes a large-table scan bounded by purchase_date", async () => {
    const result = await gate(
      "SELECT id, status FROM orders WHERE purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
    if (result.verdict !== "pass") return;
    expect(result.sql).toContain(`LIMIT ${DETAIL_QUERY_LIMIT}`);
  });

  it("returns needs_clarification for an unfiltered aggregate over a large table (#129)", async () => {
    const result = await gate(
      "SELECT COUNT(*) AS new_customers FROM orders",
      largeCatalog,
    );
    expect(result).toMatchObject({ verdict: "needs_clarification", table: "orders" });
  });

  it("returns needs_clarification for an unfiltered SUM over order_items (#129)", async () => {
    const result = await gate(
      "SELECT SUM(i.price) AS revenue FROM order_items i",
      largeCatalog,
    );
    expect(result).toMatchObject({ verdict: "needs_clarification", table: "order_items" });
  });

  it("passes an aggregate bounded by purchase_date", async () => {
    const result = await gate(
      "SELECT COUNT(*) AS n FROM orders WHERE purchase_date >= '2026-01-01' AND purchase_date < '2026-04-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
  });

  it("accepts a single-day purchase_date equality (UC-10 drill-down shape)", async () => {
    const result = await gate(
      "SELECT status, COUNT(*) AS n FROM orders WHERE orders.purchase_date = '2026-03-04' GROUP BY status",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
  });

  it("accepts a range on a date_trunc(purchase_date) alias", async () => {
    const result = await gate(
      "WITH m AS (SELECT date_trunc('month', purchase_date) AS month, COUNT(*) AS n FROM orders GROUP BY 1) SELECT m.month, m.n FROM m WHERE m.month >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
  });

  it("does not accept a range on an alias that mixes purchase_date with other columns", async () => {
    const result = await gate(
      "WITH t AS (SELECT COALESCE(purchase_date, delivered_date) AS d, COUNT(*) AS n FROM orders GROUP BY 1) SELECT t.d, t.n FROM t WHERE t.d >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("denies a flat orders x order_items x payments SUM as repairable fan-out (#129)", async () => {
    const result = await gate(
      "SELECT SUM(i.price) AS revenue, SUM(p.amount) AS paid FROM orders o JOIN order_items i ON i.order_id = o.order_id JOIN payments p ON p.order_id = o.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("INVALID_SQL");
    expect(result.error.repairable).toBe(true);
    expect(result.error.message).toContain("CTE");
  });

  it("passes the same metrics when each child is pre-aggregated in a CTE", async () => {
    const result = await gate(
      "WITH items AS (SELECT order_id, SUM(price) AS revenue FROM order_items GROUP BY order_id), pays AS (SELECT order_id, SUM(amount) AS paid FROM payments GROUP BY order_id) SELECT SUM(items.revenue) AS revenue, SUM(pays.paid) AS paid FROM orders o JOIN items ON items.order_id = o.order_id JOIN pays ON pays.order_id = o.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
  });

  it("allows COUNT(DISTINCT) and MIN/MAX across a child fan-out join", async () => {
    const result = await gate(
      "SELECT COUNT(DISTINCT o.order_id) AS orders, MAX(p.amount) AS top FROM orders o JOIN order_items i ON i.order_id = o.order_id JOIN payments p ON p.order_id = o.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
  });

  it("allows the canonical new-customers CTE filtered on first_purchase", async () => {
    const result = await gate(
      "WITH first_orders AS (SELECT o.customer_id, MIN(o.purchase_date) AS first_purchase FROM orders o WHERE o.status = 'delivered' GROUP BY o.customer_id) SELECT COUNT(*) AS new_customers FROM first_orders fo WHERE fo.first_purchase >= '2026-01-01' AND fo.first_purchase < '2026-04-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
  });

  it("does not treat a scalar function as an aggregate bypass", async () => {
    const result = await gate(
      "SELECT LOWER(status) FROM orders",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("does not let an aggregate CTE bypass an outer detail scan", async () => {
    const result = await gate(
      "WITH customer_count AS (SELECT COUNT(*) AS n FROM customers) SELECT LOWER(status) FROM orders",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("does not treat a string literal as a purchase_date range", async () => {
    const result = await gate(
      "SELECT id FROM orders WHERE status = 'purchase_date'",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("does not treat IS NOT NULL as a purchase_date range", async () => {
    const result = await gate(
      "SELECT id FROM orders WHERE purchase_date IS NOT NULL",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("does not accept a purchase_date predicate hidden behind OR", async () => {
    const result = await gate(
      "SELECT id FROM orders WHERE status = 'ok' OR purchase_date > '1900-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("needs_clarification");
  });

  it("allows order_items only when its parent orders time filter is present", async () => {
    const result = await gate(
      "SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("pass");
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

  it("denies SUM over a column on the '1' side of a 1:N join", async () => {
    const result = await gate(
      "SELECT SUM(o.total) AS total_revenue FROM orders o JOIN order_items i ON i.order_id = o.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("INVALID_SQL");
    expect(result.error.message).toContain("1:N join");
  });

  it("denies AVG over a column on the '1' side of a 1:N join", async () => {
    const result = await gate(
      "SELECT AVG(o.total) AS avg_revenue FROM orders o JOIN order_items i ON i.order_id = o.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("INVALID_SQL");
    expect(result.error.message).toContain("1:N join");
  });

  it("denies COUNT(*) over a 1:N join without grain-safe pre-aggregation", async () => {
    const result = await gate(
      "SELECT COUNT(*) AS order_cnt FROM orders o JOIN order_items i ON i.order_id = o.order_id WHERE o.purchase_date >= '2026-01-01'",
      largeCatalog,
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("INVALID_SQL");
    expect(result.error.message).toContain("1:N join");
  });

  it("denies SUM on custom non-hardcoded tables using FK metadata", async () => {
    const customCatalog: SchemaCatalog = {
      tables: [
        {
          name: "departments",
          schema: "public",
          columns: [col("id"), col("budget")],
        },
        {
          name: "projects",
          schema: "public",
          columns: [col("id"), col("dept_id"), col("cost")],
          foreignKeys: [
            {
              column: "dept_id",
              referencesTable: "departments",
              referencesColumn: "id",
              cardinality: "1:N",
            },
          ],
        },
      ],
    };
    const guard = await sqlGuard(
      "SELECT SUM(d.budget) AS total_budget FROM departments d JOIN projects p ON p.dept_id = d.id",
      customCatalog,
    );
    expect(guard.ok).toBe(true);
    const result = localQuerySafetyGate(
      "SELECT SUM(d.budget) AS total_budget FROM departments d JOIN projects p ON p.dept_id = d.id",
      guard as GuardSuccess,
      customCatalog,
      [],
    );
    expect(result.verdict).toBe("deny");
    if (result.verdict !== "deny") return;
    expect(result.error.code).toBe("INVALID_SQL");
    expect(result.error.message).toContain("departments and projects");
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
