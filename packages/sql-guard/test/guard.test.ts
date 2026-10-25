import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "pgsql-parser";
import { sqlGuard, warmupSqlGuard } from "../src/guard.js";
import { fixtureCatalog } from "./fixtures.js";

describe("sqlGuard valid shapes", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("V1 accepts a no-FROM baseline", async () => {
    const result = await sqlGuard("SELECT 1", fixtureCatalog);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual([]);
    }
  });

  it("V2 accepts alias plus qualified refs", async () => {
    const result = await sqlGuard(
      "SELECT o.id, o.total FROM orders o WHERE o.total > 100",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V3 accepts a JOIN", async () => {
    const result = await sqlGuard(
      "SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["customers", "orders"]);
    }
  });

  it("V4a accepts UNION across both branches", async () => {
    const result = await sqlGuard(
      "SELECT id FROM customers UNION SELECT id FROM orders",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["customers", "orders"]);
    }
  });

  it("V4b accepts UNION ALL across both branches", async () => {
    const result = await sqlGuard(
      "SELECT id FROM customers UNION ALL SELECT id FROM orders",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["customers", "orders"]);
    }
  });

  it("V5 accepts a single-level WITH", async () => {
    const result = await sqlGuard(
      "WITH regional AS (SELECT status, sum(total) s FROM orders GROUP BY status) SELECT * FROM regional",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V6 accepts a subquery with alias", async () => {
    const result = await sqlGuard(
      "SELECT * FROM (SELECT id, total FROM orders) AS sub",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V7 accepts DISTINCT ON with LIMIT and OFFSET", async () => {
    const result = await sqlGuard(
      "SELECT DISTINCT ON (customer_id) customer_id, total FROM orders ORDER BY customer_id, total DESC LIMIT 5 OFFSET 2",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V8 accepts a window function", async () => {
    const result = await sqlGuard(
      "SELECT row_number() OVER (PARTITION BY customer_id ORDER BY total) FROM orders",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V9 accepts grouped aggregates with star-count", async () => {
    const result = await sqlGuard(
      "SELECT status, count(*), avg(total) FROM orders GROUP BY status HAVING count(*) > 1",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V10 accepts a public-schema-qualified table", async () => {
    const result = await sqlGuard(
      "SELECT * FROM public.orders",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V11 accepts quoted mixed-case identifiers via exact-first lowercase-fallback", async () => {
    const result = await sqlGuard(
      'SELECT "Total" FROM "orders"',
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V12a accepts a trailing comment as one statement", async () => {
    const result = await sqlGuard(
      "SELECT 1 -- trailing comment",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual([]);
    }
  });

  it("V12b accepts a block comment as one statement", async () => {
    const result = await sqlGuard("SELECT /* hidden */ 1", fixtureCatalog);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual([]);
    }
  });

  it("V13 accepts TABLE shorthand", async () => {
    const result = await sqlGuard("TABLE orders", fixtureCatalog);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });

  it("V14 accepts uppercase-keyword case variation", async () => {
    const result = await sqlGuard(
      "SeLeCt ID, total FrOm Orders WhErE total > 10",
      fixtureCatalog,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tables).toEqual(["orders"]);
    }
  });
});

describe("parser version tripwire", () => {
  it("parsed AST version line starts with 18", async () => {
    const ast = await parse("SELECT 1");
    expect(String(ast.version)).toMatch(/^18/);
  });
});
