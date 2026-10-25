import * as z from "zod";

// Tracer slice of the db-tool contract surface: list_tables and
// describe_table I/O schemas (UC-09 A.6/A.7, PRD 4.1 tool table).
// Scope filtering is server-side in Phase 4, never a client claim, so
// ListTablesInputSchema is an empty strict object.

export const ListTablesInputSchema = z.strictObject({});

export type ListTablesInput = z.infer<typeof ListTablesInputSchema>;

const ListTablesEntrySchema = z.object({
  name: z.string().min(1).max(128),
  schema: z.string().default("public"),
  description: z.string().max(500).optional(),
});

export const ListTablesOutputSchema = z.object({
  tables: z.array(ListTablesEntrySchema),
});

export type ListTablesOutput = z.infer<typeof ListTablesOutputSchema>;

export const DescribeTableInputSchema = z.object({
  table: z.string().min(1).max(128),
});

export type DescribeTableInput = z.infer<typeof DescribeTableInputSchema>;

const DescribeTableColumnSchema = z.object({
  name: z.string().min(1).max(128),
  type: z.string().min(1),
  nullable: z.boolean(),
  sensitive: z.boolean(),
  description: z.string().max(500).optional(),
});

const ForeignKeySchema = z.object({
  column: z.string().min(1),
  referencesTable: z.string().min(1),
  referencesColumn: z.string().min(1),
});

export const DescribeTableOutputSchema = z.object({
  table: z.string().min(1).max(128),
  columns: z.array(DescribeTableColumnSchema),
  primaryKey: z.array(z.string()).default([]),
  foreignKeys: z.array(ForeignKeySchema).default([]),
});

export type DescribeTableOutput = z.infer<typeof DescribeTableOutputSchema>;
