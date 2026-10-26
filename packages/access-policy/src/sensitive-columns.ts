// Sensitive-columns loader (GUARD-06, D-02): pure YAML-text parser governed
// by a strict zod schema plus a thin filesystem wrapper. Invalid config
// throws fail-fast per UC-09 A.8; the guard path never reads disk itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as z from "zod";

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

// Repo-root policies file, resolved from this module's location so the
// default works regardless of the caller's cwd (src and dist layouts both
// sit two levels below the repo root).
export const DEFAULT_SENSITIVE_COLUMNS_PATH = fileURLToPath(
  new URL("../../../policies/sensitive_columns.yaml", import.meta.url),
);

// Pure function: YAML text in, validated config out. Throws on malformed
// YAML or any schema violation (missing version, wrong literal, empty
// table/column, extra keys via strictObject).
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
