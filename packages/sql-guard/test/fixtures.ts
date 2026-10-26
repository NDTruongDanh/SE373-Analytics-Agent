import type { SchemaCatalog } from "@se373/contracts";

// Shared Olist-modelled fixture catalog for guard tests (Phase 3, D-05).
// The guard takes this catalog as injected input rather than reading the DB;
// Phase 2/4 swap in the real DB-built catalog without guard changes.
// All names are lowercase: PG folds unquoted identifiers to lowercase, and
// the guard does exact-first / lowercase-fallback lookup (quoted "Total"
// resolves against lowercase `total`).
export const fixtureCatalog: SchemaCatalog = {
  tables: {
    customers: ["id", "name", "phone", "email", "address", "city", "region"],
    orders: ["id", "customer_id", "total", "status", "created_at"],
    order_items: ["id", "order_id", "product_id", "qty", "price"],
    products: ["id", "name", "category_id", "price"],
    categories: ["id", "name"],
    sellers: ["id", "name", "region"],
    payments: ["order_id", "method", "amount"],
    reviews: ["order_id", "rating", "comment"],
    regions: ["id", "name"],
    channels: ["id", "name"],
    employees: ["id", "name", "salary", "dept"],
    promotions: ["id", "code", "discount"],
  },
};
