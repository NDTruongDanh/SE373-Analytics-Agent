import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "pgsql-parser";
import {
  DEFAULT_SENSITIVE_COLUMNS,
  loadSensitiveColumns,
  loadSensitiveColumnsFile,
} from "../src/sensitive-columns.js";
import { redactPII, redactRow } from "../src/redactor.js";
import { sqlGuard, warmupSqlGuard } from "../src/guard.js";
import {
  ColumnScopePolicy,
  PolicyError,
  resolveColumns,
} from "../src/policy.js";
import type { Principal } from "../src/policy.js";
import { fixtureCatalog } from "./fixtures.js";

const VALID_YAML = `version: 1
columns:
  - table: customers
    column: phone
  - table: customers
    column: email
  - table: customers
    column: address
  - table: employees
    column: salary
`;

describe("loadSensitiveColumns", () => {
  it("parses the valid fixture with all four reference columns", () => {
    const parsed = loadSensitiveColumns(VALID_YAML);
    expect(parsed.version).toBe(1);
    expect(parsed.columns).toHaveLength(4);
    expect(parsed.columns).toContainEqual({
      table: "customers",
      column: "phone",
    });
    expect(parsed.columns).toContainEqual({
      table: "employees",
      column: "salary",
    });
  });

  it("exposes the v1 reference set as the default list", () => {
    expect(DEFAULT_SENSITIVE_COLUMNS.version).toBe(1);
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "customers",
      column: "phone",
    });
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "customers",
      column: "email",
    });
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "customers",
      column: "address",
    });
    expect(DEFAULT_SENSITIVE_COLUMNS.columns).toContainEqual({
      table: "employees",
      column: "salary",
    });
  });

  it("rejects a missing version", () => {
    expect(() =>
      loadSensitiveColumns("columns:\n  - table: customers\n    column: phone\n"),
    ).toThrow();
  });

  it("rejects a wrong version literal", () => {
    expect(() =>
      loadSensitiveColumns(
        "version: 2\ncolumns:\n  - table: customers\n    column: phone\n",
      ),
    ).toThrow();
  });

  it("rejects a missing columns array", () => {
    expect(() => loadSensitiveColumns("version: 1\n")).toThrow();
  });

  it("rejects an empty table name", () => {
    expect(() =>
      loadSensitiveColumns(
        'version: 1\ncolumns:\n  - table: ""\n    column: phone\n',
      ),
    ).toThrow();
  });

  it("rejects an empty column name", () => {
    expect(() =>
      loadSensitiveColumns(
        "version: 1\ncolumns:\n  - table: customers\n    column: ''\n",
      ),
    ).toThrow();
  });

  it("rejects extra keys via strictness", () => {
    expect(() =>
      loadSensitiveColumns(`${VALID_YAML}owner: someone\n`),
    ).toThrow();
    expect(() =>
      loadSensitiveColumns(
        "version: 1\ncolumns:\n  - table: customers\n    column: phone\n    scope: pii\n",
      ),
    ).toThrow();
  });

  it("rejects malformed YAML", () => {
    expect(() => loadSensitiveColumns("version: [1\ncolumns: :\n")).toThrow();
    expect(() => loadSensitiveColumns("")).toThrow();
    expect(() => loadSensitiveColumns("version: 1\n\tcolumns: []\n")).toThrow();
  });

  it("loads through the file wrapper with an explicit override path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sens-"));
    const file = join(dir, "sensitive_columns.yaml");
    writeFileSync(file, VALID_YAML);
    const parsed = loadSensitiveColumnsFile(file);
    expect(parsed.columns).toHaveLength(4);
    const viaEnv = loadSensitiveColumnsFile("/nonexistent.yaml", file);
    expect(viaEnv.columns).toHaveLength(4);
  });
});

describe("redactPII", () => {
  const phones = [
    "0901 234 567", // mobile spaced
    "0901234567", // mobile compact
    "032 123 4567", // mobile 03 spaced
    "0587654321", // mobile 05 compact
    "0285 8212 0590", // landline spaced
    "028582120590", // landline compact
    "024 0590 1799", // national 024 spaced
    "+84901234567", // international compact
    "+84 901 234 567", // international spaced
  ];

  it.each(phones)("masks phone shape %s", (phone) => {
    const { redacted, hit } = redactPII(`lien he ${phone} nhe`);
    expect(hit).toBe(true);
    expect(redacted).toContain("[MASKED_PHONE]");
    expect(redacted).not.toContain(phone);
  });

  it("masks dotted and dashed phone separators", () => {
    for (const phone of ["0901.234.567", "0901-234-567"]) {
      const { redacted, hit } = redactPII(phone);
      expect(hit).toBe(true);
      expect(redacted).not.toContain(phone);
      expect(redacted).toContain("[MASKED_PHONE]");
    }
  });

  it("masks email addresses", () => {
    const { redacted, hit } = redactPII("mail lan@example.com di");
    expect(hit).toBe(true);
    expect(redacted).toContain("[MASKED_EMAIL]");
    expect(redacted).not.toContain("lan@example.com");
  });

  it("masks phones and emails together in one pass", () => {
    const { redacted, hit } = redactPII("0901 234 567 lan@example.com");
    expect(hit).toBe(true);
    expect(redacted).toContain("[MASKED_PHONE]");
    expect(redacted).toContain("[MASKED_EMAIL]");
    expect(redacted).not.toContain("0901");
    expect(redacted).not.toContain("lan@example.com");
  });

  it("leaves clean text byte-identical with hit false", () => {
    const clean = "don hang 123 da giao thanh cong";
    const { redacted, hit } = redactPII(clean);
    expect(hit).toBe(false);
    expect(redacted).toBe(clean);
  });
});

describe("redactRow", () => {
  it("masks string cells in place and reports a row-level hit", () => {
    const row: Record<string, unknown> = {
      id: 7,
      name: "Nguyen Van A",
      phone: "0901 234 567",
      email: "a@example.com",
      total: 120.5,
      active: true,
      meta: null,
    };
    const { row: out, hit } = redactRow(row);
    expect(hit).toBe(true);
    expect(out).toBe(row);
    expect(out["phone"]).toBe("[MASKED_PHONE]");
    expect(out["email"]).toBe("[MASKED_EMAIL]");
    expect(out["id"]).toBe(7);
    expect(out["name"]).toBe("Nguyen Van A");
    expect(out["total"]).toBe(120.5);
    expect(out["active"]).toBe(true);
    expect(out["meta"]).toBeNull();
  });

  it("passes non-string cells through untouched with hit false", () => {
    const row: Record<string, unknown> = { id: 1, total: 9.99 };
    const { row: out, hit } = redactRow(row);
    expect(hit).toBe(false);
    expect(out).toEqual({ id: 1, total: 9.99 });
  });
});

const READER: Principal = {
  userId: "u-quan",
  role: "marketing",
  scopes: ["schema:read", "data:read"],
};

const SENSITIVE_READER: Principal = {
  ...READER,
  scopes: ["schema:read", "data:read", "data:sensitive"],
};

async function guarded(sql: string) {
  await warmupSqlGuard();
  const ast = await parse(sql);
  return { ast, sql };
}

describe("resolveColumns", () => {
  it("expands a bare star into one projection ref per column", async () => {
    const { ast } = await guarded("SELECT * FROM customers");
    const refs = resolveColumns(ast, fixtureCatalog);
    expect(refs).toHaveLength(7);
    expect(refs.every((r) => r.table === "customers")).toBe(true);
    expect(refs.every((r) => r.clause === "projection")).toBe(true);
    const phone = refs.find((r) => r.column === "phone");
    expect(phone?.sensitive).toBe(true);
    expect(refs.find((r) => r.column === "city")?.sensitive).toBe(false);
  });

  it("expands a qualified star through an alias", async () => {
    const { ast } = await guarded("SELECT c.* FROM customers c");
    const refs = resolveColumns(ast, fixtureCatalog);
    expect(refs).toHaveLength(7);
    expect(refs.every((r) => r.table === "customers")).toBe(true);
  });

  it("resolves aliases and classifies join refs", async () => {
    const { ast } = await guarded(
      "SELECT c.region, count(*) AS n FROM customers c JOIN orders o ON c.id = o.customer_id WHERE o.status = 'x' GROUP BY c.region HAVING count(*) > 1 ORDER BY n",
    );
    const refs = resolveColumns(ast, fixtureCatalog);
    const by = (table: string, column: string, clause: string) =>
      refs.find((r) => r.table === table && r.column === column && r.clause === clause);
    expect(by("customers", "region", "projection")).toBeDefined();
    expect(by("customers", "id", "join")).toBeDefined();
    expect(by("orders", "customer_id", "join")).toBeDefined();
    expect(by("orders", "status", "where")).toBeDefined();
    expect(by("customers", "region", "group")).toBeDefined();
    // ORDER BY n hits the select-list alias over count(*): non-sensitive.
    const orderN = refs.find((r) => r.clause === "order");
    expect(orderN?.sensitive).toBe(false);
  });

  it("resolves a 1-level CTE through its inner FROM", async () => {
    const { ast } = await guarded(
      "WITH c AS (SELECT phone, name FROM customers) SELECT phone FROM c",
    );
    const refs = resolveColumns(ast, fixtureCatalog);
    expect(refs).toContainEqual({
      table: "customers",
      column: "phone",
      clause: "projection",
      sensitive: true,
    });
  });

  it("denies ambiguous unqualified columns fail-closed", async () => {
    const { ast } = await guarded(
      "SELECT id FROM customers JOIN orders ON customers.id = orders.customer_id",
    );
    expect(() => resolveColumns(ast, fixtureCatalog)).toThrow(/Ambiguous/);
  });

  it("denies unknown qualifiers fail-closed", async () => {
    const { ast } = await guarded("SELECT x.phone FROM customers");
    expect(() => resolveColumns(ast, fixtureCatalog)).toThrow(/Unknown qualifier/);
  });

  it("denies multi-level CTEs fail-closed", async () => {
    const { ast } = await guarded(
      "WITH a AS (SELECT id FROM sellers), b AS (SELECT id FROM a) SELECT id FROM b",
    );
    expect(() => resolveColumns(ast, fixtureCatalog)).toThrow(PolicyError);
    expect(() => resolveColumns(ast, fixtureCatalog)).toThrow(/Multi-level CTE/);
  });

  it("denies LATERAL touching sensitive tables fail-closed", async () => {
    const { ast } = await guarded(
      "SELECT * FROM sellers, LATERAL (SELECT id FROM customers) x",
    );
    expect(() => resolveColumns(ast, fixtureCatalog)).toThrow(/LATERAL/);
  });

  it("allows LATERAL over tables without sensitive columns", async () => {
    const { ast } = await guarded(
      "SELECT s.id FROM sellers, LATERAL (SELECT id FROM orders) s",
    );
    const refs = resolveColumns(ast, fixtureCatalog);
    expect(refs).toContainEqual({
      table: "orders",
      column: "id",
      clause: "projection",
      sensitive: false,
    });
  });

  it("denies refs against non-enumerable subquery outputs", async () => {
    const { ast } = await guarded(
      "SELECT s.a FROM (SELECT id AS a FROM sellers UNION SELECT id FROM sellers) s",
    );
    expect(() => resolveColumns(ast, fixtureCatalog)).toThrow(/enumerate/);
  });
});

describe("ColumnScopePolicy.check", () => {
  it("masks a sensitive projection and re-guards clean with output names preserved", async () => {
    const sql = "SELECT name, phone, email FROM customers";
    const { ast } = await guarded(sql);
    const policy = new ColumnScopePolicy();
    const result = await policy.check({ ast, sql, catalog: fixtureCatalog, principal: READER });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.maskedColumns).toEqual(["customers.email", "customers.phone"]);
    expect(result.sql).toContain("****");
    // Output names preserved: the deparsed select list still yields one
    // output per input, with PG's labels (alias or bare column name).
    const reparsed = await parse(result.sql);
    const targetList = (
      reparsed as unknown as {
        stmts: { stmt: { SelectStmt: { targetList: { ResTarget: { name?: string; val?: unknown } }[] } } }[];
      }
    ).stmts[0]?.stmt.SelectStmt.targetList.map((t) => {
      if (t.ResTarget.name !== undefined) return t.ResTarget.name;
      const fields = (t.ResTarget.val as { ColumnRef?: { fields?: { String?: { sval?: string } }[] } })?.ColumnRef?.fields;
      const last = Array.isArray(fields) ? fields[fields.length - 1] : undefined;
      return last?.String?.sval;
    });
    expect(targetList).toEqual(["name", "phone", "email"]);
    // Re-guard the rewritten SQL clean.
    const reguard = await sqlGuard(result.sql, fixtureCatalog);
    expect(reguard.ok).toBe(true);
    expect(result.sql).not.toMatch(/0901|lan@example/);
  });

  it("masks numeric sensitive columns with a typed null cast", async () => {
    const sql = "SELECT name, salary FROM employees";
    const { ast } = await guarded(sql);
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: READER,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.maskedColumns).toEqual(["employees.salary"]);
    expect(result.sql).toContain("NULL::numeric");
  });

  it("expands stars with masking applied and keeps column order", async () => {
    const sql = "SELECT * FROM customers";
    const { ast } = await guarded(sql);
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: READER,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.maskedColumns).toEqual([
      "customers.address",
      "customers.email",
      "customers.phone",
    ]);
    const reparsed = await parse(result.sql);
    const targetList = (
      reparsed as unknown as {
        stmts: { stmt: { SelectStmt: { targetList: { ResTarget: { name?: string } }[] } } }[];
      }
    ).stmts[0]?.stmt.SelectStmt.targetList.map((t) => t.ResTarget.name);
    expect(targetList).toEqual(["id", "name", "phone", "email", "address", "city", "region"]);
    const reguard = await sqlGuard(result.sql, fixtureCatalog);
    expect(reguard.ok).toBe(true);
  });

  it("passes sensitive projections through untouched with data:sensitive", async () => {
    const sql = "SELECT phone FROM customers";
    const { ast } = await guarded(sql);
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: SENSITIVE_READER,
    });
    expect(result).toEqual({ allowed: true, sql, maskedColumns: [] });
  });

  it("denies sensitive refs in WHERE without data:sensitive", async () => {
    const sql = "SELECT name FROM customers WHERE phone = '0901 234 567'";
    const { ast } = await guarded(sql);
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: READER,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.error.code).toBe("SENSITIVE_COLUMN_DENIED");
    // Frozen routing: sensitivity denies are hard policy outcomes, neither
    // retryable nor repairable (REPAIRABLE_CODES covers parse/lookup errors).
    expect(result.error.repairable).toBe(false);
    expect(result.error.retryable).toBe(false);
  });

  it("denies sensitive refs inside aggregates without data:sensitive", async () => {
    const sql = "SELECT sum(salary) FROM employees";
    const { ast } = await guarded(sql);
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: READER,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.error.code).toBe("SENSITIVE_COLUMN_DENIED");
  });

  it("allows the same clause and aggregate refs with data:sensitive", async () => {
    for (const sql of [
      "SELECT name FROM customers WHERE phone = '0901 234 567'",
      "SELECT sum(salary) FROM employees",
    ]) {
      const { ast } = await guarded(sql);
      const result = await new ColumnScopePolicy().check({
        ast,
        sql,
        catalog: fixtureCatalog,
        principal: SENSITIVE_READER,
      });
      expect(result.allowed).toBe(true);
    }
  });

  it("injects aliased row-scope predicates on a join", async () => {
    const sql =
      "SELECT c.region FROM customers c JOIN sellers s ON c.region = s.region";
    const { ast } = await guarded(sql);
    const scoped: Principal = { ...READER, rowScope: { column: "region", value: "Nam" } };
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: scoped,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.sql).toContain("c.region = 'Nam'");
    expect(result.sql).toContain("s.region = 'Nam'");
    const reguard = await sqlGuard(result.sql, fixtureCatalog);
    expect(reguard.ok).toBe(true);
  });

  it("denies row-scope placement on a self-join as ambiguous", async () => {
    const sql = "SELECT a.id FROM sellers a JOIN sellers b ON a.id = b.id";
    const { ast } = await guarded(sql);
    const scoped: Principal = { ...READER, rowScope: { column: "region", value: "Nam" } };
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: scoped,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
  });

  it("denies row-scope over opaque subquery refs", async () => {
    // s is enumerable (outer refs resolve), x is a set-opaque subquery over
    // the scoped table: placement cannot be verified, so deny fail-closed.
    const sql =
      "SELECT s.id FROM (SELECT id FROM customers) s, (SELECT id FROM sellers UNION SELECT id FROM customers) x";
    const { ast } = await guarded(sql);
    const scoped: Principal = { ...READER, rowScope: { column: "region", value: "Nam" } };
    const result = await new ColumnScopePolicy().check({
      ast,
      sql,
      catalog: fixtureCatalog,
      principal: scoped,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
  });
});
