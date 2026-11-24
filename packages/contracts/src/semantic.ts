import { z } from "zod";

// Chunk metadata for the semantic layer corpus (UC-02 section 1.2).
// Sensitivity values align with policies/sensitive_columns.yaml.

export const SemanticDocTypeSchema = z.enum([
  "table",
  "column",
  "metric",
  "join_rule",
  "example",
  "event",
]);

export type SemanticDocType = z.infer<typeof SemanticDocTypeSchema>;

export const SemanticSensitivitySchema = z.enum([
  "public",
  "internal",
  "restricted_pii",
]);

export type SemanticSensitivity = z.infer<typeof SemanticSensitivitySchema>;

export const SemanticChunkMetadataSchema = z.object({
  chunkId: z.string(),
  docType: SemanticDocTypeSchema,
  table: z.string().nullable(),
  tables: z.array(z.string()),
  metricName: z.string().nullable(),
  aliases: z.array(z.string()).default([]),
  sensitivity: SemanticSensitivitySchema,
  additive: z.boolean().optional(),
  updatedAt: z.iso.datetime(),
});

export type SemanticChunkMetadata = z.infer<typeof SemanticChunkMetadataSchema>;

export const SemanticCatalogItemSchema = SemanticChunkMetadataSchema.extend({
  summary: z.string(),
  formula: z.string().optional(),
  sqlTemplate: z.string().optional(),
  caveats: z.array(z.string()).default([]),
  primaryKey: z.string().optional(),
  grain: z.string().optional(),
  rowCountScale: z.string().optional(),
  column: z.string().optional(),
  dataType: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  question: z.string().optional(),
  citedMetrics: z.array(z.string()).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  affectedRegions: z.array(z.string()).optional(),
  affectedChannels: z.array(z.string()).optional(),
});

export type SemanticCatalogItem = z.infer<typeof SemanticCatalogItemSchema>;

export const SemanticCatalogCountsSchema = z.object({
  table: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  metric: z.number().int().nonnegative(),
  join_rule: z.number().int().nonnegative(),
  example: z.number().int().nonnegative(),
  event: z.number().int().nonnegative(),
});

export type SemanticCatalogCounts = z.infer<typeof SemanticCatalogCountsSchema>;

export const SemanticCatalogResponseSchema = z.object({
  totalChunks: z.number().int().nonnegative(),
  countsByDocType: SemanticCatalogCountsSchema,
  lastUpdatedAt: z.iso.datetime().nullable(),
  items: z.array(SemanticCatalogItemSchema),
});

export type SemanticCatalogResponse = z.infer<typeof SemanticCatalogResponseSchema>;

export const SemanticReindexResultSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
});

export type SemanticReindexResult = z.infer<typeof SemanticReindexResultSchema>;
