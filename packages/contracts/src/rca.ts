import * as z from "zod";

/**
 * Step status in the hierarchical RCA decomposition plan.
 */
export const StepStatusSchema = z.enum([
  "todo",
  "doing",
  "done",
  "skipped",
  "failed",
]);

export type StepStatus = z.infer<typeof StepStatusSchema>;

/**
 * Business metric calculation nature:
 * - additive: Summed totals like Net Revenue, Total Orders.
 * - ratio: Fractions or averages like AOV (Revenue/Orders), Return Rate (Returns/Total Orders).
 */
export const MetricTypeSchema = z.enum(["additive", "ratio"]);

export type MetricType = z.infer<typeof MetricTypeSchema>;

/**
 * Decomposition axis in the Two-Axis tree:
 * - dimension: Horizontal breakdown by business dimensions (e.g. region, channel, category, product).
 * - formula: Vertical decomposition along mathematical factors (e.g. Revenue = Orders * AOV).
 */
export const PlanStepAxisSchema = z.enum(["dimension", "formula"]);

export type PlanStepAxis = z.infer<typeof PlanStepAxisSchema>;

/**
 * Reason a potential branch was not explored further.
 */
export const UnexploredBranchReasonSchema = z.enum([
  "MAX_QUERIES_REACHED",
  "MAX_DEPTH_REACHED",
  "PRUNED_BELOW_THRESHOLD",
]);

export type UnexploredBranchReason = z.infer<typeof UnexploredBranchReasonSchema>;

/**
 * A branch pruned or deferred during hierarchical decomposition.
 */
export const UnexploredBranchSchema = z.object({
  axis: PlanStepAxisSchema.default("dimension"),
  dimensionOrFactor: z.string().min(1),
  dimensionValue: z.string().nullable().default(null),
  parentId: z.string().nullable(),
  reason: UnexploredBranchReasonSchema,
});

export type UnexploredBranch = z.infer<typeof UnexploredBranchSchema>;

/**
 * Time period boundary with ISO date/timestamp strings.
 */
export const TimePeriodSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});

export type TimePeriod = z.infer<typeof TimePeriodSchema>;

/**
 * Formula components specification for ratio metric decomposition.
 */
export const FormulaComponentsSchema = z.object({
  numerator: z.string().min(1),
  denominator: z.string().min(1),
  formula: z.string().optional(),
});

export type FormulaComponents = z.infer<typeof FormulaComponentsSchema>;

/**
 * Single diagnostic step in the RCA task tree.
 */
export const PlanStepSchema = z.object({
  stepId: z.string().min(1),
  axis: PlanStepAxisSchema.default("dimension"),
  dimensionOrFactor: z.string().min(1),
  dimensionValue: z.string().nullable().default(null),
  dimensionPath: z.array(z.string()).default([]),
  parentId: z.string().nullable(),
  depth: z.number().int().min(0).max(4),
  status: StepStatusSchema,
  delta: z.number(),
  contributionPct: z.number(),
  sql: z.string().nullable(),
  errorMessage: z.string().optional(),
  retryCount: z.number().int().min(0).max(2).default(0),
  hypothesis: z.string().optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * Core analysis plan payload (used by HITL Review Gate & Plan proposed event).
 */
export const AnalysisPlanSchema = z.object({
  question: z.string().min(1),
  metricName: z.string().min(1),
  metricType: MetricTypeSchema,
  direction: z.enum(["increase", "decrease"]).optional(),
  formulaComponents: FormulaComponentsSchema.optional(),
  currentPeriod: TimePeriodSchema,
  baselinePeriod: TimePeriodSchema,
  baselineVal: z.number(),
  currentVal: z.number(),
  absDelta: z.number(),
  pctDelta: z.number(),
  isValidBaseline: z.boolean(),
  steps: z.array(PlanStepSchema),
  totalQueriesCount: z.number().int().nonnegative().default(0),
  maxQueriesLimit: z.number().int().positive().default(20),
  maxDepthLimit: z.number().int().positive().default(4),
  drilldownThreshold: z.number().positive().default(30.0),
  unexploredBranches: z.array(UnexploredBranchSchema).default([]),
  residualOtherAbs: z.number().default(0),
});

export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;

/**
 * A single verified root-cause element identified at a disjoint leaf node.
 */
export const RootCauseItemSchema = z.object({
  stepId: z.string().min(1),
  axis: PlanStepAxisSchema.default("dimension"),
  dimensionOrFactor: z.string().min(1),
  dimensionValue: z.string().nullable().default(null),
  dimensionPath: z.array(z.string()).default([]),
  delta: z.number(),
  contributionPct: z.number(),
  sql: z.string().nullable(),
  hypothesis: z.string().optional(),
  summaryVi: z.string().optional(),
});

export type RootCauseItem = z.infer<typeof RootCauseItemSchema>;

/**
 * Full Root Cause Analysis report & verified mathematical attribution.
 */
export const RootCauseAnswerSchema = z.object({
  question: z.string().min(1),
  metricName: z.string().min(1),
  metricType: MetricTypeSchema,
  currentPeriod: TimePeriodSchema,
  baselinePeriod: TimePeriodSchema,
  baselineVal: z.number(),
  currentVal: z.number(),
  absDelta: z.number(),
  pctDelta: z.number(),
  mathVerified: z.boolean(),
  mathDiffRatio: z.number(),
  primaryCauses: z.array(RootCauseItemSchema),
  residualOtherAbs: z.number(),
  unexploredBranches: z.array(UnexploredBranchSchema),
  totalQueriesCount: z.number().int().nonnegative(),
  finalReportMarkdown: z.string().min(1),
});

export type RootCauseAnswer = z.infer<typeof RootCauseAnswerSchema>;
