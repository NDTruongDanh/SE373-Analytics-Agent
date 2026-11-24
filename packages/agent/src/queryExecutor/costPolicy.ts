// explain_query cost ceilings (#129, H-08): strict zod schema plus a thin
// filesystem wrapper, mirroring telemetry/pricing.ts. Invalid config throws
// fail-fast so a typo can never silently lift every ceiling.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CeilingsSchema = z.strictObject({
  maxEstimatedCost: z.number().positive(),
  maxEstimatedRows: z.number().positive(),
});

export const QueryCostPolicySchema = z.strictObject({
  version: z.literal(1),
  default: CeilingsSchema,
  roles: z.record(z.string().min(1), CeilingsSchema.partial()).default({}),
});

export type QueryCostPolicy = z.infer<typeof QueryCostPolicySchema>;
export type CostCeilings = z.infer<typeof CeilingsSchema>;

// Repo-root policies file, resolved from this module's location so src and
// dist layouts (both four levels below the repo root) find it from any cwd.
export const DEFAULT_QUERY_COST_POLICY_PATH = fileURLToPath(
  new URL("../../../../policies/query_cost.yaml", import.meta.url),
);

export function loadQueryCostPolicy(yamlText: string): QueryCostPolicy {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `Invalid query_cost YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return QueryCostPolicySchema.parse(parsed);
}

export function loadQueryCostPolicyFile(
  path: string = DEFAULT_QUERY_COST_POLICY_PATH,
  override?: string,
): QueryCostPolicy {
  const resolved = override ?? process.env["QUERY_COST_POLICY_PATH"] ?? path;
  return loadQueryCostPolicy(readFileSync(resolved, "utf8"));
}

let cachedDefault: QueryCostPolicy | undefined;

/** The repo policy file, read once per process. */
export function defaultQueryCostPolicy(): QueryCostPolicy {
  cachedDefault ??= loadQueryCostPolicyFile();
  return cachedDefault;
}

export function ceilingsFor(policy: QueryCostPolicy, roleScope: string): CostCeilings {
  return { ...policy.default, ...policy.roles[roleScope] };
}

export interface CostBreach {
  metric: "estimatedCost" | "estimatedRows";
  estimate: number;
  ceiling: number;
}

/** First ceiling the estimate exceeds, or undefined when the plan fits. */
export function costBreach(
  estimate: { estimatedCost: number; estimatedRows: number },
  ceilings: CostCeilings,
): CostBreach | undefined {
  if (estimate.estimatedCost > ceilings.maxEstimatedCost) {
    return {
      metric: "estimatedCost",
      estimate: estimate.estimatedCost,
      ceiling: ceilings.maxEstimatedCost,
    };
  }
  if (estimate.estimatedRows > ceilings.maxEstimatedRows) {
    return {
      metric: "estimatedRows",
      estimate: estimate.estimatedRows,
      ceiling: ceilings.maxEstimatedRows,
    };
  }
  return undefined;
}
