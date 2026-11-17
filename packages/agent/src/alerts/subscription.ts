import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  SubscriptionsConfigSchema,
  type SubscriptionsConfig,
} from "@shared/contracts";

// Repo-root subscriptions config file, resolved from this module's location
// so the default works regardless of caller's cwd or workspace filter.
export const DEFAULT_SUBSCRIPTIONS_PATH = fileURLToPath(
  new URL("../../../../config/subscriptions.yaml", import.meta.url),
);

export function loadSubscriptionsConfig(yamlText: string): SubscriptionsConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(
      `Invalid subscriptions YAML syntax: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return SubscriptionsConfigSchema.parse(raw);
}

export function loadSubscriptionsConfigFile(
  filePath?: string,
  envOverride: string | undefined = process.env["SUBSCRIPTIONS_PATH"],
): SubscriptionsConfig {
  const resolved = filePath ?? envOverride ?? DEFAULT_SUBSCRIPTIONS_PATH;
  const content = readFileSync(resolved, "utf8");
  return loadSubscriptionsConfig(content);
}
