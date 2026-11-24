import { z } from "zod";

export const SearchSemanticLayerInputSchema = z.object({
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).default(5),
});

export type SearchSemanticLayerInput = z.infer<
  typeof SearchSemanticLayerInputSchema
>;

export const SearchSemanticLayerChunkSchema = z.object({
  chunkId: z.string().min(1),
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
  content: z.string().min(1),
  score: z.number(),
  aliasMatched: z.boolean().optional(),
  denseScore: z.number().optional(),
});

export type SearchSemanticLayerChunk = z.infer<
  typeof SearchSemanticLayerChunkSchema
>;

export const SearchSemanticLayerOutputSchema = z.object({
  chunks: z.array(SearchSemanticLayerChunkSchema),
});

export type SearchSemanticLayerOutput = z.infer<
  typeof SearchSemanticLayerOutputSchema
>;
