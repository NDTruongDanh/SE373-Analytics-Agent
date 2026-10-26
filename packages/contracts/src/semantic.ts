import * as z from "zod";

// Chunk metadata for the semantic layer corpus (UC-02 section 1.2).
// Sensitivity values align with policies/sensitive_columns.yaml.

export const SemanticChunkMetadataSchema = z.object({
  chunk_id: z.string(),
  doc_type: z.enum([
    "table",
    "column",
    "metric",
    "join_rule",
    "example",
    "event",
  ]),
  table: z.string().nullable(),
  tables: z.array(z.string()),
  metric_name: z.string().nullable(),
  aliases: z.array(z.string()).default([]),
  sensitivity: z.enum(["public", "internal", "restricted_pii"]),
  additive: z.boolean().optional(),
  updated_at: z.iso.datetime(),
});

export type SemanticChunkMetadata = z.infer<typeof SemanticChunkMetadataSchema>;
