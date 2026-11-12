import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
    SubscriptionsConfigSchema,
    type SubscriptionsConfig,
} from "@shared/contracts";

export const DEFAULT_SUBSCRIPTIONS_PATH = path.resolve(
    process.cwd(),
    "config/subscriptions.yaml",
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
    filePath: string = DEFAULT_SUBSCRIPTIONS_PATH,
): SubscriptionsConfig {
    const content = readFileSync(filePath, "utf8");
    return loadSubscriptionsConfig(content);
}
