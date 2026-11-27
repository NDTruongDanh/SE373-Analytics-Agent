// Run 1 vs Run 2 regression comparator (EVAL-03): pure, dependency-free.
// Loads two eval result JSONs and refuses to compare across datasetVersions
// (version gate fails closed) so deltas never silently mix datasets.
// Reports overall EX delta plus latency/token deltas and per-case moves.

export const RATE_LIMIT_GATE_THRESHOLD = 0.05;

export interface EvalCaseResult {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
  /** Estimated model cost in USD; absent on not-wired or scripted cases. */
  costUsd?: number;
  note?: string;
  rateLimited?: boolean;
}

export interface EvalResultsFile {
  uc?: string;
  datasetVersion: string;
  cases: EvalCaseResult[];
  summary: {
    total: number;
    passed: number;
    exRate: number;
    avgMs: number;
    avgTokens: number;
    /** Mean over cases that report a cost; omitted when none do. */
    avgCostUsd?: number;
    rateLimitedCount: number;
    rateLimitedRate: number;
  };
}

export interface RegressionDelta {
  datasetVersion: string;
  exDelta: number;
  avgMsDelta: number;
  avgTokensDelta: number;
  improved: string[];
  regressed: string[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isRateLimitedCase(c: EvalCaseResult): boolean {
  if (c.rateLimited === true) return true;
  if (typeof c.status === "string" && /rate[-_]?limit/i.test(c.status)) return true;
  if (typeof c.note === "string" && /rate[-_]?limit/i.test(c.note)) return true;
  return false;
}

export function computeRateLimitMetrics(cases: EvalCaseResult[]): {
  rateLimitedCount: number;
  rateLimitedRate: number;
} {
  const rateLimitedCount = cases.filter(isRateLimitedCase).length;
  const rateLimitedRate = cases.length === 0 ? 0 : rateLimitedCount / cases.length;
  return { rateLimitedCount, rateLimitedRate };
}

/** Summary block for a graded case list: pass counts plus mean latency/tokens. */
export function summarizeCases(
  cases: EvalCaseResult[],
): EvalResultsFile["summary"] {
  const passed = cases.filter((c) => c.exPass).length;
  const costs = cases
    .map((c) => c.costUsd)
    .filter((cost): cost is number => typeof cost === "number");
  const { rateLimitedCount, rateLimitedRate } = computeRateLimitMetrics(cases);
  return {
    total: cases.length,
    passed,
    exRate: cases.length === 0 ? 0 : passed / cases.length,
    avgMs: mean(cases.map((c) => c.ms)),
    avgTokens: mean(cases.map((c) => c.tokens)),
    ...(costs.length > 0 ? { avgCostUsd: mean(costs) } : {}),
    rateLimitedCount,
    rateLimitedRate,
  };
}

export function compareRuns(
  before: EvalResultsFile,
  after: EvalResultsFile,
): RegressionDelta {
  if (before.datasetVersion !== after.datasetVersion) {
    throw new Error(
      `datasetVersion mismatch: ${before.datasetVersion} vs ${after.datasetVersion} — refusing to compare across datasets`,
    );
  }

  const beforeRate = before.summary?.rateLimitedRate ?? computeRateLimitMetrics(before.cases).rateLimitedRate;
  const afterRate = after.summary?.rateLimitedRate ?? computeRateLimitMetrics(after.cases).rateLimitedRate;
  if (beforeRate >= RATE_LIMIT_GATE_THRESHOLD || afterRate >= RATE_LIMIT_GATE_THRESHOLD) {
    throw new Error(
      `rate-limit health gate failed: rate-limited cases >= 5% (before: ${(beforeRate * 100).toFixed(1)}%, after: ${(afterRate * 100).toFixed(1)}%) — refusing to compare across corrupted runs`,
    );
  }
  const beforeById = new Map(before.cases.map((c) => [c.id, c]));
  const improved: string[] = [];
  const regressed: string[] = [];
  for (const afterCase of after.cases) {
    const beforeCase = beforeById.get(afterCase.id);
    if (!beforeCase) continue;
    if (afterCase.exPass && !beforeCase.exPass) improved.push(afterCase.id);
    if (!afterCase.exPass && beforeCase.exPass) regressed.push(afterCase.id);
  }
  return {
    datasetVersion: after.datasetVersion,
    exDelta: after.summary.exRate - before.summary.exRate,
    avgMsDelta: mean(after.cases.map((c) => c.ms)) - mean(before.cases.map((c) => c.ms)),
    avgTokensDelta:
      mean(after.cases.map((c) => c.tokens)) -
      mean(before.cases.map((c) => c.tokens)),
    improved,
    regressed,
  };
}
