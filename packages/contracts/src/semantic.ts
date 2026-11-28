import { z } from "zod";

export const SemanticChunkMetadataSchema = z.object({
  chunkId: z.string(),
  docType: z.enum([
    "table",
    "column",
    "metric",
    "join_rule",
    "example",
    "event",
  ]),
  table: z.string().nullable(),
  tables: z.array(z.string()),
  metricName: z.string().nullable(),
  aliases: z.array(z.string()).default([]),
  sensitivity: z.enum(["public", "internal", "restricted_pii"]),
  additive: z.boolean().optional(),
  cardinality: z.enum(["1:1", "1:N", "N:1", "M:N"]).optional(),
  grain: z.string().optional(),
  updatedAt: z.iso.datetime(),
});

export type SemanticChunkMetadata = z.infer<typeof SemanticChunkMetadataSchema>;
