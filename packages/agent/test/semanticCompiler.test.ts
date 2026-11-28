import { beforeAll, describe, expect, it } from "vitest";
import { sqlGuard, warmupSqlGuard, type GuardSuccess } from "@shared/access-policy";
import type { SchemaCatalog } from "@shared/contracts";
import {
  SemanticQueryCompiler,
  isGovernedQuery,
  UNGOVERNED_QUERY_CAVEAT,
  type SemanticQuery,
} from "../src/queryExecutor/semanticCompiler.js";
import { localQuerySafetyGate } from "../src/queryExecutor/safetyGate.js";

const testCatalog: SchemaCatalog = {
  tables: [
    {
      name: "orders",
      columns: [
        { name: "order_id", type: "text", nullable: false, sensitive: false, large: true },
        { name: "customer_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "purchase_date", type: "timestamp", nullable: false, sensitive: false, large: true },
        { name: "status", type: "text", nullable: false, sensitive: false, large: false },
        { name: "channel_id", type: "text", nullable: true, sensitive: false, large: false },
      ],
    },
    {
      name: "order_items",
      columns: [
        { name: "order_item_id", type: "text", nullable: false, sensitive: false, large: true },
        { name: "order_id", type: "text", nullable: false, sensitive: false, large: true },
        { name: "product_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "seller_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "price_vnd", type: "numeric", nullable: false, sensitive: false, large: false },
        { name: "freight_vnd", type: "numeric", nullable: false, sensitive: false, large: false },
      ],
    },
    {
      name: "payments",
      columns: [
        { name: "order_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "value_vnd", type: "numeric", nullable: false, sensitive: false, large: false },
      ],
    },
    {
      name: "customers",
      columns: [
        { name: "customer_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "region_group", type: "text", nullable: false, sensitive: false, large: false },
        { name: "province", type: "text", nullable: false, sensitive: false, large: false },
      ],
    },
    {
      name: "categories",
      columns: [
        { name: "category_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "name_vi", type: "text", nullable: false, sensitive: false, large: false },
      ],
    },
    {
      name: "products",
      columns: [
        { name: "product_id", type: "text", nullable: false, sensitive: false, large: false },
        { name: "category_id", type: "text", nullable: false, sensitive: false, large: false },
      ],
    },
  ],
};

describe("SemanticQueryCompiler", () => {
  const compiler = new SemanticQueryCompiler();

  beforeAll(async () => {
    await warmupSqlGuard();
  });

  it("compiles a governed net_revenue query with timeRange and dimensions", async () => {
    const query: SemanticQuery = {
      metrics: ["net_revenue"],
      dimensions: ["customers.region_group"],
      filters: [{ field: "orders.status", operator: "=", value: "delivered" }],
      timeRange: "purchase_date >= '2026-01-01' AND purchase_date < '2026-04-01'",
    };

    const compiled = compiler.compile(query, testCatalog);
    expect(compiled.governed).toBe(true);
    expect(compiled.sql).toContain("-- @citations:");
    expect(compiled.sql).toContain("metric:net_revenue");
    expect(compiled.sql).toContain("COALESCE(SUM(");
    expect(compiled.sql).toContain("FROM public.orders o");
    expect(compiled.sql).toContain("JOIN public.order_items oi USING (order_id)");
    expect(compiled.sql).toContain("JOIN public.customers c USING (customer_id)");

    const guard = await sqlGuard(compiled.sql, testCatalog);
    expect(guard.ok).toBe(true);
    const gate = localQuerySafetyGate(compiled.sql, guard as GuardSuccess, testCatalog);
    expect(gate.verdict).toBe("pass");
  });

  it("compiles with grain-safe pre-aggregation CTEs when multiple child tables are requested", async () => {
    const query: SemanticQuery = {
      metrics: ["net_revenue"],
      dimensions: ["payments.value_vnd"],
      filters: [],
      timeRange: "purchase_date >= '2026-01-01'",
    };

    const compiled = compiler.compile(query, testCatalog);
    expect(compiled.governed).toBe(true);
    expect(compiled.sql).toContain("WITH items_agg AS");
    expect(compiled.sql).toContain("payments_agg AS");
    expect(compiled.sql).toContain("LEFT JOIN items_agg i USING (order_id)");
    expect(compiled.sql).toContain("LEFT JOIN payments_agg p USING (order_id)");
    expect(compiled.sql).toContain("join_rule:orders_items_payments");

    const guard = await sqlGuard(compiled.sql, testCatalog);
    expect(guard.ok).toBe(true);
    const gate = localQuerySafetyGate(compiled.sql, guard as GuardSuccess, testCatalog);
    expect(gate.verdict).toBe("pass");
  });

  it("compiles a grain dimension using date_trunc", async () => {
    const query: SemanticQuery = {
      metrics: ["order_count"],
      dimensions: [],
      filters: [],
      timeRange: "purchase_date >= '2026-01-01' AND purchase_date < '2026-07-01'",
      grain: "month",
    };

    const compiled = compiler.compile(query, testCatalog);
    expect(compiled.governed).toBe(true);
    expect(compiled.sql).toContain("date_trunc('month', o.purchase_date)");
    expect(compiled.sql).toContain("COUNT(DISTINCT o.order_id)");

    const guard = await sqlGuard(compiled.sql, testCatalog);
    expect(guard.ok).toBe(true);
    const gate = localQuerySafetyGate(compiled.sql, guard as GuardSuccess, testCatalog);
    expect(gate.verdict).toBe("pass");
  });

  it("identifies governed vs exploratory queries with isGovernedQuery", () => {
    expect(
      isGovernedQuery(
        {
          metrics: ["net_revenue"],
          dimensions: ["customers.region_group"],
          filters: [],
        },
        testCatalog,
      ),
    ).toBe(true);

    expect(
      isGovernedQuery(
        {
          metrics: ["some_arbitrary_unregistered_metric"],
          dimensions: [],
          filters: [],
        },
        testCatalog,
      ),
    ).toBe(false);

    expect(
      isGovernedQuery(
        {
          metrics: ["net_revenue"],
          dimensions: ["unknown_table.unknown_column"],
          filters: [],
        },
        testCatalog,
      ),
    ).toBe(false);
  });

  it("defines the standard ungoverned query caveat", () => {
    expect(UNGOVERNED_QUERY_CAVEAT).toContain("exploratory / ungoverned-SQL");
  });
});
