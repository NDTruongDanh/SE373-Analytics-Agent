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

async function expectReject(sql: string, code: string): Promise<void> {
  const result = await sqlGuard(sql, fixtureCatalog);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}

describe("sqlGuard malicious matrix", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("M1 rejects DELETE with FORBIDDEN_STATEMENT", async () => {
    await expectReject("DELETE FROM orders", "FORBIDDEN_STATEMENT");
  });

  it("M2a rejects UPDATE with FORBIDDEN_STATEMENT", async () => {
    await expectReject("UPDATE orders SET total = 0", "FORBIDDEN_STATEMENT");
  });

  it("M2b rejects INSERT with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "INSERT INTO orders (id, total) VALUES (1, 10)",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M3 rejects stacked statements with FORBIDDEN_STATEMENT", async () => {
    await expectReject("SELECT 1; DROP TABLE orders", "FORBIDDEN_STATEMENT");
  });

  it("M4 rejects two benign statements with FORBIDDEN_STATEMENT", async () => {
    await expectReject("SELECT 1; SELECT 2", "FORBIDDEN_STATEMENT");
  });

  it("M5 rejects a comment-hidden second statement", async () => {
    await expectReject(
      "SELECT 1; -- note\nDROP TABLE orders",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M6 rejects a CTE-wrapped DELETE", async () => {
    await expectReject(
      "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M7a rejects a CTE-wrapped INSERT", async () => {
    await expectReject(
      "WITH x AS (INSERT INTO orders (id, total) VALUES (1, 10) RETURNING *) SELECT * FROM x",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M7b rejects a CTE-wrapped UPDATE", async () => {
    await expectReject(
      "WITH x AS (UPDATE orders SET total = 0 RETURNING *) SELECT * FROM x",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M8 rejects a nested-CTE DELETE", async () => {
    await expectReject(
      "WITH a AS (WITH b AS (DELETE FROM orders RETURNING *) SELECT * FROM b) SELECT * FROM a",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M9a rejects SELECT INTO with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "SELECT * INTO new_table FROM orders",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M9b rejects SELECT INTO TEMP with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "SELECT * INTO TEMP tmp FROM orders",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M9c rejects SELECT INTO UNLOGGED with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "SELECT * INTO UNLOGGED TABLE foo FROM orders",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M10a rejects FOR UPDATE with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "SELECT * FROM orders FOR UPDATE",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M10b rejects FOR SHARE with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "SELECT * FROM orders FOR SHARE",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M10c rejects FOR UPDATE NOWAIT with FORBIDDEN_STATEMENT", async () => {
    await expectReject(
      "SELECT * FROM orders FOR UPDATE NOWAIT",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M11 rejects pg_sleep with FORBIDDEN_FUNCTION", async () => {
    await expectReject("SELECT pg_sleep(600)", "FORBIDDEN_FUNCTION");
  });

  it("M12 rejects schema-qualified case-varied PG_SLEEP", async () => {
    await expectReject("SELECT PG_CATALOG.PG_SLEEP(1)", "FORBIDDEN_FUNCTION");
  });

  it("M13a rejects pg_read_file", async () => {
    await expectReject(
      "SELECT pg_read_file('/etc/passwd')",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13b rejects pg_ls_dir", async () => {
    await expectReject("SELECT pg_ls_dir('/tmp')", "FORBIDDEN_FUNCTION");
  });

  it("M13c rejects dblink", async () => {
    await expectReject(
      "SELECT dblink('dbname=test', $$SELECT 1$$)",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13d rejects lo_export", async () => {
    await expectReject("SELECT lo_export(123, '/tmp/x')", "FORBIDDEN_FUNCTION");
  });

  it("M13e rejects lo_import", async () => {
    await expectReject("SELECT lo_import('/tmp/x')", "FORBIDDEN_FUNCTION");
  });

  it("M13f rejects set_config", async () => {
    await expectReject(
      "SELECT set_config('search_path', 'public', false)",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13g rejects pg_terminate_backend", async () => {
    await expectReject(
      "SELECT pg_terminate_backend(1234)",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13h rejects pg_cancel_backend", async () => {
    await expectReject(
      "SELECT pg_cancel_backend(1234)",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13i rejects nextval", async () => {
    await expectReject("SELECT nextval('seq')", "FORBIDDEN_FUNCTION");
  });

  it("M13j rejects setval", async () => {
    await expectReject("SELECT setval('seq', 1)", "FORBIDDEN_FUNCTION");
  });

  it("M13k rejects pg_logdir_ls", async () => {
    await expectReject("SELECT pg_logdir_ls()", "FORBIDDEN_FUNCTION");
  });

  it("M13l rejects dblink_exec", async () => {
    await expectReject(
      "SELECT dblink_exec('dbname=test', $$SELECT 1$$)",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13m rejects lo_unlink", async () => {
    await expectReject("SELECT lo_unlink(123)", "FORBIDDEN_FUNCTION");
  });

  it("M13n rejects pg_reload_conf", async () => {
    await expectReject("SELECT pg_reload_conf()", "FORBIDDEN_FUNCTION");
  });

  it("M13o rejects pg_execute_server_program", async () => {
    await expectReject(
      "SELECT pg_execute_server_program('ls')",
      "FORBIDDEN_FUNCTION",
    );
  });

  it("M13p rejects currval", async () => {
    await expectReject("SELECT currval('seq')", "FORBIDDEN_FUNCTION");
  });

  it("M14a rejects COPY TO STDOUT", async () => {
    await expectReject(
      "COPY (SELECT * FROM orders) TO STDOUT",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M14b rejects COPY FROM STDIN", async () => {
    await expectReject("COPY orders FROM STDIN", "FORBIDDEN_STATEMENT");
  });

  it("M15a rejects BEGIN", async () => {
    await expectReject("BEGIN READ ONLY", "FORBIDDEN_STATEMENT");
  });

  it("M15b rejects COMMIT", async () => {
    await expectReject("COMMIT", "FORBIDDEN_STATEMENT");
  });

  it("M15c rejects START TRANSACTION", async () => {
    await expectReject("START TRANSACTION READ ONLY", "FORBIDDEN_STATEMENT");
  });

  it("M16a rejects SET", async () => {
    await expectReject("SET statement_timeout = 0", "FORBIDDEN_STATEMENT");
  });

  it("M16b rejects SET LOCAL", async () => {
    await expectReject(
      "SET LOCAL statement_timeout = 0",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M16c rejects RESET", async () => {
    await expectReject("RESET statement_timeout", "FORBIDDEN_STATEMENT");
  });

  it("M16d rejects SET ROLE", async () => {
    await expectReject("SET ROLE x", "FORBIDDEN_STATEMENT");
  });

  it("M16e rejects SET SESSION AUTHORIZATION", async () => {
    await expectReject("SET SESSION AUTHORIZATION x", "FORBIDDEN_STATEMENT");
  });

  it("M17 rejects SHOW with FORBIDDEN_STATEMENT", async () => {
    await expectReject("SHOW server_version", "FORBIDDEN_STATEMENT");
  });

  it("M18a rejects EXPLAIN", async () => {
    await expectReject("EXPLAIN SELECT * FROM orders", "FORBIDDEN_STATEMENT");
  });

  it("M18b rejects EXPLAIN ANALYZE", async () => {
    await expectReject(
      "EXPLAIN ANALYZE SELECT * FROM orders",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M19a rejects CREATE TABLE", async () => {
    await expectReject("CREATE TABLE x(a int)", "FORBIDDEN_STATEMENT");
  });

  it("M19b rejects CREATE TEMP TABLE", async () => {
    await expectReject(
      "CREATE TEMP TABLE tmp(a int)",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M19c rejects DROP TABLE", async () => {
    await expectReject("DROP TABLE orders", "FORBIDDEN_STATEMENT");
  });

  it("M19d rejects TRUNCATE", async () => {
    await expectReject("TRUNCATE orders", "FORBIDDEN_STATEMENT");
  });

  it("M19e rejects GRANT", async () => {
    await expectReject(
      "GRANT SELECT ON orders TO agent_ro",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M19f rejects MERGE", async () => {
    await expectReject(
      "MERGE INTO orders USING customers ON orders.customer_id = customers.id WHEN MATCHED THEN DO NOTHING",
      "FORBIDDEN_STATEMENT",
    );
  });

  it("M20a rejects LISTEN", async () => {
    await expectReject("LISTEN foo", "FORBIDDEN_STATEMENT");
  });

  it("M20b rejects NOTIFY", async () => {
    await expectReject("NOTIFY foo", "FORBIDDEN_STATEMENT");
  });

  it("M20c rejects PREPARE", async () => {
    await expectReject("PREPARE f AS SELECT 1", "FORBIDDEN_STATEMENT");
  });

  it("M20d rejects EXECUTE", async () => {
    await expectReject("EXECUTE f", "FORBIDDEN_STATEMENT");
  });

  it("M20e rejects DEALLOCATE", async () => {
    await expectReject("DEALLOCATE f", "FORBIDDEN_STATEMENT");
  });

  it("M21a rejects pg_catalog with UNKNOWN_TABLE", async () => {
    await expectReject(
      "SELECT * FROM pg_catalog.pg_tables",
      "UNKNOWN_TABLE",
    );
  });

  it("M21b rejects information_schema with UNKNOWN_TABLE", async () => {
    await expectReject(
      "SELECT * FROM information_schema.tables",
      "UNKNOWN_TABLE",
    );
  });

  it("M22 rejects an unknown table with UNKNOWN_TABLE", async () => {
    await expectReject("SELECT * FROM nonexistent", "UNKNOWN_TABLE");
  });

  it("M23 rejects an unknown column with UNKNOWN_TABLE", async () => {
    await expectReject("SELECT nope FROM orders", "UNKNOWN_TABLE");
  });

  it("M24 rejects a quoted injection-style name via catalog miss", async () => {
    await expectReject('SELECT * FROM "orders; --"', "UNKNOWN_TABLE");
  });
});

describe("sqlGuard error shapes", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("rejects empty input with INVALID_SQL carrying a numeric position", async () => {
    const result = await sqlGuard("", fixtureCatalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SQL");
      expect(result.error.message).toMatch(/\d+/);
    }
  });

  it("rejects malformed SELECT with INVALID_SQL carrying a numeric position", async () => {
    const result = await sqlGuard("SELECT FROM WHERE", fixtureCatalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SQL");
      expect(result.error.message).toMatch(/\d+/);
    }
  });
});
