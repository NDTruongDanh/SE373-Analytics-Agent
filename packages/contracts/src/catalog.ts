import { z } from "zod";

export const SchemaCatalogTableColumnSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.string().min(1),
  nullable: z.boolean(),
  sensitive: z.boolean(),
  large: z.boolean(),
});

export type SchemaCatalogTableColumn = z.infer<
  typeof SchemaCatalogTableColumnSchema
>;

export const SchemaCatalogTableSchema = z.object({
  name: z.string().min(1).max(128),
  schema: z.string().min(1).max(128).default("public"),
  columns: z.array(SchemaCatalogTableColumnSchema),
  description: z.string().max(500).optional(),
});

export type SchemaCatalogTable = z.infer<typeof SchemaCatalogTableSchema>;

export const SchemaCatalogSchema = z.object({
  tables: z.array(SchemaCatalogTableSchema),
});

export type SchemaCatalog = z.infer<typeof SchemaCatalogSchema>;
