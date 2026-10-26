// Run 1 vs Run 2 regression comparator (EVAL-03): pure, dependency-free.
// Loads two eval result JSONs and refuses to compare across datasetVersions
// (version gate fails closed) so deltas never silently mix datasets.
// Reports overall EX delta plus latency/token deltas and per-case moves.

export interface EvalCaseResult {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
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

export function compareRuns(
  before: EvalResultsFile,
  after: EvalResultsFile,
): RegressionDelta {
  if (before.datasetVersion !== after.datasetVersion) {
    throw new Error(
      `datasetVersion mismatch: ${before.datasetVersion} vs ${after.datasetVersion} — refusing to compare across datasets`,
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
