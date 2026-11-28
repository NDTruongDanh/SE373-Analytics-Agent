import { z } from "zod";

// Empty strict object because table scope filtering is enforced server-side.
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
  // Optional so pre-1.2.0 payloads still parse; absent means not large.
  large: z.boolean().optional(),
  description: z.string().max(500).optional(),
});

const ForeignKeySchema = z.object({
  column: z.string().min(1),
  referencesTable: z.string().min(1),
  referencesColumn: z.string().min(1),
  cardinality: z.enum(["1:1", "1:N", "N:1", "M:N"]).optional(),
});

export const DescribeTableOutputSchema = z.object({
  table: z.string().min(1).max(128),
  columns: z.array(DescribeTableColumnSchema),
  primaryKey: z.array(z.string()).default([]),
  foreignKeys: z.array(ForeignKeySchema).default([]),
  grain: z.string().max(500).optional(),
});

export type DescribeTableOutput = z.infer<typeof DescribeTableOutputSchema>;

export const ExplainQueryInputSchema = z.object({
  sql: z.string().min(1).max(20000),
});

export type ExplainQueryInput = z.infer<typeof ExplainQueryInputSchema>;

export const ExplainQueryOutputSchema = z.object({
  estimatedCost: z.number().nonnegative(),
  estimatedRows: z.number().int().nonnegative(),
  planJson: z.unknown().optional(),
});

export type ExplainQueryOutput = z.infer<typeof ExplainQueryOutputSchema>;

export const RunQueryInputSchema = z.object({
  sql: z.string().min(1).max(20000),
  maxRows: z.number().int().min(1).max(1000).default(200),
});

export type RunQueryInput = z.infer<typeof RunQueryInputSchema>;

// Column names only, never the scoped value (single source re-exported by @shared/access-policy).
export const RowScopeAppliedSchema = z.strictObject({
  table: z.string().min(1),
  column: z.string().min(1),
});

export type RowScopeApplied = z.infer<typeof RowScopeAppliedSchema>;

export const RunQueryOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  maskedColumns: z.array(z.string()).default([]),
  rowScopeApplied: z.array(RowScopeAppliedSchema).default([]),
  durationMs: z.number().nonnegative(),
});

export type RunQueryOutput = z.infer<typeof RunQueryOutputSchema>;

export const SampleRowsInputSchema = z.object({
  table: z.string().min(1).max(128),
  n: z.number().int().min(1).max(5).default(5),
});

export type SampleRowsInput = z.infer<typeof SampleRowsInputSchema>;

export const SampleRowsOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
});

export type SampleRowsOutput = z.infer<typeof SampleRowsOutputSchema>;
