// Declarative seeds loader (Phase 2, plan 02-02, D-04). UC owners edit
// packages/data/src/seeds.json only — no loader code changes needed for new
// scenarios. Follows the SensitiveColumns strict-zod idiom: version literal,
// strictObject, inferred types, a pure text-in validator plus a thin fs
// wrapper with explicit-arg-beats-env-beats-default precedence. Fail-closed
// on any violation (T-2-06 accepts bounded magnitudes because reference_sql
// is only ever read by verify, never executed by the loader).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as z from "zod";

// One seeded data mutation. Uniform shape across UC-05 scenarios, UC-10
// anomalies, and prompt-injection rows: dimension_filter names the slice
// (channel/region/category/product), period bounds the effect window,
// magnitude states the designed signal, reference_sql is the verify query
// that proves it. Injections additionally carry the payload text to insert.
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

// Seeds file resolved from this module's location so the default works
// regardless of the caller's cwd (src and dist layouts both sit two levels
// below the repo root).
export const DEFAULT_SEEDS_PATH = fileURLToPath(
  new URL("./seeds.json", import.meta.url),
);

// Pure function: JSON text in, validated seeds out. Throws fail-fast on
// malformed JSON or any schema violation (missing version, wrong literal,
// empty id, extra keys via strictness, malformed reference_sql).
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

// IO wrapper: reads the file, then delegates to the pure loader. The env
// override exists for tests and relocated deployments; the explicit path
// argument beats both.
export function loadSeedsFile(
  path: string = DEFAULT_SEEDS_PATH,
  override?: string,
): SeedsFile {
  const resolved = override ?? process.env["SEEDS_JSON_PATH"] ?? path;
  return loadSeeds(readFileSync(resolved, "utf8"));
}
