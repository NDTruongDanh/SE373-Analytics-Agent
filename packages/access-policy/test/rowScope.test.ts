import { describe, expect, it } from "vitest";
import { sqlGuard, warmupSqlGuard, type GuardAst } from "../src/guard.js";
import { ColumnScopePolicy, MIN_GROUP_SIZE, type Principal } from "../src/policy.js";
import {
  DEFAULT_ROW_SCOPE_LINEAGE,
  loadRowScopeLineage,
  loadRowScopeLineageFile,
  type RowScopeLineage,
} from "../src/row-scope-lineage.js";
import { fixtureCatalog } from "./fixtures.js";

const LINEAGE: RowScopeLineage = {
  version: 1,
  scopes: {
    region: {
      tables: {
        customers: "direct",
        sellers: "direct",
        orders: { via: "customers", column: "customer_id", parentColumn: "id" },
        order_items: { via: "orders", column: "order_id", parentColumn: "id" },
        payments: { via: "orders", column: "order_id", parentColumn: "id" },
        reviews: { via: "orders", column: "order_id", parentColumn: "id" },
        products: "global",
        categories: "global",
        regions: "global",
        channels: "global",
        promotions: "global",
      },
    },
  },
};

const SCOPED: Principal = {
  userId: "u",
  role: "sales_south",
  scopes: ["schema:read", "data:read"],
  rowScope: { column: "region", value: "Nam" },
};
const READER: Principal = { userId: "u", role: "marketing", scopes: ["schema:read", "data:read"] };
const SENSITIVE: Principal = {
  userId: "u",
  role: "admin",
  scopes: ["schema:read", "data:read", "data:sensitive"],
};

async function guarded(sql: string): Promise<GuardAst> {
  await warmupSqlGuard();
  const guard = await sqlGuard(sql, fixtureCatalog);
  if (!guard.ok) throw new Error(`guard rejected fixture SQL: ${guard.error.message}`);
  return guard.ast;
}

async function check(sql: string, principal: Principal, lineage: RowScopeLineage = LINEAGE) {
  const ast = await guarded(sql);
  const result = await new ColumnScopePolicy(undefined, lineage).check({
    ast,
    sql,
    catalog: fixtureCatalog,
    principal,
  });
  return result.allowed && result.sql !== sql
    ? { ...result, sql: result.sql.replace(/\s+/g, " ").replace(/\( /g, "(") }
    : result;
}

describe("row-scope lineage", () => {
  it("scopes an orders-only national total through customers", async () => {
    const result = await check("SELECT COUNT(*) AS n FROM orders", SCOPED);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain(
      "orders.customer_id IN (SELECT id FROM customers WHERE region = 'Nam')",
    );
    expect(result.rowScopeApplied).toEqual([{ table: "orders", column: "region" }]);
    expect((await sqlGuard(result.sql, fixtureCatalog)).ok).toBe(true);
  });

  it("chains two hops for order_items", async () => {
    const result = await check("SELECT SUM(i.id) AS s FROM order_items i", SCOPED);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain(
      "i.order_id IN (SELECT id FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE region = 'Nam'))",
    );
  });

  it("scopes every arm of a UNION", async () => {
    const result = await check(
      "SELECT id FROM customers UNION ALL SELECT order_id FROM payments",
      SCOPED,
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.rowScopeApplied).toEqual([
      { table: "customers", column: "region" },
      { table: "payments", column: "region" },
    ]);
    expect(result.sql).toContain("region = 'Nam'");
    expect(result.sql).toContain("payments.order_id IN");
  });

  it("scopes a joined via table and leaves global tables alone", async () => {
    const result = await check(
      "SELECT p.id, COUNT(*) AS n FROM products p JOIN order_items i ON i.product_id = p.id GROUP BY p.id",
      SCOPED,
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.rowScopeApplied).toEqual([{ table: "order_items", column: "region" }]);
    expect(result.sql).not.toContain("p.id IN");
  });

  it("scopes a pass-through CTE inside its own query, not at the reference", async () => {
    const result = await check(
      "WITH d AS (SELECT id FROM orders WHERE status = 'delivered') SELECT COUNT(*) AS n FROM d",
      SCOPED,
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain(
      "WHERE status = 'delivered' AND orders.customer_id IN (SELECT id FROM customers WHERE region = 'Nam')",
    );
    expect(result.sql).not.toContain("d.customer_id");
    expect((await sqlGuard(result.sql, fixtureCatalog)).ok).toBe(true);
  });

  it("allows a self-join on a via table because each alias gets its own predicate", async () => {
    const result = await check(
      "SELECT a.id FROM orders a JOIN orders b ON a.id = b.id",
      SCOPED,
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain("a.customer_id IN");
    expect(result.sql).toContain("b.customer_id IN");
  });

  it("denies a table with no declared lineage", async () => {
    const result = await check("SELECT id FROM employees", SCOPED);
    expect(result).toMatchObject({
      allowed: false,
      error: { code: "FORBIDDEN_STATEMENT", message: expect.stringContaining("employees") },
    });
  });

  it("denies a row scope whose column has no lineage at all", async () => {
    const result = await check("SELECT id FROM products", {
      ...SCOPED,
      rowScope: { column: "province", value: "HCM" },
    });
    expect(result).toMatchObject({ allowed: false, error: { code: "FORBIDDEN_STATEMENT" } });
  });

  it("escapes quotes in the server-side scope value", async () => {
    const result = await check("SELECT id FROM customers", {
      ...SCOPED,
      rowScope: { column: "region", value: "N'am" },
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain("region = 'N''am'");
  });

  it("leaves unscoped principals untouched", async () => {
    const sql = "SELECT COUNT(*) AS n FROM orders";
    const result = await check(sql, SENSITIVE);
    expect(result).toEqual({ allowed: true, sql, maskedColumns: [], rowScopeApplied: [] });
  });
});

describe("fail-closed node allowlist", () => {
  it("denies VALUES lists", async () => {
    const result = await check(
      "SELECT v.x FROM (VALUES (1), (2)) AS v(x)",
      SENSITIVE,
    ).catch((error: unknown) => error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/guard rejected/);
      return;
    }
    expect(result).toMatchObject({ allowed: false, error: { code: "FORBIDDEN_STATEMENT" } });
  });

  it("denies LATERAL", async () => {
    const result = await check(
      "SELECT s.id FROM sellers, LATERAL (SELECT id FROM orders) s",
      SENSITIVE,
    );
    expect(result).toMatchObject({
      allowed: false,
      error: { code: "FORBIDDEN_STATEMENT", message: expect.stringContaining("LATERAL") },
    });
  });

  it("denies node types outside the allowlist", async () => {
    const result = await check(
      "SELECT id FROM customers TABLESAMPLE SYSTEM (10)",
      SENSITIVE,
    ).catch((error: unknown) => error);
    if (result instanceof Error) {
      expect(result.message).toMatch(/guard rejected/);
      return;
    }
    expect(result).toMatchObject({
      allowed: false,
      error: { code: "FORBIDDEN_STATEMENT", message: expect.stringContaining("RangeTableSample") },
    });
  });

  it("keeps common read-only constructs allowed", async () => {
    const result = await check(
      "WITH t AS (SELECT o.status, COUNT(*) AS n FROM orders o GROUP BY o.status) " +
        "SELECT t.status, CASE WHEN t.n > 10 THEN 'big' ELSE 'small' END AS size, " +
        "COALESCE(t.n, 0)::float AS n FROM t WHERE t.status IS NOT NULL AND t.status IN ('a', 'b') " +
        "AND t.n BETWEEN 1 AND 100 ORDER BY t.n DESC NULLS LAST LIMIT 5",
      SENSITIVE,
    );
    expect(result.allowed).toBe(true);
  });
});

describe(`group-size floor (k >= ${MIN_GROUP_SIZE})`, () => {
  it("adds HAVING count(*) >= 5 to a root GROUP BY for roles without data:sensitive", async () => {
    const result = await check("SELECT status, COUNT(*) AS n FROM orders GROUP BY status", READER);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain(`HAVING count(*) >= ${MIN_GROUP_SIZE}`);
  });

  it("ANDs the floor with an existing HAVING", async () => {
    const result = await check(
      "SELECT status, COUNT(*) AS n FROM orders GROUP BY status HAVING COUNT(*) > 100",
      READER,
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain("HAVING count(*) > 100 AND count(*) >= 5");
  });

  it("does not touch inner CTE groups or scalar aggregates", async () => {
    const sql =
      "WITH per_order AS (SELECT order_id, COUNT(*) AS items FROM order_items GROUP BY order_id) " +
      "SELECT AVG(per_order.items) AS avg_items FROM per_order";
    const result = await check(sql, READER);
    expect(result).toEqual({ allowed: true, sql, maskedColumns: [], rowScopeApplied: [] });
  });

  it("applies to each grouped arm of a root UNION", async () => {
    const result = await check(
      "SELECT status, COUNT(*) AS n FROM orders GROUP BY status UNION ALL SELECT region, COUNT(*) AS n FROM customers GROUP BY region",
      READER,
    );
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql.match(/HAVING count\(\*\) >= 5/g)).toHaveLength(2);
  });

  it("does not apply to roles with data:sensitive", async () => {
    const sql = "SELECT status, COUNT(*) AS n FROM orders GROUP BY status";
    const result = await check(sql, SENSITIVE);
    expect(result).toEqual({ allowed: true, sql, maskedColumns: [], rowScopeApplied: [] });
  });
});

describe("row-scope lineage loader", () => {
  it("loads the repo policy file equal to the built-in default", () => {
    expect(loadRowScopeLineageFile()).toEqual(DEFAULT_ROW_SCOPE_LINEAGE);
  });

  it("rejects a via chain to an undeclared table, a cycle, and a global root", () => {
    expect(() =>
      loadRowScopeLineage(
        "version: 1\nscopes:\n  r:\n    tables:\n      orders: { via: ghost, column: a, parentColumn: b }\n",
      ),
    ).toThrow(/undeclared/);
    expect(() =>
      loadRowScopeLineage(
        "version: 1\nscopes:\n  r:\n    tables:\n      a: { via: b, column: x, parentColumn: y }\n      b: { via: a, column: x, parentColumn: y }\n",
      ),
    ).toThrow(/cycle/);
    expect(() =>
      loadRowScopeLineage(
        "version: 1\nscopes:\n  r:\n    tables:\n      p: global\n      o: { via: p, column: x, parentColumn: y }\n",
      ),
    ).toThrow(/global/);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      loadRowScopeLineage("version: 1\nscopes:\n  r:\n    tables:\n      a: direct\n    extra: 1\n"),
    ).toThrow();
  });
});
