import type { SchemaCatalog } from "@shared/contracts";

// Shared Olist-modelled fixture catalog for guard tests. Ported from the
// archived Phase 3 reference (origin/feat/phase-3-sql-guard, read via
// git show, never merged — D-06): same 12 tables and columns, rewritten from
// the old record shape (`tables: Record<string, string[]>`) to the CONT-08
// array-of-tables SchemaCatalog the guard and policy both consume
// (`tables: [{name, columns: [{name, type, nullable, sensitive, large}]}]`).
// All names are lowercase: PG folds unquoted identifiers to lowercase, and
// the guard does exact-first / lowercase-fallback lookup (quoted "Total"
// resolves against lowercase `total`).
//
// `sensitive` marks the known PII/salary columns per the v1
// sensitive-columns reference (customers phone/email/address, employees
// salary) so later policy stages see them. `large` is false everywhere here;
// the loader (01-07) decides real large flags from row counts.

function cols(
  entries: Array<
    [name: string, type: string, nullable: boolean, sensitive?: boolean]
  >,
): SchemaCatalog["tables"][number]["columns"] {
  return entries.map(([name, type, nullable, sensitive]) => ({
    name,
    type,
    nullable,
    sensitive: sensitive ?? false,
    large: false,
  }));
}

export const fixtureCatalog: SchemaCatalog = {
  tables: [
    {
      name: "customers",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
        ["phone", "text", true, true],
        ["email", "text", true, true],
        ["address", "text", true, true],
        ["city", "text", true],
        ["region", "text", true],
      ]),
    },
    {
      name: "orders",
      columns: cols([
        ["id", "integer", false],
        ["customer_id", "integer", true],
        ["total", "numeric", true],
        ["status", "text", true],
        ["created_at", "timestamp", true],
      ]),
    },
    {
      name: "order_items",
      columns: cols([
        ["id", "integer", false],
        ["order_id", "integer", true],
        ["product_id", "integer", true],
        ["qty", "integer", true],
        ["price", "numeric", true],
      ]),
    },
    {
      name: "products",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
        ["category_id", "integer", true],
        ["price", "numeric", true],
      ]),
    },
    {
      name: "categories",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
      ]),
    },
    {
      name: "sellers",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
        ["region", "text", true],
      ]),
    },
    {
      name: "payments",
      columns: cols([
        ["order_id", "integer", true],
        ["method", "text", true],
        ["amount", "numeric", true],
      ]),
    },
    {
      name: "reviews",
      columns: cols([
        ["order_id", "integer", true],
        ["rating", "integer", true],
        ["comment", "text", true],
      ]),
    },
    {
      name: "regions",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
      ]),
    },
    {
      name: "channels",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
      ]),
    },
    {
      name: "employees",
      columns: cols([
        ["id", "integer", false],
        ["name", "text", true],
        ["salary", "numeric", true, true],
        ["dept", "text", true],
      ]),
    },
    {
      name: "promotions",
      columns: cols([
        ["id", "integer", false],
        ["code", "text", true],
        ["discount", "numeric", true],
      ]),
    },
  ],
};
