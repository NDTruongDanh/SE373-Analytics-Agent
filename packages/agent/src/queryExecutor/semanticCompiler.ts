import { z } from "zod";
import type { SchemaCatalog } from "@shared/contracts";

export const UNGOVERNED_QUERY_CAVEAT =
  "Query is exploratory / ungoverned-SQL (fallback: authored directly by LLM rather than compiled deterministically from governed semantic metric definitions).";

export const SemanticQueryFilterSchema = z.object({
  field: z.string().min(1),
  operator: z.string().default("="),
  value: z.unknown(),
});

export type SemanticQueryFilter = z.infer<typeof SemanticQueryFilterSchema>;

export const SemanticQueryOrderBySchema = z.object({
  field: z.string().min(1),
  direction: z.enum(["ASC", "DESC"]).default("ASC"),
});

export type SemanticQueryOrderBy = z.infer<typeof SemanticQueryOrderBySchema>;

export const SemanticQuerySchema = z.object({
  metrics: z.array(z.string()).min(1),
  dimensions: z.array(z.string()).default([]),
  filters: z.array(SemanticQueryFilterSchema).default([]),
  timeRange: z.string().nullable().optional(),
  grain: z.string().nullable().optional(),
  orderBy: z.array(SemanticQueryOrderBySchema).optional(),
  limit: z.number().int().positive().optional(),
});

export type SemanticQuery = z.infer<typeof SemanticQuerySchema>;

interface MetricDefinition {
  metricName: string;
  chunkId: string;
  baseTable: string;
  expression: string;
  alias: string;
  requiredTables: string[];
  defaultFilter?: string;
  isSpecialCte?: boolean;
  cteDefinition?: (timeFilter?: string) => string;
}

const METRIC_DEFS: Record<string, MetricDefinition> = {
  net_revenue: {
    metricName: "net_revenue",
    chunkId: "metric:net_revenue",
    baseTable: "order_items",
    expression:
      "COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN oi.price_vnd WHEN o.status = 'returned' THEN -oi.price_vnd ELSE 0 END), 0)",
    alias: "net_revenue_vnd",
    requiredTables: ["order_items", "orders"],
    defaultFilter: "o.status IN ('delivered', 'returned')",
  },
  gross_merchandise_value: {
    metricName: "gross_merchandise_value",
    chunkId: "metric:gross_merchandise_value",
    baseTable: "order_items",
    expression: "COALESCE(SUM(oi.price_vnd + oi.freight_vnd), 0)",
    alias: "gmv_vnd",
    requiredTables: ["order_items", "orders"],
    defaultFilter: "o.status IN ('delivered', 'shipped', 'returned')",
  },
  order_count: {
    metricName: "order_count",
    chunkId: "metric:order_count",
    baseTable: "orders",
    expression: "COUNT(DISTINCT o.order_id)",
    alias: "order_count",
    requiredTables: ["orders"],
  },
  active_customers: {
    metricName: "active_customers",
    chunkId: "metric:active_customers",
    baseTable: "orders",
    expression: "COUNT(DISTINCT o.customer_id)",
    alias: "active_customers",
    requiredTables: ["orders"],
    defaultFilter: "o.status = 'delivered'",
  },
  aov: {
    metricName: "aov",
    chunkId: "metric:aov",
    baseTable: "order_items",
    expression:
      "(COALESCE(SUM(oi.price_vnd), 0)::numeric / NULLIF(COUNT(DISTINCT o.order_id), 0))",
    alias: "aov_vnd",
    requiredTables: ["order_items", "orders"],
    defaultFilter: "o.status = 'delivered'",
  },
  return_rate: {
    metricName: "return_rate",
    chunkId: "metric:return_rate",
    baseTable: "orders",
    expression:
      "(COUNT(*) FILTER (WHERE o.status = 'returned')::numeric / NULLIF(COUNT(*), 0))",
    alias: "return_rate",
    requiredTables: ["orders"],
  },
  cancellation_rate: {
    metricName: "cancellation_rate",
    chunkId: "metric:cancellation_rate",
    baseTable: "orders",
    expression:
      "(COUNT(*) FILTER (WHERE o.status = 'canceled')::numeric / NULLIF(COUNT(*), 0))",
    alias: "cancellation_rate",
    requiredTables: ["orders"],
  },
  on_time_delivery_rate: {
    metricName: "on_time_delivery_rate",
    chunkId: "metric:on_time_delivery_rate",
    baseTable: "orders",
    expression:
      "(COUNT(*) FILTER (WHERE o.status = 'delivered')::numeric / NULLIF(COUNT(*) FILTER (WHERE o.status IN ('delivered', 'shipped', 'returned')), 0))",
    alias: "on_time_delivery_rate",
    requiredTables: ["orders"],
  },
  revenue_per_seller: {
    metricName: "revenue_per_seller",
    chunkId: "metric:revenue_per_seller",
    baseTable: "order_items",
    expression:
      "(COALESCE(SUM(oi.price_vnd), 0)::numeric / NULLIF(COUNT(DISTINCT oi.seller_id), 0))",
    alias: "revenue_per_seller_vnd",
    requiredTables: ["order_items", "orders"],
    defaultFilter: "o.status = 'delivered'",
  },
  repeat_customer_rate: {
    metricName: "repeat_customer_rate",
    chunkId: "metric:repeat_customer_rate",
    baseTable: "orders",
    expression:
      "(COUNT(*) FILTER (WHERE co.delivered_orders >= 2)::numeric / NULLIF(COUNT(*), 0))",
    alias: "repeat_customer_rate",
    requiredTables: ["orders"],
    isSpecialCte: true,
    cteDefinition: (timeFilter) =>
      `customer_orders AS (SELECT o.customer_id, COUNT(*) AS delivered_orders FROM public.orders o WHERE o.status = 'delivered'${timeFilter ? ` AND ${timeFilter}` : ""} GROUP BY o.customer_id)`,
  },
  new_customers: {
    metricName: "new_customers",
    chunkId: "metric:new_customers",
    baseTable: "orders",
    expression: "COUNT(*)",
    alias: "new_customers",
    requiredTables: ["orders"],
    isSpecialCte: true,
    cteDefinition: () =>
      `first_orders AS (SELECT o.customer_id, MIN(o.purchase_date) AS first_purchase FROM public.orders o WHERE o.status = 'delivered' GROUP BY o.customer_id)`,
  },
  compensation_cost: {
    metricName: "compensation_cost",
    chunkId: "metric:compensation_cost",
    baseTable: "employees",
    expression: "COALESCE(SUM(e.salary), 0)",
    alias: "compensation_cost_vnd",
    requiredTables: ["employees"],
  },
};

const METRIC_ALIASES: Record<string, string> = {
  net_revenue: "net_revenue",
  "net revenue": "net_revenue",
  net_sales: "net_revenue",
  "doanh thu thuần": "net_revenue",
  "doanh số ròng": "net_revenue",
  "doanh thu thực": "net_revenue",
  "doanh thu": "net_revenue",
  revenue: "net_revenue",
  revenue_vnd: "net_revenue",
  gmv: "gross_merchandise_value",
  gross_merchandise_value: "gross_merchandise_value",
  "gross merchandise value": "gross_merchandise_value",
  "tổng giá trị hàng hoá": "gross_merchandise_value",
  "tổng giá trị giao dịch": "gross_merchandise_value",
  "doanh thu gộp": "gross_merchandise_value",
  order_count: "order_count",
  "order count": "order_count",
  "số đơn hàng": "order_count",
  "tổng số đơn hàng": "order_count",
  active_customers: "active_customers",
  "active customers": "active_customers",
  "khách hàng hoạt động": "active_customers",
  aov: "aov",
  "average order value": "aov",
  "giá trị đơn hàng trung bình": "aov",
  return_rate: "return_rate",
  "return rate": "return_rate",
  "tỉ lệ hoàn đơn": "return_rate",
  "tỷ lệ hoàn đơn": "return_rate",
  cancellation_rate: "cancellation_rate",
  "cancellation rate": "cancellation_rate",
  "tỉ lệ huỷ đơn": "cancellation_rate",
  "tỷ lệ hủy đơn": "cancellation_rate",
  repeat_customer_rate: "repeat_customer_rate",
  "repeat customer rate": "repeat_customer_rate",
  "tỉ lệ khách quay lại": "repeat_customer_rate",
  new_customers: "new_customers",
  "new customers": "new_customers",
  "khách hàng mới": "new_customers",
  on_time_delivery_rate: "on_time_delivery_rate",
  "on time delivery rate": "on_time_delivery_rate",
  "tỉ lệ giao hàng đúng hạn": "on_time_delivery_rate",
  revenue_per_seller: "revenue_per_seller",
  "revenue per seller": "revenue_per_seller",
  "doanh thu trung bình mỗi nhà bán": "revenue_per_seller",
  compensation_cost: "compensation_cost",
  "compensation cost": "compensation_cost",
  "chi phí nhân sự": "compensation_cost",
  payroll: "compensation_cost",
};

export function normalizeMetricName(raw: string): string | null {
  const clean = raw.replace(/^metric:/, "").trim().toLowerCase();
  if (METRIC_DEFS[clean]) return clean;
  if (METRIC_ALIASES[clean]) return METRIC_ALIASES[clean];
  return null;
}

const TABLE_ALIASES: Record<string, string> = {
  orders: "o",
  order_items: "oi",
  payments: "p",
  customers: "c",
  regions: "r",
  products: "prod",
  categories: "cat",
  sellers: "s",
  channels: "ch",
  promotions: "pr",
  reviews: "rev",
  employees: "e",
};

const CANONICAL_JOINS: Record<
  string,
  { fromTable: string; toTable: string; joinSql: string }
> = {
  "orders->order_items": {
    fromTable: "orders",
    toTable: "order_items",
    joinSql: "JOIN public.order_items oi USING (order_id)",
  },
  "orders->payments": {
    fromTable: "orders",
    toTable: "payments",
    joinSql: "JOIN public.payments p USING (order_id)",
  },
  "orders->reviews": {
    fromTable: "orders",
    toTable: "reviews",
    joinSql: "JOIN public.reviews rev USING (order_id)",
  },
  "orders->customers": {
    fromTable: "orders",
    toTable: "customers",
    joinSql: "JOIN public.customers c USING (customer_id)",
  },
  "orders->channels": {
    fromTable: "orders",
    toTable: "channels",
    joinSql: "JOIN public.channels ch USING (channel_id)",
  },
  "orders->promotions": {
    fromTable: "orders",
    toTable: "promotions",
    joinSql: "JOIN public.promotions pr USING (promotion_id)",
  },
  "customers->regions": {
    fromTable: "customers",
    toTable: "regions",
    joinSql: "JOIN public.regions r ON r.province = c.province",
  },
  "order_items->products": {
    fromTable: "order_items",
    toTable: "products",
    joinSql: "JOIN public.products prod USING (product_id)",
  },
  "products->categories": {
    fromTable: "products",
    toTable: "categories",
    joinSql: "JOIN public.categories cat USING (category_id)",
  },
  "order_items->sellers": {
    fromTable: "order_items",
    toTable: "sellers",
    joinSql: "JOIN public.sellers s USING (seller_id)",
  },
  "sellers->regions": {
    fromTable: "sellers",
    toTable: "regions",
    joinSql: "JOIN public.regions r ON r.province = s.province",
  },
};

const COLUMN_TO_TABLE: Record<string, string> = {
  order_id: "orders",
  customer_id: "customers",
  purchase_date: "orders",
  delivered_date: "orders",
  status: "orders",
  channel_id: "orders",
  channel_name: "channels",
  promotion_id: "orders",
  discount_pct: "promotions",
  order_item_id: "order_items",
  product_id: "products",
  seller_id: "sellers",
  price_vnd: "order_items",
  freight_vnd: "order_items",
  category_id: "categories",
  name_vi: "categories",
  region_group: "customers",
  province: "customers",
  score: "reviews",
  value_vnd: "payments",
  payment_type: "payments",
  installments: "payments",
  salary: "employees",
  dept: "employees",
};

function resolveColumnReference(raw: string): {
  table: string;
  column: string;
  qualified: string;
} {
  const parts = raw.split(".");
  if (parts.length === 2) {
    const table = (parts[0] as string).toLowerCase();
    const column = (parts[1] as string).toLowerCase();
    const alias = TABLE_ALIASES[table] ?? table;
    return { table, column, qualified: `${alias}.${column}` };
  }
  const column = raw.toLowerCase();
  const table = COLUMN_TO_TABLE[column] ?? "orders";
  const alias = TABLE_ALIASES[table] ?? table;
  return { table, column, qualified: `${alias}.${column}` };
}

function escapeLiteral(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value === null || value === undefined) return "NULL";
  const str = String(value).replace(/'/g, "''");
  return `'${str}'`;
}

function formatFilterPredicate(filter: SemanticQueryFilter): string {
  const ref = resolveColumnReference(filter.field);
  const op = filter.operator.toUpperCase().trim();
  if (op === "IN" || op === "NOT IN") {
    if (Array.isArray(filter.value)) {
      const items = filter.value.map(escapeLiteral).join(", ");
      return `${ref.qualified} ${op} (${items})`;
    }
    return `${ref.qualified} ${op} (${escapeLiteral(filter.value)})`;
  }
  return `${ref.qualified} ${op} ${escapeLiteral(filter.value)}`;
}

export function isGovernedQuery(
  query: SemanticQuery,
  catalog?: SchemaCatalog,
): boolean {
  if (!query.metrics || query.metrics.length === 0) return false;
  for (const m of query.metrics) {
    if (!normalizeMetricName(m)) return false;
  }
  if (catalog) {
    const catalogTables = new Map(
      catalog.tables.map((t) => [t.name.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase()))]),
    );
    for (const d of query.dimensions) {
      const ref = resolveColumnReference(d);
      const cols = catalogTables.get(ref.table);
      if (!cols || !cols.has(ref.column)) return false;
    }
    for (const f of query.filters) {
      const ref = resolveColumnReference(f.field);
      const cols = catalogTables.get(ref.table);
      if (!cols || !cols.has(ref.column)) return false;
    }
  }
  return true;
}

export interface CompiledSemanticResult {
  sql: string;
  tablesUsed: string[];
  governed: true;
}

export class SemanticQueryCompiler {
  compile(
    query: SemanticQuery,
  ): CompiledSemanticResult {
    const metricDefs: MetricDefinition[] = [];
    for (const m of query.metrics) {
      const norm = normalizeMetricName(m);
      if (!norm || !METRIC_DEFS[norm]) {
        throw new Error(`Metric ${m} is not governed`);
      }
      metricDefs.push(METRIC_DEFS[norm]!);
    }

    const citations = new Set<string>();
    const requiredTables = new Set<string>();

    for (const def of metricDefs) {
      citations.add(def.chunkId);
      for (const t of def.requiredTables) requiredTables.add(t);
    }

    const selectDimensions: Array<{ sql: string; alias?: string }> = [];
    const groupByExpressions: string[] = [];

    if (query.grain && (requiredTables.has("orders") || !query.dimensions.some((d) => d.includes("purchase_date")))) {
      const grainNorm = query.grain.toLowerCase().replace(/['"]/g, "");
      const dateTrunc = `date_trunc('${grainNorm}', o.purchase_date)`;
      selectDimensions.push({ sql: dateTrunc, alias: grainNorm });
      groupByExpressions.push(dateTrunc);
      requiredTables.add("orders");
    }

    for (const dim of query.dimensions) {
      const ref = resolveColumnReference(dim);
      requiredTables.add(ref.table);
      selectDimensions.push({ sql: ref.qualified, alias: ref.column });
      groupByExpressions.push(ref.qualified);
    }

    const wherePredicates: string[] = [];

    if (query.timeRange?.trim()) {
      let tr = query.timeRange.trim();
      if (!tr.includes(".") && !tr.includes("o.")) {
        tr = tr.replace(/\bpurchase_date\b/g, "o.purchase_date");
      }
      wherePredicates.push(tr);
      requiredTables.add("orders");
    }

    for (const filter of query.filters) {
      const ref = resolveColumnReference(filter.field);
      requiredTables.add(ref.table);
      wherePredicates.push(formatFilterPredicate(filter));
    }

    for (const def of metricDefs) {
      if (def.defaultFilter && !query.filters.some((f) => f.field.includes("status"))) {
        wherePredicates.push(def.defaultFilter);
      }
    }

    const childTables = ["order_items", "payments", "reviews"].filter((t) =>
      requiredTables.has(t),
    );
    const needsAntiFanoutCte = childTables.length >= 2;

    if (needsAntiFanoutCte) {
      citations.add("join_rule:orders_items_payments");
      requiredTables.add("orders");
      const ctes: string[] = [];
      const outerSelectCols: string[] = [];
      const outerJoins: string[] = [];

      for (const dim of selectDimensions) {
        outerSelectCols.push(dim.alias ? `${dim.sql} AS ${dim.alias}` : dim.sql);
      }

      if (requiredTables.has("order_items")) {
        ctes.push(
          `items_agg AS (\n  SELECT order_id, COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN oi.price_vnd WHEN o.status = 'returned' THEN -oi.price_vnd ELSE 0 END), 0) AS net_revenue_vnd,\n         COALESCE(SUM(oi.price_vnd + oi.freight_vnd), 0) AS gmv_vnd\n  FROM public.order_items oi\n  JOIN public.orders o USING (order_id)\n  GROUP BY order_id\n)`,
        );
        outerJoins.push("LEFT JOIN items_agg i USING (order_id)");
        outerSelectCols.push("COALESCE(SUM(i.net_revenue_vnd), 0) AS net_revenue_vnd");
      }

      if (requiredTables.has("payments")) {
        ctes.push(
          `payments_agg AS (\n  SELECT order_id, COALESCE(SUM(value_vnd), 0) AS payments_total_vnd\n  FROM public.payments\n  GROUP BY order_id\n)`,
        );
        outerJoins.push("LEFT JOIN payments_agg p USING (order_id)");
        outerSelectCols.push("COALESCE(SUM(p.payments_total_vnd), 0) AS payments_total_vnd");
      }

      const whereClause =
        wherePredicates.length > 0 ? `WHERE ${wherePredicates.join(" AND ")}` : "";
      const groupClause =
        groupByExpressions.length > 0
          ? `GROUP BY ${groupByExpressions.join(", ")}`
          : "";

      for (const t of requiredTables) citations.add(`table:${t}`);

      const sql = [
        `-- @citations: ${[...citations].sort().join(", ")}`,
        `WITH ${ctes.join(",\n")}`,
        `SELECT`,
        `  ${outerSelectCols.join(",\n  ")}`,
        `FROM public.orders o`,
        outerJoins.map((j) => `  ${j}`).join("\n"),
        whereClause,
        groupClause,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        sql,
        tablesUsed: [...requiredTables].sort(),
        governed: true,
      };
    }

    if (metricDefs.some((d) => d.isSpecialCte)) {
      const specialDef = metricDefs.find((d) => d.isSpecialCte)!;
      const cte = specialDef.cteDefinition
        ? specialDef.cteDefinition(query.timeRange ?? undefined)
        : "";
      const isNewCust = specialDef.metricName === "new_customers";
      const fromClause = isNewCust
        ? "FROM first_orders fo"
        : "FROM customer_orders co";
      const whereClause = isNewCust && query.timeRange
        ? `WHERE ${query.timeRange.replace(/\bo\.purchase_date\b|\bpurchase_date\b/g, "fo.first_purchase")}`
        : "";

      for (const t of requiredTables) citations.add(`table:${t}`);

      const sql = [
        `-- @citations: ${[...citations].sort().join(", ")}`,
        `WITH ${cte}`,
        `SELECT ${specialDef.expression} AS ${specialDef.alias}`,
        fromClause,
        whereClause,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        sql,
        tablesUsed: [...requiredTables].sort(),
        governed: true,
      };
    }

    const selectItems: string[] = [];
    for (const dim of selectDimensions) {
      selectItems.push(dim.alias ? `${dim.sql} AS ${dim.alias}` : dim.sql);
    }
    for (const def of metricDefs) {
      selectItems.push(`${def.expression} AS ${def.alias}`);
    }

    let rootTable = "orders";
    if (requiredTables.has("employees")) {
      rootTable = "employees";
    } else if (requiredTables.has("orders")) {
      rootTable = "orders";
    } else if (requiredTables.has("order_items")) {
      rootTable = "order_items";
    } else {
      rootTable = [...requiredTables][0] ?? "orders";
    }

    const rootAlias = TABLE_ALIASES[rootTable] ?? rootTable;
    const joins: string[] = [];
    const joinedTables = new Set<string>([rootTable]);

    const joinOrder = [
      "orders->order_items",
      "orders->payments",
      "orders->reviews",
      "orders->customers",
      "orders->channels",
      "orders->promotions",
      "customers->regions",
      "order_items->products",
      "products->categories",
      "order_items->sellers",
      "sellers->regions",
    ];

    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const edgeKey of joinOrder) {
        const edge = CANONICAL_JOINS[edgeKey];
        if (!edge) continue;
        if (
          joinedTables.has(edge.fromTable) &&
          !joinedTables.has(edge.toTable) &&
          requiredTables.has(edge.toTable)
        ) {
          joins.push(edge.joinSql);
          joinedTables.add(edge.toTable);
          progressed = true;
        } else if (
          joinedTables.has(edge.toTable) &&
          !joinedTables.has(edge.fromTable) &&
          requiredTables.has(edge.fromTable)
        ) {
          joins.push(edge.joinSql);
          joinedTables.add(edge.fromTable);
          progressed = true;
        }
      }
    }

    for (const t of requiredTables) citations.add(`table:${t}`);

    const whereClause =
      wherePredicates.length > 0 ? `WHERE ${wherePredicates.join(" AND ")}` : "";
    const groupClause =
      groupByExpressions.length > 0
        ? `GROUP BY ${groupByExpressions.join(", ")}`
        : "";

    let orderClause = "";
    if (query.orderBy && query.orderBy.length > 0) {
      const orderItems = query.orderBy.map(
        (o) => `${resolveColumnReference(o.field).qualified} ${o.direction ?? "ASC"}`,
      );
      orderClause = `ORDER BY ${orderItems.join(", ")}`;
    } else if (metricDefs.length > 0 && groupByExpressions.length > 0) {
      orderClause = `ORDER BY ${metricDefs[0]!.alias} DESC`;
    }

    const limitClause = query.limit ? `LIMIT ${query.limit}` : "";

    const sqlParts = [
      `-- @citations: ${[...citations].sort().join(", ")}`,
      `SELECT`,
      `  ${selectItems.join(",\n  ")}`,
      `FROM public.${rootTable} ${rootAlias}`,
      ...joins.map((j) => `  ${j}`),
      whereClause,
      groupClause,
      orderClause,
      limitClause,
    ];

    const sql = sqlParts.filter(Boolean).join("\n");

    return {
      sql,
      tablesUsed: [...requiredTables].sort(),
      governed: true,
    };
  }
}
