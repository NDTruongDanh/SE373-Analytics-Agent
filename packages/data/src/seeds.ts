import { readFileSync } from "node:fs";
import { DEFAULT_SEEDS_PATH } from "./constants.js";
import { z } from "zod";

export { DEFAULT_SEEDS_PATH };

export const SeedEntrySchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  dimension_filter: z.string().min(1),
  period: z.strictObject({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  magnitude: z.number(),
  reference_sql: z
    .string()
    .min(1)
    .refine((sql) => /^\s*select\b/i.test(sql), {
      message: "reference_sql must be a SELECT query",
    }),
  payload: z.string().min(1).optional(),
});

export type SeedEntry = z.infer<typeof SeedEntrySchema>;

export const SeedsFileSchema = z.strictObject({
  version: z.literal(1),
  scenarios_uc05: z.array(SeedEntrySchema).min(3),
  anomalies_uc10: z.array(SeedEntrySchema).min(5),
  injections: z.array(SeedEntrySchema).min(3),
});

export type SeedsFile = z.infer<typeof SeedsFileSchema>;

export function loadSeeds(jsonText: string): SeedsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Invalid seeds JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return SeedsFileSchema.parse(parsed);
}

export function loadSeedsFile(
  path: string = DEFAULT_SEEDS_PATH,
  override?: string,
): SeedsFile {
  const resolved = override ?? process.env["SEEDS_JSON_PATH"] ?? path;
  return loadSeeds(readFileSync(resolved, "utf8"));
}
