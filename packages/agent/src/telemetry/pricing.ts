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

// Resolved from module URL (both src and dist sit four levels below repo root) so cwd does not matter.
export const DEFAULT_MODEL_PRICING_PATH = fileURLToPath(
  new URL("../../../../policies/model_pricing.yaml", import.meta.url),
);

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

export function resetPricingCacheForTests(): void {
  cached = null;
}

function getPricingTable(): ModelPricing {
  if (cached !== null) return cached;
  try {
    cached = loadModelPricingFile();
  } catch {
    // Fail-closed display default: unreadable table prices nothing instead of throwing.
    cached = { version: 1, models: {} };
  }
  return cached;
}

export function estimateCostUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const { inputCostUsd, outputCostUsd, pricingKnown } = estimateCostBreakdownUsd(
    model,
    inputTokens,
    outputTokens,
  );
  return { estimatedCostUsd: inputCostUsd + outputCostUsd, pricingKnown };
}

export interface CostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  pricingKnown: boolean;
}

export function estimateCostBreakdownUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const unknown = { inputCostUsd: 0, outputCostUsd: 0, pricingKnown: false };
  if (model === undefined || model.length === 0) return unknown;
  const entry = getPricingTable().models[model];
  if (entry === undefined) return unknown;
  const safe = (n: number): number =>
    Number.isFinite(n) && n > 0 ? n : 0;
  return {
    inputCostUsd: (safe(inputTokens) * entry.inputPer1M) / 1_000_000,
    outputCostUsd: (safe(outputTokens) * entry.outputPer1M) / 1_000_000,
    pricingKnown: true,
  };
}
