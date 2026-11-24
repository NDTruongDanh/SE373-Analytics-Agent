import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DEFAULT_SENSITIVE_COLUMNS,
  DEFAULT_SENSITIVE_COLUMNS_PATH,
} from "./constants.js";

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

// `yaml` preserves unknown keys verbatim so SensitiveColumnsSchema.strictObject rejects them.
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

export function loadSensitiveColumnsFile(
  path: string = DEFAULT_SENSITIVE_COLUMNS_PATH,
  override?: string,
): SensitiveColumns {
  const resolved = override ?? process.env["SENSITIVE_COLUMNS_PATH"] ?? path;
  return loadSensitiveColumns(readFileSync(resolved, "utf8"));
}
