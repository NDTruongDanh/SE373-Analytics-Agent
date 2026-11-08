// Model pricing loader (Phase 3 G1): strict zod schema plus the `yaml`
// package plus a thin filesystem wrapper, mirroring loadSensitiveColumns
// in @shared/access-policy. Invalid config throws fail-fast so a corrupt
// table can never silently zero every cost; unknown models resolve to
// cost 0 with pricingKnown false and never throw (pricing is display
// only — it never feeds the budget-trip thresholds).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ModelPricingSchema = z.strictObject({
  version: z.literal(1),
  models: z.record(
    z.string(),
    z.strictObject({
      inputPer1M: z.number().nonnegative(),
      outputPer1M: z.number().nonnegative(),
    }),
  ),
});

export type ModelPricing = z.infer<typeof ModelPricingSchema>;

// Repo-root policies file, resolved from this module's location so the
// default works regardless of the caller's cwd (src and dist layouts both
// sit four levels below the repo root).
export const DEFAULT_MODEL_PRICING_PATH = fileURLToPath(
  new URL("../../../../policies/model_pricing.yaml", import.meta.url),
);

// Pure function: YAML text in, validated pricing table out. Throws on
// malformed YAML or any schema violation (wrong version, negative rates,
// extra keys via strictObject).
export function loadModelPricing(yamlText: string): ModelPricing {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `Invalid model_pricing YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return ModelPricingSchema.parse(parsed);
}

// IO wrapper: reads the file, then delegates to the pure loader. The env
// override exists for tests and relocated deployments; the explicit path
// argument beats both.
export function loadModelPricingFile(
  path: string = DEFAULT_MODEL_PRICING_PATH,
  override?: string,
): ModelPricing {
  const resolved = override ?? process.env["MODEL_PRICING_PATH"] ?? path;
  return loadModelPricing(readFileSync(resolved, "utf8"));
}

export interface CostEstimate {
  estimatedCostUsd: number;
  pricingKnown: boolean;
}

let cached: ModelPricing | null = null;

/** Test seam: drop the cached table so file/env changes take effect. */
export function resetPricingCacheForTests(): void {
  cached = null;
}

function getPricingTable(): ModelPricing {
  if (cached !== null) return cached;
  try {
    cached = loadModelPricingFile();
  } catch {
    // Fail-closed display default: an unreadable table prices nothing
    // instead of throwing inside span emission or budget accounting.
    cached = { version: 1, models: {} };
  }
  return cached;
}

/**
 * Price one LLM call against the cached table. Unknown or undefined
 * models cost 0 with pricingKnown false; never throws.
 */
export function estimateCostUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  if (model === undefined || model.length === 0) {
    return { estimatedCostUsd: 0, pricingKnown: false };
  }
  const entry = getPricingTable().models[model];
  if (entry === undefined) {
    return { estimatedCostUsd: 0, pricingKnown: false };
  }
  const safe = (n: number): number =>
    Number.isFinite(n) && n > 0 ? n : 0;
  return {
    estimatedCostUsd:
      (safe(inputTokens) * entry.inputPer1M +
        safe(outputTokens) * entry.outputPer1M) /
      1_000_000,
    pricingKnown: true,
  };
}
