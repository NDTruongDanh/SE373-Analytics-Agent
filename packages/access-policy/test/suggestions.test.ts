import { describe, expect, it } from "vitest";
import type { SchemaCatalog } from "@shared/contracts";
import { sqlGuard, suggestSqlIdentifiers } from "../src/guard.js";

const catalog: SchemaCatalog = {
  tables: [
    {
      name: "orders", schema: "public",
      columns: [
        { name: "id", type: "integer", nullable: false, sensitive: false, large: false },
        { name: "purchase_date", type: "timestamp", nullable: false, sensitive: false, large: false },
        { name: "status", type: "text", nullable: false, sensitive: false, large: false },
      ],
    },
    {
      name: "customers", schema: "public",
      columns: [
        { name: "name", type: "text", nullable: true, sensitive: true, large: false },
        { name: "phone", type: "text", nullable: true, sensitive: true, large: false },
        { name: "email", type: "text", nullable: true, sensitive: true, large: false },
        { name: "address", type: "text", nullable: true, sensitive: true, large: false },
        { name: "region", type: "text", nullable: true, sensitive: false, large: false },
      ],
    },
    {
      name: "employees", schema: "public",
      columns: [
        { name: "salary", type: "integer", nullable: false, sensitive: true, large: false },
        { name: "dept", type: "text", nullable: false, sensitive: false, large: false },
      ],
    },
    { name: "pg_catalog", schema: "pg_catalog", columns: [] },
  ],
};

describe("SQL identifier suggestions", () => {
  it("suggests nearby public tables and columns in stable order", async () => {
    const table = await sqlGuard("SELECT id FROM ordres", catalog);
    expect(table.ok).toBe(false);
    if (!table.ok) expect(table.error.message).toContain("did you mean: orders");

    const qualified = await sqlGuard("SELECT o.purchas_date FROM orders o", catalog);
    expect(qualified.ok).toBe(false);
    if (!qualified.ok) expect(qualified.error.message).toContain("did you mean: purchase_date");

    const bare = await sqlGuard("SELECT statu FROM orders", catalog);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.message).toContain("did you mean: status");

    expect(suggestSqlIdentifiers("cat", [
      { name: "catch" }, { name: "category" }, { name: "catalog" }, { name: "cater" },
    ])).toEqual(["catalog", "catch", "category"]);
  });

  it("uses folded Vietnamese aliases and never suggests sensitive or system names", async () => {
    const aliased = await sqlGuard("SELECT ngay_mua FROM orders", catalog, {
      aliases: { columns: { orders: { purchase_date: ["ngày mua hàng"] } } },
    });
    expect(aliased.ok).toBe(false);
    if (!aliased.ok) expect(aliased.error.message).toContain("purchase_date");

    for (const [table, column] of [
      ["customers", "nam"], ["customers", "phon"], ["customers", "emai"],
      ["customers", "addres"], ["employees", "salar"],
    ]) {
      const result = await sqlGuard(`SELECT ${column} FROM ${table}`, catalog);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).not.toMatch(/did you mean: (name|phone|email|address|salary)/);
    }
    const system = await sqlGuard("SELECT * FROM pg_catalo", catalog);
    expect(system.ok).toBe(false);
    if (!system.ok) expect(system.error.message).not.toContain("did you mean: pg_catalog");
  });
});
