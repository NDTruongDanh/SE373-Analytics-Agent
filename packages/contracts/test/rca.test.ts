import { describe, expect, it } from "vitest";
import {
  AnalysisPlanResponseSchema,
  AnalysisPlanSchema,
  AgentResponseSchema,
  FormulaComponentsSchema,
  MetricTypeSchema,
  PlanStepAxisSchema,
  PlanStepSchema,
  RootCauseAnswerSchema,
  RootCauseItemSchema,
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

  it("validates FormulaComponentsSchema and AnalysisPlan with direction & formula", () => {
    const fc = FormulaComponentsSchema.parse({
      numerator: "revenue",
      denominator: "orders",
      formula: "revenue / orders",
    });
    expect(fc.numerator).toBe("revenue");
    expect(fc.denominator).toBe("orders");

    const ratioPlan = {
      question: "Vì sao AOV giảm?",
      metricName: "aov",
      metricType: "ratio" as const,
      direction: "decrease" as const,
      formulaComponents: fc,
      currentPeriod: { start: "2026-09-21", end: "2026-09-27" },
      baselinePeriod: { start: "2026-09-14", end: "2026-09-20" },
      baselineVal: 500000,
      currentVal: 371500,
      absDelta: -128500,
      pctDelta: -25.7,
      isValidBaseline: true,
      steps: [
        {
          stepId: "step_factor_aov",
          axis: "formula" as const,
          dimensionOrFactor: "aov",
          dimensionValue: null,
          dimensionPath: ["formula", "aov"],
          parentId: null,
          depth: 0,
          status: "done" as const,
          delta: -128500,
          contributionPct: 100,
          sql: "SELECT ...",
          hypothesis: "AOV drop caused by coupon misconfiguration",
        },
      ],
      totalQueriesCount: 2,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      unexploredBranches: [],
      residualOtherAbs: 0,
    };

    const parsedPlan = AnalysisPlanSchema.parse(ratioPlan);
    expect(parsedPlan.direction).toBe("decrease");
    expect(parsedPlan.formulaComponents?.formula).toBe("revenue / orders");
    expect(parsedPlan.steps[0].dimensionPath).toEqual(["formula", "aov"]);
    expect(parsedPlan.steps[0].hypothesis).toBe("AOV drop caused by coupon misconfiguration");
  });

  it("validates RootCauseItemSchema with summaryVi and dimensionPath", () => {
    const item = {
      stepId: "step_shopee_central_home",
      axis: "dimension" as const,
      dimensionOrFactor: "category",
      dimensionValue: "Đồ gia dụng",
      dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
      delta: -460000000,
      contributionPct: 100.0,
      sql: "SELECT ...",
      hypothesis: "Tạm khóa gian hàng ngành Đồ gia dụng trên Shopee Miền Trung",
      summaryVi: "Ngừng bán ngành Đồ gia dụng trên kênh Shopee tại kho Đà Nẵng",
    };

    const parsed = RootCauseItemSchema.parse(item);
    expect(parsed.dimensionPath).toEqual(["Miền Trung", "Shopee", "Đồ gia dụng"]);
    expect(parsed.summaryVi).toBe("Ngừng bán ngành Đồ gia dụng trên kênh Shopee tại kho Đà Nẵng");
  });

  it("validates 3 Seeded Scenarios contract compliance", () => {
    // KB1: Net revenue decrease (Additive) - Miền Trung x Shopee x Đồ gia dụng
    const kb1Plan = AnalysisPlanSchema.parse({
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
      metricName: "net_revenue",
      metricType: "additive",
      direction: "decrease",
      currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
      baselineVal: 2500000000,
      currentVal: 2040000000,
      absDelta: -460000000,
      pctDelta: -18.4,
      isValidBaseline: true,
      steps: [
        {
          stepId: "step_region_central",
          axis: "dimension",
          dimensionOrFactor: "region",
          dimensionValue: "Miền Trung",
          dimensionPath: ["Miền Trung"],
          parentId: null,
          depth: 0,
          status: "done",
          delta: -460000000,
          contributionPct: 100.0,
          sql: "SELECT region, SUM(amount) FROM ...",
        },
      ],
      totalQueriesCount: 2,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      unexploredBranches: [],
      residualOtherAbs: 0,
    });
    expect(kb1Plan.metricType).toBe("additive");
    expect(kb1Plan.direction).toBe("decrease");

    // KB2: AOV decrease (Ratio) - Miền Nam x TikTok Shop x Thời trang nữ
    const kb2Answer = RootCauseAnswerSchema.parse({
      question: "Vì sao AOV Tuần 39/2026 tại Miền Nam giảm 25.7%?",
      metricName: "aov",
      metricType: "ratio",
      currentPeriod: { start: "2026-09-21", end: "2026-09-27" },
      baselinePeriod: { start: "2026-09-14", end: "2026-09-20" },
      baselineVal: 500000,
      currentVal: 371500,
      absDelta: -128500,
      pctDelta: -25.7,
      mathVerified: true,
      mathDiffRatio: 0.01,
      primaryCauses: [
        {
          stepId: "step_tiktok_south_women_fashion",
          axis: "dimension",
          dimensionOrFactor: "category",
          dimensionValue: "Thời trang nữ",
          dimensionPath: ["Miền Nam", "TikTok Shop", "Thời trang nữ"],
          delta: -128500,
          contributionPct: 100.0,
          sql: "SELECT ...",
          hypothesis: "Lỗi cấu hình voucher FLASH99_ERR giảm 60%",
          summaryVi: "Voucher FLASH99_ERR giảm 60% làm tụt sâu AOV",
        },
      ],
      residualOtherAbs: 0,
      unexploredBranches: [],
      totalQueriesCount: 5,
      finalReportMarkdown: "# Báo cáo phân tích nguyên nhân AOV giảm...",
    });
    expect(kb2Answer.primaryCauses[0].dimensionPath).toContain("Thời trang nữ");

    // KB3: Net revenue surge (Additive increase) - Miền Bắc x Website x Laptop & Thiết bị IT
    const kb3Plan = AnalysisPlanSchema.parse({
      question: "Vì sao doanh thu thuần tháng 08/2026 tại Miền Bắc tăng vọt 31.5% so với tháng 07/2026?",
      metricName: "net_revenue",
      metricType: "additive",
      direction: "increase",
      currentPeriod: { start: "2026-08-01", end: "2026-08-31" },
      baselinePeriod: { start: "2026-07-01", end: "2026-07-31" },
      baselineVal: 2000000000,
      currentVal: 2630000000,
      absDelta: 630000000,
      pctDelta: 31.5,
      isValidBaseline: true,
      steps: [],
      totalQueriesCount: 2,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      unexploredBranches: [],
      residualOtherAbs: 0,
    });
    expect(kb3Plan.direction).toBe("increase");
    expect(kb3Plan.pctDelta).toBe(31.5);
  });
});
