import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DATASET_VERSION,
  DEFAULT_MANIFEST_PATH,
  SMALL_MANIFEST_PATH,
} from "./constants.js";
import { z } from "zod";

export { DATASET_VERSION, DEFAULT_MANIFEST_PATH, SMALL_MANIFEST_PATH };

export const SeedManifestSchema = z.strictObject({
  version: z.literal(1),
  seed: z.number().int(),
  dataset_version: z.string().min(1),
  tables: z.record(
    z.string(),
    z.strictObject({
      rows: z.number().int().nonnegative(),
      sha256: z.string().min(1),
    }),
  ),
});

export type SeedManifest = z.infer<typeof SeedManifestSchema>;

export function manifestPathFor(scale: "full" | "small"): string {
  return scale === "small" ? SMALL_MANIFEST_PATH : DEFAULT_MANIFEST_PATH;
}

export function hashCanonicalCsv(canonicalCsv: string): string {
  return createHash("sha256").update(canonicalCsv, "utf8").digest("hex");
}

export function parseManifest(text: unknown): SeedManifest {
  return SeedManifestSchema.parse(text);
}

export function readManifest(path: string = DEFAULT_MANIFEST_PATH): SeedManifest {
  return parseManifest(JSON.parse(readFileSync(path, "utf8")));
}

export function writeManifest(
  manifest: SeedManifest,
  path: string = DEFAULT_MANIFEST_PATH,
): void {
  const validated = parseManifest(manifest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export function compareManifests(
  actual: SeedManifest,
  expected: SeedManifest,
): string[] {
  const mismatches: string[] = [];
  if (actual.version !== expected.version) {
    mismatches.push(`version: ${String(actual.version)} != ${String(expected.version)}`);
  }
  if (actual.seed !== expected.seed) {
    mismatches.push(`seed: ${String(actual.seed)} != ${String(expected.seed)}`);
  }
  if (actual.dataset_version !== expected.dataset_version) {
    mismatches.push(
      `dataset_version: ${actual.dataset_version} != ${expected.dataset_version}`,
    );
  }
  const tables = new Set([
    ...Object.keys(actual.tables),
    ...Object.keys(expected.tables),
  ]);
  for (const table of [...tables].sort()) {
    const a = actual.tables[table];
    const e = expected.tables[table];
    if (!a) {
      mismatches.push(`${table}: missing from fresh load`);
    } else if (!e) {
      mismatches.push(`${table}: unexpected table in fresh load`);
    } else if (a.rows !== e.rows || a.sha256 !== e.sha256) {
      mismatches.push(
        `${table}: rows ${String(a.rows)} != ${String(e.rows)} or sha256 ${a.sha256} != ${e.sha256}`,
      );
    }
  }
  return mismatches;
}
