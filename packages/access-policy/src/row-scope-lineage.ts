import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ViaSchema = z.strictObject({
  via: z.string().min(1),
  column: z.string().min(1),
  parentColumn: z.string().min(1),
});

export const LineageEntrySchema = z.union([z.literal("direct"), z.literal("global"), ViaSchema]);

export type LineageEntry = z.infer<typeof LineageEntrySchema>;

export const RowScopeLineageSchema = z
  .strictObject({
    version: z.literal(1),
    scopes: z.record(
      z.string().min(1),
      z.strictObject({ tables: z.record(z.string().min(1), LineageEntrySchema) }),
    ),
  })
  .superRefine((value, ctx) => {
    for (const [column, scope] of Object.entries(value.scopes)) {
      for (const table of Object.keys(scope.tables)) {
        const seen = new Set<string>();
        let current = table;
        for (;;) {
          const entry = scope.tables[current];
          if (entry === undefined) {
            ctx.addIssue({
              code: "custom",
              message: `${column}: ${table} reaches undeclared table ${current}`,
            });
            break;
          }
          if (typeof entry === "string") break;
          if (seen.has(current)) {
            ctx.addIssue({ code: "custom", message: `${column}: lineage cycle at ${current}` });
            break;
          }
          seen.add(current);
          current = entry.via;
        }
        const root = scope.tables[current];
        if (root === "global" && current !== table) {
          ctx.addIssue({
            code: "custom",
            message: `${column}: ${table} is scoped through global table ${current}`,
          });
        }
      }
    }
  });

export type RowScopeLineage = z.infer<typeof RowScopeLineageSchema>;

export const DEFAULT_ROW_SCOPE_LINEAGE_PATH = fileURLToPath(
  new URL("../../../policies/row_scope.yaml", import.meta.url),
);

export const DEFAULT_ROW_SCOPE_LINEAGE: RowScopeLineage = {
  version: 1,
  scopes: {
    region_group: {
      tables: {
        customers: "direct",
        sellers: "direct",
        regions: "direct",
        orders: { via: "customers", column: "customer_id", parentColumn: "customer_id" },
        order_items: { via: "orders", column: "order_id", parentColumn: "order_id" },
        payments: { via: "orders", column: "order_id", parentColumn: "order_id" },
        reviews: { via: "orders", column: "order_id", parentColumn: "order_id" },
        employees: { via: "regions", column: "province", parentColumn: "province" },
        products: "global",
        categories: "global",
        channels: "global",
        promotions: "global",
      },
    },
  },
};

export function loadRowScopeLineage(yamlText: string): RowScopeLineage {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `Invalid row_scope YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return RowScopeLineageSchema.parse(parsed);
}

export function loadRowScopeLineageFile(
  path: string = DEFAULT_ROW_SCOPE_LINEAGE_PATH,
  override?: string,
): RowScopeLineage {
  const resolved = override ?? process.env["ROW_SCOPE_LINEAGE_PATH"] ?? path;
  return loadRowScopeLineage(readFileSync(resolved, "utf8"));
}
