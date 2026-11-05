import { describe, expect, it } from "vitest";
import {
  AnalysisPlanResponseSchema,
  AnalysisPlanSchema,
  AgentResponseSchema,
  MetricTypeSchema,
  PlanStepAxisSchema,
  PlanStepSchema,
  RootCauseAnswerSchema,
  RootCauseResponseSchema,
  SQLAnswerStatusSchema,
  StepStatusSchema,
  UnexploredBranchReasonSchema,
  UnexploredBranchSchema,
} from "../src/index.js";

describe("UC-05 RCA Contract Schemas", () => {
  it("validates StepStatus enum values", () => {
    for (const status of ["todo", "doing", "done", "skipped", "failed"] as const) {
      expect(StepStatusSchema.parse(status)).toBe(status);
    }
    expect(() => StepStatusSchema.parse("in_progress")).toThrow();
  });

  it("validates MetricType enum values", () => {
    expect(MetricTypeSchema.parse("additive")).toBe("additive");
    expect(MetricTypeSchema.parse("ratio")).toBe("ratio");
    expect(() => MetricTypeSchema.parse("count")).toThrow();
  });

  it("validates PlanStepAxis enum values", () => {
    expect(PlanStepAxisSchema.parse("dimension")).toBe("dimension");
    expect(PlanStepAxisSchema.parse("formula")).toBe("formula");
    expect(() => PlanStepAxisSchema.parse("diagonal")).toThrow();
  });

  it("validates SQLAnswerStatus includes false_premise", () => {
    expect(SQLAnswerStatusSchema.parse("false_premise")).toBe("false_premise");
  });

  it("validates UnexploredBranchReason enum values", () => {
    for (const reason of [
      "MAX_QUERIES_REACHED",
      "MAX_DEPTH_REACHED",
      "PRUNED_BELOW_THRESHOLD",
    ] as const) {
      expect(UnexploredBranchReasonSchema.parse(reason)).toBe(reason);
    }
    expect(() => UnexploredBranchReasonSchema.parse("TIMEOUT")).toThrow();
  });

  it("validates PlanStepSchema with axis, dimensionOrFactor, delta, and sql", () => {
    const validStep = {
      stepId: "step_territory_alpha",
      axis: "dimension" as const,
      dimensionOrFactor: "territory",
      dimensionValue: "Alpha",
      parentId: null,
      depth: 0,
      status: "done" as const,
      delta: -1200000,
      contributionPct: 80.0,
      sql: "SELECT territory, SUM(amount) FROM sales GROUP BY territory",
      retryCount: 0,
    };

    const parsed = PlanStepSchema.parse(validStep);
    expect(parsed.stepId).toBe("step_territory_alpha");
    expect(parsed.axis).toBe("dimension");
    expect(parsed.dimensionOrFactor).toBe("territory");
    expect(parsed.delta).toBe(-1200000);
    expect(parsed.sql).toBe("SELECT territory, SUM(amount) FROM sales GROUP BY territory");

    // Rejects depth > 4
    expect(() =>
      PlanStepSchema.parse({
        ...validStep,
        depth: 5,
      }),
    ).toThrow();

    // Rejects retryCount > 2
    expect(() =>
      PlanStepSchema.parse({
        ...validStep,
        retryCount: 3,
      }),
    ).toThrow();
  });

  it("validates formula-axis PlanStep with null dimensionValue", () => {
    const formulaStep = {
      stepId: "step_factor_aov",
      axis: "formula" as const,
      dimensionOrFactor: "aov",
      dimensionValue: null,
      parentId: null,
      depth: 0,
      status: "done" as const,
      delta: -22.5,
      contributionPct: 85.0,
      sql: "SELECT AVG(order_total) FROM orders",
      retryCount: 0,
    };
    const parsed = PlanStepSchema.parse(formulaStep);
    expect(parsed.axis).toBe("formula");
    expect(parsed.dimensionValue).toBeNull();
  });

  it("validates UnexploredBranchSchema with axis and dimensionOrFactor", () => {
    const branch = {
      axis: "dimension" as const,
      dimensionOrFactor: "territory",
      dimensionValue: "Beta",
      parentId: null,
      reason: "PRUNED_BELOW_THRESHOLD" as const,
    };
    expect(UnexploredBranchSchema.parse(branch).reason).toBe("PRUNED_BELOW_THRESHOLD");
  });

  it("validates AnalysisPlanSchema full payload with tightened checks", () => {
    const plan = {
      question: "Vì sao doanh thu thuần quý 3/2026 giảm so với quý 2/2026?",
      metricName: "net_revenue",
      metricType: "additive" as const,
      currentPeriod: { start: "2026-07-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-04-01", end: "2026-06-30" },
      baselineVal: 10000000,
      currentVal: 8500000,
      absDelta: -1500000,
      pctDelta: -15.0,
      isValidBaseline: true,
      steps: [
        {
          stepId: "step_territory_alpha",
          axis: "dimension" as const,
          dimensionOrFactor: "territory",
          dimensionValue: "Alpha",
          parentId: null,
          depth: 0,
          status: "done" as const,
          delta: -1200000,
          contributionPct: 80.0,
          sql: "SELECT 1",
          retryCount: 0,
        },
      ],
      totalQueriesCount: 2,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30.0,
      unexploredBranches: [],
      residualOtherAbs: -300000,
    };

    const parsed = AnalysisPlanSchema.parse(plan);
    expect(parsed.metricName).toBe("net_revenue");
    expect(parsed.steps[0].delta).toBe(-1200000);
    expect(parsed.steps[0].axis).toBe("dimension");
  });

  it("validates RootCauseAnswerSchema and attribution verification", () => {
    const rcaAnswer = {
      question: "Vì sao doanh thu thuần quý 3/2026 giảm so với quý 2/2026?",
      metricName: "net_revenue",
      metricType: "additive" as const,
      currentPeriod: { start: "2026-07-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-04-01", end: "2026-06-30" },
      baselineVal: 10000000,
      currentVal: 8500000,
      absDelta: -1500000,
      pctDelta: -15.0,
      mathVerified: true,
      mathDiffRatio: 0.005,
      primaryCauses: [
        {
          stepId: "step_product_omega",
          axis: "dimension" as const,
          dimensionOrFactor: "product_line",
          dimensionValue: "Line Omega",
          dimensionPath: ["Alpha", "Retail", "Line Omega"],
          delta: -1200000,
          contributionPct: 80.0,
          sql: "SELECT ...",
          hypothesis: "Supply bottleneck in partner retail channel",
        },
      ],
      residualOtherAbs: -300000,
      unexploredBranches: [
        {
          axis: "dimension" as const,
          dimensionOrFactor: "sales_channel",
          dimensionValue: "Direct",
          parentId: "step_territory_alpha",
          reason: "PRUNED_BELOW_THRESHOLD" as const,
        },
      ],
      totalQueriesCount: 6,
      finalReportMarkdown: "# Root Cause Analysis Report...",
    };

    const parsed = RootCauseAnswerSchema.parse(rcaAnswer);
    expect(parsed.mathVerified).toBe(true);
    expect(parsed.primaryCauses[0].delta).toBe(-1200000);
  });

  it("strictly enforces tightened AnalysisPlanResponseSchema and rejects arbitrary data", () => {
    // Rejects loose arbitrary object like { n: 1 }
    expect(() =>
      AnalysisPlanResponseSchema.parse({
        kind: "analysis_plan",
        status: "ok",
        summary: "Loose plan",
        data: { n: 1 },
      }),
    ).toThrow();

    // Rejects loose arbitrary object for root_cause
    expect(() =>
      RootCauseResponseSchema.parse({
        kind: "root_cause",
        status: "ok",
        summary: "Loose cause",
        data: { n: 1 },
      }),
    ).toThrow();
  });

  it("discriminates tightened analysis_plan and root_cause in AgentResponseSchema", () => {
    const validPlan = {
      question: "Vì sao doanh thu sụt giảm?",
      metricName: "net_sales",
      metricType: "additive" as const,
      currentPeriod: { start: "2026-07-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-04-01", end: "2026-06-30" },
      baselineVal: 100,
      currentVal: 80,
      absDelta: -20,
      pctDelta: -20,
      isValidBaseline: true,
      steps: [],
      totalQueriesCount: 1,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      unexploredBranches: [],
      residualOtherAbs: 0,
    };

    const planEnvelope = {
      kind: "analysis_plan" as const,
      status: "ok" as const,
      summary: "Kế hoạch phân tích nguyên nhân sụt giảm doanh thu",
      data: validPlan,
    };

    const parsed = AgentResponseSchema.parse(planEnvelope);
    expect(parsed.kind).toBe("analysis_plan");
  });
});
