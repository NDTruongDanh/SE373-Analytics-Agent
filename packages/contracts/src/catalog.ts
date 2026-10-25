import * as z from "zod";

// Injected schema catalog for the SQL guard (Phase 3, D-05): the guard takes
// this catalog as input rather than reading the DB or a static file, so the
// same pure package is importable by both mcp-server (enforcement) and agent
// (local pre-flight). PG folds unquoted identifiers to lowercase, so guard
// lookups compare lowercased on both sides; catalog keys use lowercase names.

export const SchemaCatalogSchema = z.object({
  tables: z.record(z.string(), z.array(z.string())),
});

export type SchemaCatalog = z.infer<typeof SchemaCatalogSchema>;
