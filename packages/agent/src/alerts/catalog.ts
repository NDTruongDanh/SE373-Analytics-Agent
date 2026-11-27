import type { SchemaCatalog } from "@shared/contracts";

function col(
  name: string,
  type = "text",
  sensitive = false,
  large = false,
): SchemaCatalog["tables"][number]["columns"][number] {
  return { name, type, nullable: true, sensitive, large };
}

export const DEFAULT_ANOMALY_CATALOG: SchemaCatalog = {
  tables: [
    {
      name: "orders",
      schema: "public",
      columns: [
        col("order_id", "integer"),
        col("customer_id", "integer"),
        col("channel_id", "integer"),
        col("status", "text"),
        col("purchase_date", "timestamp with time zone", false, true),
      ],
    },
    {
      name: "order_items",
      schema: "public",
      columns: [
        col("order_item_id", "integer", false, true),
        col("order_id", "integer"),
        col("product_id", "integer"),
        col("seller_id", "integer"),
        col("price_vnd", "numeric"),
        col("freight_vnd", "numeric"),
      ],
    },
    {
      name: "payments",
      schema: "public",
      columns: [
        col("payment_id", "integer"),
        col("order_id", "integer"),
        col("payment_type", "text"),
        col("installments", "integer"),
        col("value_vnd", "numeric"),
      ],
    },
    {
      name: "products",
      schema: "public",
      columns: [
        col("product_id", "integer"),
        col("category_id", "integer"),
        col("name", "text"),
        col("price_vnd", "numeric"),
      ],
    },
    {
      name: "categories",
      schema: "public",
      columns: [
        col("category_id", "integer"),
        col("name_vi", "text"),
      ],
    },
    {
      name: "regions",
      schema: "public",
      columns: [
        col("province", "text"),
        col("region_group", "text"),
      ],
    },
    {
      name: "channels",
      schema: "public",
      columns: [
        col("channel_id", "integer"),
        col("channel_name", "text"),
      ],
    },
    {
      name: "sellers",
      schema: "public",
      columns: [
        col("seller_id", "integer"),
        col("province", "text"),
        col("region_group", "text"),
      ],
    },
    {
      name: "customers",
      schema: "public",
      columns: [
        col("customer_id", "integer"),
        col("name", "text"),
        col("phone", "text", true),
        col("email", "text", true),
        col("address", "text", true),
        col("province", "text"),
        col("region_group", "text"),
      ],
    },
    {
      name: "reviews",
      schema: "public",
      columns: [
        col("review_id", "integer"),
        col("order_id", "integer"),
        col("score", "numeric"),
        col("title", "text"),
        col("message", "text"),
        col("created_at", "timestamp"),
      ],
    },
  ],
};
