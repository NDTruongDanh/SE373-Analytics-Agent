// Sensitive-columns loader (POL-01, D-06): strict zod schema plus the `yaml`
// npm package plus a thin filesystem wrapper. Invalid config throws
// fail-fast so boot fails closed — an unusable policy can never be built.
//
// The `yaml` package preserves unknown keys and scalar types verbatim, so
// the strict zod schema below stays the single validation authority: wrong
// version literals, missing columns, empty names and extra keys all throw.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import * as z from "zod";
import {
  DEFAULT_SENSITIVE_COLUMNS,
  DEFAULT_SENSITIVE_COLUMNS_PATH,
} from "./constants.js";

// Compat re-exports: the canonical definitions live in ./constants.js.
export { DEFAULT_SENSITIVE_COLUMNS, DEFAULT_SENSITIVE_COLUMNS_PATH };

export const SensitiveColumnsSchema = z.strictObject({
  version: z.literal(1),
  columns: z.array(
    z.strictObject({
      table: z.string().min(1),
      column: z.string().min(1),
    }),
  ),
});

export type SensitiveColumns = z.infer<typeof SensitiveColumnsSchema>;

// Default sensitive set and repo-root policies path live in ./constants.js
// (re-exported above for compat).

// Pure function: YAML text in, validated config out. Throws on malformed
// YAML or any schema violation (missing version, wrong literal, empty
// table/column, extra keys via strictObject). Unknown keys survive the
// `yaml` parse verbatim so they reach the strict schema and throw there.
export function loadSensitiveColumns(yamlText: string): SensitiveColumns {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `Invalid sensitive_columns YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return SensitiveColumnsSchema.parse(parsed);
}

// IO wrapper: reads the file, then delegates to the pure loader. The env
// override exists for tests and relocated deployments; the explicit path
// argument beats both.
export function loadSensitiveColumnsFile(
  path: string = DEFAULT_SENSITIVE_COLUMNS_PATH,
  override?: string,
): SensitiveColumns {
  const resolved = override ?? process.env["SENSITIVE_COLUMNS_PATH"] ?? path;
  return loadSensitiveColumns(readFileSync(resolved, "utf8"));
}
