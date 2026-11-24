import { describe, expect, it } from "vitest";
import { sqlGuard, warmupSqlGuard } from "../src/guard.js";
import { ColumnScopePolicy, resolveColumns, type Principal } from "../src/policy.js";
import { fixtureCatalog } from "./fixtures.js";

const READER: Principal = { userId: "u", role: "marketing", scopes: ["schema:read", "data:read"] };
const SENSITIVE: Principal = {
  userId: "u",
  role: "admin",
  scopes: ["schema:read", "data:read", "data:sensitive"],
};

async function check(sql: string, principal: Principal = READER) {
  await warmupSqlGuard();
  const guard = await sqlGuard(sql, fixtureCatalog);
  if (!guard.ok) throw new Error(`guard rejected fixture SQL: ${guard.error.message}`);
  return new ColumnScopePolicy().check({ ast: guard.ast, sql, catalog: fixtureCatalog, principal });
}

describe("subqueries outside FROM", () => {
  it.each([
    ["IN (SELECT …)", "SELECT p.id FROM products p WHERE p.id IN (SELECT i.product_id FROM order_items i)"],
    ["EXISTS", "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.status = 'paid')"],
    [
      "correlated EXISTS",
      "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)",
    ],
    [
      "correlated unqualified outer column",
      "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = city::integer)",
    ],
    ["scalar subquery in WHERE", "SELECT o.id FROM orders o WHERE o.total > (SELECT AVG(o2.total) FROM orders o2)"],
    ["scalar subquery in SELECT", "SELECT (SELECT COUNT(o.id) FROM orders o WHERE o.status = 'paid') AS n"],
    ["subquery in HAVING", "SELECT o.status FROM orders o GROUP BY o.status HAVING COUNT(*) > (SELECT COUNT(p.id) FROM products p)"],
    [
      "subquery inside a CTE body",
      "WITH big AS (SELECT o.id FROM orders o WHERE o.customer_id IN (SELECT c.id FROM customers c WHERE c.city = 'HN')) SELECT big.id FROM big",
    ],
    [
      "nested subqueries",
      "SELECT p.id FROM products p WHERE p.id IN (SELECT i.product_id FROM order_items i WHERE i.order_id IN (SELECT o.id FROM orders o))",
    ],
  ])("allows %s", async (_label, sql) => {
    const result = await check(sql);
    expect(result).toEqual({ allowed: true, sql, maskedColumns: [], rowScopeApplied: [] });
  });

  it("allows ordering by the alias of a correlated scalar subquery", async () => {
    const sql =
      "SELECT p.name, (SELECT COUNT(*) FROM order_items i WHERE i.product_id = p.id) AS sold FROM products p ORDER BY sold DESC LIMIT 2";
    const result = await check(sql);
    expect(result).toEqual({ allowed: true, sql, maskedColumns: [], rowScopeApplied: [] });
  });

  it("still denies ordering by the alias of a sensitive scalar subquery", async () => {
    const result = await check(
      "SELECT (SELECT c.phone FROM customers c WHERE c.id = o.customer_id) AS p FROM orders o ORDER BY p",
    );
    expect(result).toMatchObject({ allowed: false, error: { code: "SENSITIVE_COLUMN_DENIED" } });
  });

  it("resolves the inner table before the outer one for a shared column name", async () => {
    await warmupSqlGuard();
    const sql = "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM products p WHERE name = 'x')";
    const guard = await sqlGuard(sql, fixtureCatalog);
    if (!guard.ok) throw new Error(guard.error.message);
    const refs = resolveColumns(guard.ast, fixtureCatalog);
    expect(refs).toContainEqual({ table: "products", column: "name", clause: "where", sensitive: false });
  });

  it("denies a sensitive column in a subquery WHERE", async () => {
    const result = await check(
      "SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.phone LIKE '09%')",
    );
    expect(result).toMatchObject({ allowed: false, error: { code: "SENSITIVE_COLUMN_DENIED" } });
  });

  it("denies a sensitive column in a subquery's own select list instead of masking it", async () => {
    const result = await check(
      "SELECT o.id FROM orders o WHERE '0901234567' IN (SELECT c.phone FROM customers c)",
    );
    expect(result).toMatchObject({ allowed: false, error: { code: "SENSITIVE_COLUMN_DENIED" } });
  });

  it("denies a sensitive scalar subquery in the outer select list", async () => {
    const result = await check("SELECT (SELECT c.phone FROM customers c LIMIT 1) AS p");
    expect(result).toMatchObject({ allowed: false, error: { code: "SENSITIVE_COLUMN_DENIED" } });
  });

  it("denies a star over sensitive columns inside a subquery", async () => {
    const result = await check(
      "SELECT o.id FROM orders o WHERE EXISTS (SELECT * FROM customers c WHERE c.id = o.customer_id)",
    );
    expect(result).toMatchObject({ allowed: false, error: { code: "SENSITIVE_COLUMN_DENIED" } });
  });

  it("allows sensitive subquery columns for data:sensitive", async () => {
    const result = await check(
      "SELECT o.id FROM orders o WHERE '0901234567' IN (SELECT c.phone FROM customers c)",
      SENSITIVE,
    );
    expect(result.allowed).toBe(true);
  });

  it("still fails closed on an unknown outer qualifier", async () => {
    const result = await check(
      "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.id = c.id)",
    );
    expect(result.allowed).toBe(true);
    const unknown = await sqlGuard(
      "SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = zz.id)",
      fixtureCatalog,
    );
    if (unknown.ok) {
      const denied = await new ColumnScopePolicy().check({
        ast: unknown.ast,
        sql: "",
        catalog: fixtureCatalog,
        principal: READER,
      });
      expect(denied).toMatchObject({ allowed: false, error: { code: "UNKNOWN_TABLE" } });
    } else {
      expect(unknown.error.code).toBe("UNKNOWN_TABLE");
    }
  });

  it("does not let a FROM subquery see the outer query", async () => {
    await warmupSqlGuard();
    const guard = await sqlGuard(
      "SELECT c.id FROM customers c JOIN (SELECT o.customer_id FROM orders o WHERE o.customer_id = c.id) x ON x.customer_id = c.id",
      fixtureCatalog,
    );
    if (!guard.ok) {
      expect(guard.error.code).toBe("UNKNOWN_TABLE");
      return;
    }
    const result = await new ColumnScopePolicy().check({
      ast: guard.ast,
      sql: "",
      catalog: fixtureCatalog,
      principal: READER,
    });
    expect(result).toMatchObject({ allowed: false, error: { code: "UNKNOWN_TABLE" } });
  });

  it("applies row scope inside a subquery", async () => {
    const sql = "SELECT o.id FROM orders o WHERE o.customer_id IN (SELECT c.id FROM customers c)";
    const result = await check(sql, { ...READER, rowScope: { column: "region", value: "Nam" } });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql.replace(/\s+/g, " ")).toContain("c.region = 'Nam'");
    expect(result.rowScopeApplied).toEqual([{ table: "customers", column: "region" }]);
  });
});
