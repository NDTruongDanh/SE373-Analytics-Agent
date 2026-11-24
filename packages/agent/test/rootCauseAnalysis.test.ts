import { describe, expect, it } from "vitest";
import { MemorySaver, StateGraph, START, END, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  buildBaselineQuery,
  buildStepQuery,
  collectInheritedFilters,
  createDateGuardedMcpCaller,
  createPlan,
  createRcaRuntime,
  executeAnalysis,
  getDisjointLeafNodes,
  getDisjointSkippedNodes,
  getNextDimension,
  identifyPrimaryRootCauses,
  parseRcaIntent,
  slugify,
  synthesizeReport,
  toRegionGroup,
  validateBaseline,
  verifySqlDateFilter,
  verifyWaterfallAttribution,
  canDecomposeOrdersAov,
  lmdiDecompose,
  shapleyTwoFactor,
  calculateReturnEffect,
  decomposeRevenueFactors,
  decomposeRatioFormula,
  shiftShareDecompose,
  applyOffsettingGuard,
  RCA_UC_ID,
} from "../src/subgraphs/rootCauseAnalysis.js";
import { routeQuestionToUc } from "../src/router.js";
import { createChatModel } from "../src/models/factory.js";
import { buildRootGraph } from "../src/graph.js";
import { getUcEntry, isKnownUc } from "../src/subgraphs/registry.js";
import { pauseForApproval, resumeDecision, makeThreadId } from "../src/hitl.js";
import { AgentStateSchema, type AgentState } from "../src/state.js";
import type { AnalysisPlan, PlanStep } from "@shared/contracts";

describe("UC-05 Root Cause Analysis Subgraph (Issue #35)", () => {
  const mockPrincipal = {
    runId: "run_test_01",
    userId: "user_analyst",
    roleScope: "sales_south",
  };

  it("registers root-cause-analysis in the UC registry", () => {
    expect(isKnownUc(RCA_UC_ID)).toBe(true);
    expect(getUcEntry(RCA_UC_ID)).toBeDefined();
  });

  it("loads root-cause-analysis skill and emits skill_call span at entry (AC1)", async () => {
    const emittedEvents: Array<{ node: string; type: string; payload?: unknown }> = [];
    const mockRt = {
      emit: (e: { node: string; type: string; payload?: unknown }) => {
        emittedEvents.push(e);
        return `span_${emittedEvents.length}`;
      },
      config: { configurable: {} },
    };

    const runtime = createRcaRuntime({
      fetchBaseline: async () => 1_000_000,
    });

    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    await runtime.entry(mockState, mockRt as never);

    const skillCall = emittedEvents.find(
      (e) => e.type === "skill_call" && (e.payload as { skill?: string })?.skill === "root-cause-analysis",
    );
    expect(skillCall).toBeDefined();
    expect(skillCall?.node).toBe("skills");
  });

  it("injects skill contract into SQL proposal prompts sent to executor", async () => {
    const capturedQuestions: string[] = [];
    const mockExecutor = {
      run: async (input: { question: string }) => {
        capturedQuestions.push(input.question);
        return {
          status: "ok" as const,
          sql: "SELECT 1000000 AS val FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31' AND status = 'delivered'",
          tablesUsed: ["orders"],
          columns: ["val"],
          rows: [{ val: 1000000 }],
          maskedColumns: [],
          attempts: 1,
        };
      },
    };

    const runtime = createRcaRuntime({ executor: mockExecutor });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    await runtime.entry(mockState, mockRt as never);

    expect(capturedQuestions.length).toBeGreaterThanOrEqual(1);
    expect(capturedQuestions[0]).toContain("Skill contract:");
    expect(capturedQuestions[0]).toContain("root-cause-analysis");
  });

  it("injects skill contract into intentModel prompt and uses structured output", async () => {
    let capturedPrompt = "";
    const fakeIntentModel = {
      withStructuredOutput: () => ({
        invoke: async (prompt: string) => {
          capturedPrompt = prompt;
          return {
            metricName: "net_revenue",
            metricType: "additive" as const,
            statedDirection: "decrease" as const,
            baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
            currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
          };
        },
      }),
    };

    const runtime = createRcaRuntime({
      intentModel: fakeIntentModel as never,
      fetchBaseline: async () => 1_000_000,
    });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    await runtime.entry(mockState, mockRt as never);
    expect(capturedPrompt).toContain("Skill contract:");
    expect(capturedPrompt).toContain("root-cause-analysis");
  });

  it("emits intent_model_error and rethrows when injected intentModel fails", async () => {
    const emittedEvents: Array<{ node: string; type: string; payload?: unknown }> = [];
    const fakeIntentModel = {
      withStructuredOutput: () => ({
        invoke: async () => {
          throw new Error("Intent model API connection timeout");
        },
      }),
    };

    const runtime = createRcaRuntime({
      intentModel: fakeIntentModel as never,
      fetchBaseline: async () => 1_000_000,
    });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: (e: { node: string; type: string; payload?: unknown }) => {
        emittedEvents.push(e);
        return `span_${emittedEvents.length}`;
      },
      config: { configurable: {} },
    };

    await expect(runtime.entry(mockState, mockRt as never)).rejects.toThrow(
      "Intent model API connection timeout",
    );
    const errorSpan = emittedEvents.find(
      (e) => e.type === "intent_model_error" && e.node === "intent",
    );
    expect(errorSpan).toBeDefined();
    expect((errorSpan?.payload as { error?: string })?.error).toContain(
      "Intent model API connection timeout",
    );
  });

  it("extracts intent from Vietnamese diagnostic queries with date & metric parsing", () => {
    // KB1: Additive drop
    const q1 = "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?";
    const i1 = parseRcaIntent(q1);
    expect(i1.direction).toBe("decrease");
    expect(i1.metricName).toBe("net_revenue");
    expect(i1.metricType).toBe("additive");
    expect(i1.currentPeriod).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(i1.baselinePeriod).toEqual({ start: "2026-08-01", end: "2026-08-31" });

    // KB2: Ratio AOV drop
    const q2 = "Vì sao giá trị đơn hàng trung bình (AOV) miền Nam tuần 39/2026 giảm so với tuần 38/2026?";
    const i2 = parseRcaIntent(q2);
    expect(i2.direction).toBe("decrease");
    expect(i2.metricName).toBe("aov");
    expect(i2.metricType).toBe("ratio");
    expect(i2.formulaComponents?.numerator).toBe("net_revenue");
    expect(i2.formulaComponents?.denominator).toBe("delivered_orders");
    expect(i2.currentPeriod).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(i2.baselinePeriod).toEqual({ start: "2026-09-14", end: "2026-09-20" });

    // KB3: Additive surge (increase)
    const q3 = "Vì sao doanh thu thuần tháng 08/2026 tại Miền Bắc tăng vọt 31.5% so với tháng 07/2026?";
    const i3 = parseRcaIntent(q3);
    expect(i3.direction).toBe("increase");
    expect(i3.metricName).toBe("net_revenue");
    expect(i3.metricType).toBe("additive");
    expect(i3.currentPeriod).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(i3.baselinePeriod).toEqual({ start: "2026-07-01", end: "2026-07-31" });
  });

  it("T35-T1: validate_baseline passes when actual delta matches premise direction", async () => {
    const q = "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?";
    const intent = parseRcaIntent(q);

    // Mock fetchBaseline returning real KB1 figures: 2.5B -> 2.04B (-18.4%)
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
    };

    const res = await validateBaseline(q, intent, deps, mockPrincipal);
    expect(res.isValidBaseline).toBe(true);
    expect(res.absDelta).toBe(-460_000_000);
    expect(res.pctDelta).toBeCloseTo(-18.4, 1);
    expect(res.queriesExecuted).toBe(2);
    expect(res.message).toContain("Tiền đề hợp lệ");
  });

  it("T35-T2: validate_baseline trips false_premise early stop on direction mismatch", async () => {
    // User asks why revenue decreased, but it actually increased
    const q = "Vì sao doanh thu tháng 9/2026 giảm mạnh so với tháng 9/2025?";
    const intent = parseRcaIntent(q);
    intent.direction = "decrease";

    // Actual DB shows revenue rose from 1.8B to 2.04B (+13.3%)
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("2025") ? 1_800_000_000 : 2_040_000_000;
      },
    };

    const res = await validateBaseline(q, intent, deps, mockPrincipal);
    expect(res.isValidBaseline).toBe(false);
    expect(res.absDelta).toBe(240_000_000);
    expect(res.pctDelta).toBeGreaterThan(0);
    expect(res.queriesExecuted).toBe(2);
    expect(res.message).toContain("Tiền đề không chính xác");
    expect(res.message).toContain("TĂNG");

    // createPlan should return null on invalid baseline
    const plan = createPlan(q, intent, res);
    expect(plan).toBeNull();
  });

  it("T35-T3: create_plan builds horizontal business hierarchy for additive metric", () => {
    const q = "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?";
    const intent = parseRcaIntent(q);
    const baseline = {
      baselineVal: 2_500_000_000,
      currentVal: 2_040_000_000,
      absDelta: -460_000_000,
      pctDelta: -18.4,
      isValidBaseline: true,
      message: "Tiền đề hợp lệ",
      queriesExecuted: 2,
      lastSql: "SELECT 1",
      tablesUsed: ["orders", "order_items"],
    };

    const plan = createPlan(q, intent, baseline);
    expect(plan).not.toBeNull();
    expect(plan?.metricType).toBe("additive");
    expect(plan?.steps).toHaveLength(3);
    expect(plan?.steps[0].axis).toBe("dimension");
    expect(plan?.steps[0].dimensionOrFactor).toBe("region");
    expect(plan?.steps[0].status).toBe("todo");
    expect(plan?.steps[0].depth).toBe(0);
    expect(plan?.totalQueriesCount).toBe(2);
    expect(plan?.maxQueriesLimit).toBe(20);
    expect(plan?.maxDepthLimit).toBe(4);
    expect(plan?.drilldownThreshold).toBe(30.0);
  });

  it("T35-T4: create_plan builds Two-Axis (formula + dimension) tree for ratio metric", () => {
    const q = "Vì sao AOV miền Nam tuần 39 giảm so với tuần 38?";
    const intent = parseRcaIntent(q);
    const baseline = {
      baselineVal: 500_000,
      currentVal: 371_500,
      absDelta: -128_500,
      pctDelta: -25.7,
      isValidBaseline: true,
      message: "Tiền đề hợp lệ",
      queriesExecuted: 2,
      lastSql: "SELECT 1",
      tablesUsed: ["orders", "order_items"],
    };

    const plan = createPlan(q, intent, baseline);
    expect(plan).not.toBeNull();
    expect(plan?.metricType).toBe("ratio");
    expect(plan?.steps).toHaveLength(5);

    const formulaStep = plan?.steps.find((s) => s.axis === "formula");
    const dimStep = plan?.steps.find((s) => s.axis === "dimension");
    expect(formulaStep).toBeDefined();
    expect(dimStep).toBeDefined();
    expect(formulaStep?.status).toBe("todo");
    expect(dimStep?.status).toBe("todo");
    expect(formulaStep?.dimensionPath).toEqual(["formula", "net_revenue"]);
    expect(dimStep?.dimensionPath).toEqual(["Miền Bắc"]);
  });

  it("T35-T5: createRcaRuntime executes baseline check and returns proper state update", async () => {
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
    };

    const runtime = createRcaRuntime(deps);
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: {
        configurable: {
          runId: "run_rca_test",
          userId: "user_test",
          roleScope: "sales_south",
        },
      },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("ok");
    expect(update.analysisPlan).toBeDefined();
    expect(update.analysisPlan?.isValidBaseline).toBe(true);
    expect(update.analysisPlan?.steps[0].status).toBe("todo");
    // With fetchBaseline stub, no real MCP tool called
    expect(update.toolsCalled).toEqual([]);
  });

  it("T35-T5_tools: tracks actualToolsCalled when executor runs real queries", async () => {
    let call = 0;
    const capturedInputs: Array<{ question: string; candidateTables: string[] }> = [];
    const mockExecutor = {
      run: async (input: { question: string; candidateTables: string[] }) => {
        call++;
        capturedInputs.push(input);
        const val = call === 1 ? 2_500_000_000 : 2_040_000_000;
        const start = call === 1 ? "2026-08-01" : "2026-09-01";
        const end = call === 1 ? "2026-08-31" : "2026-09-30";
        return {
          status: "ok" as const,
          sql: `SELECT ${val} AS val FROM orders WHERE purchase_date >= '${start}' AND purchase_date <= '${end}' AND status = 'delivered'`,
          tablesUsed: ["orders", "order_items"],
          columns: ["val"],
          rows: [{ val }],
          maskedColumns: [],
          attempts: 1,
        };
      },
    };

    const runtime = createRcaRuntime({ executor: mockExecutor });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("ok");
    expect(update.analysisPlan).toBeDefined();
    expect(update.toolsCalled).toContain("run_query");
    expect(update.toolsCalled).toHaveLength(2);

    // Verify Bug #1 fix: Executor received prompt containing period dates and sample SQL
    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[0].question).toContain("2026-08-01");
    expect(capturedInputs[0].question).toContain("2026-08-31");
    expect(capturedInputs[0].question).toContain("Reference SQL:");
    expect(capturedInputs[1].question).toContain("2026-09-01");
    expect(capturedInputs[1].question).toContain("2026-09-30");
    expect(capturedInputs[1].question).toContain("Reference SQL:");

    // Verify lastSql contains actual executed SQL with date filter
    expect(update.sql).toContain("2026-09-01");
    expect(update.sql).toContain("2026-09-30");
  });

  it("T35-T5_buildBaselineQuery: net_revenue deducts returned orders per UC05.md:156", () => {
    const period = { start: "2026-08-01", end: "2026-08-31" };
    const sql = buildBaselineQuery("net_revenue", "additive", period);
    expect(sql).toContain("delivered");
    expect(sql).toContain("returned");
    expect(sql).toContain("-i.price_vnd");
    expect(sql).toContain("2026-08-01");
    expect(sql).toContain("2026-08-31");
  });

  it("T35-T5_buildBaselineQuery_aov: matches semantic/metrics.yaml (delivered orders for both numerator and denominator)", () => {
    const period = { start: "2026-08-01", end: "2026-08-31" };
    const sql = buildBaselineQuery("aov", "ratio", period);
    expect(sql).toContain("o.status = 'delivered'");
    expect(sql).not.toContain("returned");
    expect(sql).toContain("SUM(i.price_vnd)");
    expect(sql).toContain("COUNT(DISTINCT o.order_id)");
    expect(sql).toContain("2026-08-01");
    expect(sql).toContain("2026-08-31");
  });

  it("T35-T5_date_guarded_mcp_caller: blocks invalid query before sending to MCP/DB", async () => {
    let callCount = 0;
    const baseCaller = {
      call: async () => {
        callCount++;
        return { rows: [] };
      },
    };

    const activePeriod = { start: "2026-08-01", end: "2026-08-31" };
    const guardedCaller = createDateGuardedMcpCaller(baseCaller, () => activePeriod);

    // 1. describe_table should pass through without date filter checks
    await guardedCaller.call("describe_table", { table: "orders" });
    expect(callCount).toBe(1);

    // 2. run_query missing end date -> throws and blocks execution (callCount stays 1)
    await expect(
      guardedCaller.call("run_query", {
        sql: "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 3. explain_query missing start date -> throws and blocks execution (callCount stays 1)
    await expect(
      guardedCaller.call("explain_query", {
        sql: "SELECT SUM(price_vnd) FROM orders WHERE purchase_date <= '2026-08-31'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 3b. run_query with created_at on joined customers table -> throws and blocks execution
    await expect(
      guardedCaller.call("run_query", {
        sql: "SELECT SUM(price_vnd) FROM orders o JOIN customers c USING(customer_id) WHERE c.created_at >= '2026-08-01' AND c.created_at <= '2026-08-31'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 3c. run_query with x.purchase_date where x is another table -> throws and blocks execution
    await expect(
      guardedCaller.call("run_query", {
        sql: "SELECT SUM(price_vnd) FROM orders o JOIN external_events x USING(order_id) WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 3d. run_query where alias o is assigned to joined table, not orders -> throws and blocks execution
    await expect(
      guardedCaller.call("run_query", {
        sql: "SELECT SUM(ords.price_vnd) FROM orders ords JOIN customers o USING (customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 3c. run_query with x.purchase_date where x is another table -> throws and blocks execution
    await expect(
      guardedCaller.call("run_query", {
        sql: "SELECT SUM(price_vnd) FROM orders o JOIN external_events x USING(order_id) WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 3d. run_query where alias o is assigned to joined table, not orders -> throws and blocks execution
    await expect(
      guardedCaller.call("run_query", {
        sql: "SELECT SUM(ords.price_vnd) FROM orders ords JOIN customers o USING (customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
      }),
    ).rejects.toThrow("Truy vấn SQL thiếu bộ lọc ngày bắt buộc cho kỳ");
    expect(callCount).toBe(1); // Call was blocked!

    // 4. run_query with valid date bounds -> passes through to baseCaller
    await guardedCaller.call("run_query", {
      sql: "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31'",
    });
    expect(callCount).toBe(2);
  });

  it("T35-T5_verifySqlDateFilter: enforces both start and end boundaries strictly", async () => {
    const period = { start: "2026-08-01", end: "2026-08-31" };

    // Valid: both bounds present with <= end
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Valid: both bounds present with < nextDay (2026-09-01)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date < '2026-09-01'",
        period,
      ),
    ).toBe(true);

    // Valid: month truncation / to_char
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE to_char(purchase_date, 'YYYY-MM') = '2026-08'",
        period,
      ),
    ).toBe(true);

    // Invalid: missing end date (only >= start)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Invalid: missing start date (only <= end)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date <= '2026-08-31' AND status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Invalid: missing start date (only < nextDay)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date < '2026-09-01' AND status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Invalid: date string in status condition instead of date column (user review case)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND status = '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: date string inside SQL comment
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders -- filter from 2026-08-01 to 2026-08-31\nWHERE status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Valid: BETWEEN syntax
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o WHERE o.purchase_date BETWEEN '2026-08-01' AND '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Valid: date cast (::date)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o WHERE o.purchase_date >= '2026-08-01'::date AND o.purchase_date <= '2026-08-31'::date",
        period,
      ),
    ).toBe(true);

    // Invalid: OR between date bounds instead of AND (tautology / unbounded period)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o WHERE o.purchase_date >= '2026-08-01' OR o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: bounds on two different date columns (e.g. orders.purchase_date vs reviews.created_at)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN reviews r USING(order_id) WHERE o.purchase_date >= '2026-08-01' AND r.created_at <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: bounds with conflicting aliases (e.g. o1.purchase_date vs o2.purchase_date)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o1 JOIN orders o2 USING(order_id) WHERE o1.purchase_date >= '2026-08-01' AND o2.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: bounds in separate disjunctive branches of an OR clause
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE (purchase_date >= '2026-08-01' AND status = 'delivered') OR (purchase_date <= '2026-08-31' AND status = 'returned')",
        period,
      ),
    ).toBe(false);

    // Invalid: top-level OR before date bounds (unbounded branch leaks rows)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE status = 'returned' OR (purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31')",
        period,
      ),
    ).toBe(false);

    // Invalid: top-level OR after date bounds (unbounded branch leaks rows)
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE (purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31') OR status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Valid: disjunctive branches where ALL branches are individually bounded by period
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE (region = 'North' AND purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31') OR (region = 'South' AND purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31')",
        period,
      ),
    ).toBe(true);

    // Valid: nested OR in unrelated parentheses while date bounds are conjoined with AND
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o WHERE o.purchase_date >= '2026-08-01' AND (o.status = 'delivered' OR o.status = 'shipped') AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Invalid: missing date column altogether
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Invalid: generic created_at column on joined customers table instead of orders.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN customers c USING(customer_id) WHERE c.created_at >= '2026-08-01' AND c.created_at <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: bare created_at instead of purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE created_at >= '2026-08-01' AND created_at <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: reviews.created_at instead of orders.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN reviews r USING(order_id) WHERE r.created_at >= '2026-08-01' AND r.created_at <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: disallowed qualifier c.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN customers c USING(customer_id) WHERE c.purchase_date >= '2026-08-01' AND c.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: unknown qualifier x.purchase_date on joined non-orders table
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN external_events x USING(order_id) WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: unknown qualifier x.purchase_date without orders in FROM
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM external_events x WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: unknown qualifier x.purchase_date when orders is aliased as o
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Valid: orders explicitly aliased as x matches x.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders x WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Valid: orders explicitly aliased as ord matches ord.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders ord WHERE ord.purchase_date >= '2026-08-01' AND ord.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Invalid: alias o used in WHERE but orders was not aliased as o in FROM
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: alias o is assigned to joined table (customers), not the orders fact table
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(ords.price_vnd) FROM orders ords JOIN customers o USING (customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: alias o is assigned to joined customers table while orders has no alias
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(orders.price_vnd) FROM orders JOIN customers o USING (customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: alias ord is assigned to joined sellers table, not orders
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(orders.price_vnd) FROM orders JOIN sellers ord USING (seller_id) WHERE ord.purchase_date >= '2026-08-01' AND ord.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: unknown qualifier x.purchase_date on joined non-orders table
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN external_events x USING(order_id) WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: unknown qualifier x.purchase_date without orders in FROM
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM external_events x WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: unknown qualifier x.purchase_date when orders is aliased as o
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Valid: orders explicitly aliased as x matches x.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders x WHERE x.purchase_date >= '2026-08-01' AND x.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Valid: orders explicitly aliased as ord matches ord.purchase_date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders ord WHERE ord.purchase_date >= '2026-08-01' AND ord.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Invalid: alias o used in WHERE but orders was not aliased as o in FROM
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: alias o is assigned to joined table (customers), not the orders fact table
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(ords.price_vnd) FROM orders ords JOIN customers o USING (customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: alias o is assigned to joined customers table while orders has no alias
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(orders.price_vnd) FROM orders JOIN customers o USING (customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Invalid: alias ord is assigned to joined sellers table, not orders
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(orders.price_vnd) FROM orders JOIN sellers ord USING (seller_id) WHERE ord.purchase_date >= '2026-08-01' AND ord.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Valid: orders fact table date column explicitly qualified
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders o JOIN customers c USING(customer_id) WHERE o.purchase_date >= '2026-08-01' AND o.purchase_date <= '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Valid: UNION ALL where every branch is date-bounded
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31' UNION ALL SELECT SUM(price_vnd) FROM orders WHERE purchase_date BETWEEN '2026-08-01' AND '2026-08-31'",
        period,
      ),
    ).toBe(true);

    // Invalid: UNION ALL where one branch has date filter but another branch has NO WHERE clause
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31' UNION ALL SELECT SUM(price_vnd) FROM orders",
        period,
      ),
    ).toBe(false);

    // Invalid: UNION ALL where one branch has date filter but another branch filters status without date
    expect(
      await verifySqlDateFilter(
        "SELECT SUM(price_vnd) FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31' UNION ALL SELECT SUM(price_vnd) FROM orders WHERE status = 'delivered'",
        period,
      ),
    ).toBe(false);

    // Invalid: 3-way UNION where 2 branches are bounded but 1 branch is unbounded
    expect(
      await verifySqlDateFilter(
        "SELECT 1 FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31' UNION ALL SELECT 2 FROM orders WHERE status = 'delivered' UNION ALL SELECT 3 FROM orders WHERE purchase_date BETWEEN '2026-08-01' AND '2026-08-31'",
        period,
      ),
    ).toBe(false);

    // Valid: CTE with date bounds used in main query
    expect(
      await verifySqlDateFilter(
        "WITH b AS (SELECT * FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31') SELECT SUM(price_vnd) FROM b",
        period,
      ),
    ).toBe(true);

    // Invalid: CTE without date bounds used in main query without WHERE
    expect(
      await verifySqlDateFilter(
        "WITH b AS (SELECT * FROM orders WHERE status = 'delivered') SELECT SUM(price_vnd) FROM b",
        period,
      ),
    ).toBe(false);

    // Invalid: empty SQL
    expect(await verifySqlDateFilter("", period)).toBe(false);
  });

  it("T35-T5_date_filter_rejection: throws error and refuses to use rows when SQL lacks end date", async () => {
    const mockExecutor = {
      run: async () => ({
        status: "ok" as const,
        sql: "SELECT 1000000000 AS val FROM orders WHERE purchase_date >= '2026-08-01' AND status = 'delivered'",
        tablesUsed: ["orders"],
        columns: ["val"],
        rows: [{ val: 1000000000 }],
        maskedColumns: [],
        attempts: 1,
      }),
    };

    const runtime = createRcaRuntime({ executor: mockExecutor });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("error");
    expect(update.answerText).toContain("thiếu bộ lọc ngày theo kỳ yêu cầu");
  });

  it("T35-T5_finite_number_check: rejects Infinity as invalid baseline number", async () => {
    const mockExecutor = {
      run: async () => ({
        status: "ok" as const,
        sql: "SELECT 1/0 AS val FROM orders WHERE purchase_date >= '2026-08-01' AND purchase_date <= '2026-08-31'",
        tablesUsed: ["orders"],
        columns: ["val"],
        rows: [{ val: Infinity }],
        maskedColumns: [],
        attempts: 1,
      }),
    };

    const runtime = createRcaRuntime({ executor: mockExecutor });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("error");
    expect(update.answerText).toContain("không phải là số hợp lệ: Infinity");
  });

  it("T35-T5_insignificant: halts early when metric delta is negligible (< 1%)", async () => {
    // Delta only 0.2%
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("08") ? 1_000_000_000 : 998_000_000; // -0.2%
      },
    };

    const runtime = createRcaRuntime(deps);
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("no_data");
    expect(update.analysisPlan).toBeUndefined();
    expect(update.answerText).toContain("Biến động không đáng kể");
  });

  it("T35-T5_neutral: adapts direction for neutral queries without mutating original intent", async () => {
    // Neutral question: "Tại sao doanh thu tháng 9/2026 khác tháng 8/2026?"
    const q = "Tại sao doanh thu thuần tháng 09/2026 lại khác so với tháng 08/2026?";
    const intent = parseRcaIntent(q);
    expect(intent.isExplicitDirection).toBe(false);
    const originalDirection = intent.direction;

    // Actual DB shows revenue dropped 18.4%
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
    };

    const res = await validateBaseline(q, intent, deps, mockPrincipal);
    expect(res.isValidBaseline).toBe(true);
    expect(res.resolvedDirection).toBe("decrease");
    // Original intent must NOT be mutated in-place
    expect(intent.direction).toBe(originalDirection);
    expect(res.message).toContain("Tiền đề hợp lệ");
  });

  it("T35-T_no_deps_throws: throws explicit error when neither fetchBaseline nor executor is provided", async () => {
    const q = "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?";
    const intent = parseRcaIntent(q);

    // Calling validateBaseline directly with empty deps throws error
    await expect(validateBaseline(q, intent, {}, mockPrincipal)).rejects.toThrow(
      "RCA validateBaseline requires either fetchBaseline",
    );

    // Calling createRcaRuntime({}).entry returns status: 'error'
    const runtime = createRcaRuntime({});
    const mockState = {
      question: q,
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;
    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("error");
    expect(update.answerText).toContain("RCA validateBaseline requires either fetchBaseline");
  });

  it("T35-T_regex_missing_year: parses dates reliably without NaN when second year or both are omitted", () => {
    // Second year omitted: "tháng 9/2026 giảm so với tháng 8"
    const q1 = "Vì sao doanh thu thuần tháng 9/2026 giảm so với tháng 8?";
    const i1 = parseRcaIntent(q1);
    expect(i1.currentPeriod).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(i1.baselinePeriod).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(i1.currentPeriod.start).not.toContain("NaN");
    expect(i1.baselinePeriod.start).not.toContain("NaN");

    // Both years omitted: "tháng 9 giảm so với tháng 8"
    const q2 = "Vì sao doanh thu thuần tháng 9 giảm so với tháng 8?";
    const i2 = parseRcaIntent(q2);
    expect(i2.currentPeriod.start).not.toContain("NaN");
    expect(i2.baselinePeriod.start).not.toContain("NaN");

    // YoY phrasing: "tháng 9/2026 giảm so với cùng kỳ năm trước"
    const q3 = "Vì sao doanh thu thuần tháng 9/2026 giảm so với cùng kỳ năm trước?";
    const i3 = parseRcaIntent(q3);
    expect(i3.currentPeriod).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(i3.baselinePeriod).toEqual({ start: "2025-09-01", end: "2025-09-30" });
  });

  it("T35-T_regex_reversed_order: parses reversed phrasing where baseline precedes current", () => {
    // Month reversed: "So với tháng 08/2026, vì sao doanh thu thuần tháng 09/2026 giảm 18.4%?"
    const q1 = "So với tháng 08/2026, vì sao doanh thu thuần tháng 09/2026 giảm 18.4%?";
    const i1 = parseRcaIntent(q1);
    expect(i1.direction).toBe("decrease");
    expect(i1.baselinePeriod).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(i1.currentPeriod).toEqual({ start: "2026-09-01", end: "2026-09-30" });

    // Quarter reversed: "So với quý 2/2026, quý 3/2026 doanh thu biến động ra sao?"
    const q2 = "So với quý 2/2026, quý 3/2026 doanh thu tăng do đâu?";
    const i2 = parseRcaIntent(q2);
    expect(i2.baselinePeriod).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(i2.currentPeriod).toEqual({ start: "2026-07-01", end: "2026-09-30" });

    // Week reversed: "So với tuần 38/2026, tuần 39/2026 AOV giảm vì sao?"
    const q3 = "So với tuần 38/2026, tuần 39/2026 AOV giảm vì sao?";
    const i3 = parseRcaIntent(q3);
    expect(i3.baselinePeriod).toEqual({ start: "2026-09-14", end: "2026-09-20" });
    expect(i3.currentPeriod).toEqual({ start: "2026-09-21", end: "2026-09-27" });
  });

  it("T35-T_executor_error_not_zero: surfaces SQL execution failure as error, never disguises as zero delta", async () => {
    // When executor fails with SQL error, runtime must return status: 'error' rather than no_data / false_premise
    const failingExecutor = {
      run: async () => {
        return {
          status: "error" as const,
          error: {
            code: "SQL_EXECUTION_ERROR" as const,
            message: "syntax error at or near 'INVALID'",
            retryable: false,
            repairable: true,
          },
          sql: "SELECT INVALID",
          attempts: 3,
        };
      },
    };

    const runtime = createRcaRuntime({ executor: failingExecutor });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("error");
    expect(update.answerText).toContain("syntax error at or near 'INVALID'");
    expect(update.analysisPlan).toBeUndefined();
  });

  it("T35-T_executor_missing_date_filters_rejected: throws when executor SQL omits required period dates", async () => {
    // Executor generates SQL without date filters (e.g. LLM forgot WHERE date condition)
    const badExecutor = {
      run: async () => {
        return {
          status: "ok" as const,
          sql: "SELECT SUM(price_vnd) AS val FROM orders", // missing purchase_date filter!
          tablesUsed: ["orders"],
          columns: ["val"],
          rows: [{ val: 1_000_000 }],
          maskedColumns: [],
          attempts: 1,
        };
      },
    };

    const runtime = createRcaRuntime({ executor: badExecutor });
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("error");
    expect(update.answerText).toContain("thiếu bộ lọc ngày theo kỳ yêu cầu");
  });

  it("T35-T_validated_query_executor_integration: wires ValidatedQueryExecutor and executes queries with safety gate", async () => {
    const executedSqls: string[] = [];
    const mockMcpCaller = {
      call: async (tool: string, args: Record<string, unknown>) => {
        if (tool === "describe_table") {
          return {
            table: args["table"],
            columns: [
              { name: "order_id", type: "text", nullable: false, sensitive: false },
              { name: "price_vnd", type: "numeric", nullable: false, sensitive: false },
              { name: "status", type: "text", nullable: false, sensitive: false },
              { name: "purchase_date", type: "date", nullable: false, sensitive: false },
            ],
            rowCount: 1000,
          };
        }
        if (tool === "explain_query") {
          return { estimatedCost: 10, estimatedRows: 1 };
        }
        if (tool === "run_query") {
          const sql = String(args["sql"] ?? "");
          executedSqls.push(sql);
          const val = sql.includes("2026-08") ? 2_500_000_000 : 2_040_000_000;
          return {
            columns: ["val"],
            rows: [{ val }],
            rowCount: 1,
            truncated: false,
            maskedColumns: [],
            durationMs: 4,
          };
        }
        return {};
      },
    };

    const q = "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?";
    const intent = parseRcaIntent(q);
    const sqlResponses = [intent.baselinePeriod, intent.currentPeriod].map((period) =>
      JSON.stringify({
        sql: buildBaselineQuery(intent.metricName, intent.metricType, period),
        tablesUsed: ["orders", "order_items"],
      }),
    );
    const sqlModel = createChatModel("sql", { fake: { responses: sqlResponses } });

    const runtime = createRcaRuntime({
      mcpCaller: mockMcpCaller,
      sqlModel: sqlModel as never,
    });
    const mockState = {
      question: q,
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("ok");
    expect(update.analysisPlan).toBeDefined();
    expect(update.analysisPlan?.isValidBaseline).toBe(true);
    expect(executedSqls).toHaveLength(2);
    expect(executedSqls[0]).toContain("purchase_date >= '2026-08-01'");
    expect(executedSqls[1]).toContain("purchase_date >= '2026-09-01'");
    expect(update.toolsCalled).toContain("run_query");
  });

  it("T35-T5b: createRcaRuntime halts immediately with false_premise when premise fails", async () => {
    // Database shows significant increase (+12%) when user asked for drop
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("08") ? 2_500_000_000 : 2_800_000_000;
      },
    };

    const runtime = createRcaRuntime(deps);
    const mockState = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as unknown as AgentState;

    const mockRt = {
      emit: () => "span_1",
      config: { configurable: {} },
    };

    const update = await runtime.entry(mockState, mockRt);
    expect(update.status).toBe("false_premise");
    expect(update.analysisPlan).toBeUndefined();
    expect(update.answerText).toContain("Tiền đề không chính xác");
  });

  it("T35-T6: analysisPlan is preserved in AgentState across interrupt and resume on MemorySaver", async () => {
    // Create a minimal workflow with AgentStateSchema to test persistence across MemorySaver checkpoint
    const threadId = makeThreadId("analyst_1", "session_rca");
    const memory = new MemorySaver();

    const planData = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        baselineVal: 2_500_000_000,
        currentVal: 2_040_000_000,
        absDelta: -460_000_000,
        pctDelta: -18.4,
        isValidBaseline: true,
        message: "Tiền đề hợp lệ",
        queriesExecuted: 2,
        lastSql: "SELECT 1",
        tablesUsed: ["orders"],
      },
    );

    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("planner", async () => {
        return {
          status: "ok",
          analysisPlan: planData,
        };
      })
      .addNode("reviewGate", async () => {
        const approved = pauseForApproval({
          action: "review_plan",
          planId: "plan_1",
        });
        return {
          answerText: `Resumed with: ${String(approved)}`,
        };
      })
      .addEdge(START, "planner")
      .addEdge("planner", "reviewGate")
      .addEdge("reviewGate", END)
      .compile({ checkpointer: memory });

    // 1. Initial run suspends at interrupt
    const initialRun = await testGraph.invoke(
      { question: "Vì sao doanh thu giảm?" },
      { configurable: { thread_id: threadId } },
    );

    const interrupts = (initialRun as { __interrupt__?: unknown[] }).__interrupt__;
    expect(interrupts).toBeDefined();
    expect(interrupts).toHaveLength(1);

    // Verify state checkpoint contains analysisPlan
    const savedState = await testGraph.getState({ configurable: { thread_id: threadId } });
    const values = savedState.values as AgentState;
    expect(values.analysisPlan).not.toBeNull();
    expect(values.analysisPlan?.steps[0].dimensionOrFactor).toBe("region");
    expect(values.analysisPlan?.absDelta).toBe(-460_000_000);

    // 2. Resume execution on the same thread
    const resumedRun = (await testGraph.invoke(
      resumeDecision("APPROVE"),
      { configurable: { thread_id: threadId } },
    )) as AgentState;

    expect(resumedRun.analysisPlan).not.toBeNull();
    expect(resumedRun.analysisPlan?.baselineVal).toBe(2_500_000_000);
    expect(resumedRun.answerText).toContain("Resumed with: APPROVE");
  });

  it("integrates with root graph router via ucHandlers or registered entry", async () => {
    const deps = {
      fetchBaseline: async (
        _m: string,
        _t: "additive" | "ratio",
        period: { start: string },
      ) => {
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
    };
    const rcaRuntime = createRcaRuntime(deps);

    const rootGraph = buildRootGraph({
      checkpointer: new MemorySaver(),
      ucHandlers: {
        [RCA_UC_ID]: rcaRuntime.entry,
      },
    });

    const out = (await rootGraph.invoke(
      {
        question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
        ucId: RCA_UC_ID,
      },
      {
        configurable: {
          thread_id: makeThreadId("user_1", "sess_1"),
          runId: "run_test_root",
          userId: "user_1",
          roleScope: "sales_south",
        },
      },
    )) as AgentState;

    expect(out.status).toBe("ok");
    expect(out.analysisPlan).toBeDefined();
    expect(out.analysisPlan?.isValidBaseline).toBe(true);
    expect(out.analysisPlan?.absDelta).toBe(-460_000_000);
  });

  it("T36-T0: helper utilities: toRegionGroup, slugify, and getNextDimension behave correctly", () => {
    expect(toRegionGroup("Miền Bắc")).toBe("Bắc");
    expect(toRegionGroup("Miền Trung")).toBe("Trung");
    expect(toRegionGroup("Miền Nam")).toBe("Nam");
    expect(toRegionGroup("Khác")).toBe("Khác");

    expect(slugify("Đồ gia dụng")).toBe("do_gia_dung");
    expect(slugify("Shopee")).toBe("shopee");

    expect(getNextDimension("region")).toBe("channel");
    expect(getNextDimension("channel")).toBe("category");
    expect(getNextDimension("category")).toBe("product");
    expect(getNextDimension("product")).toBeNull();
  });

  it("T36-T1: HITL interrupt fires and suspends graph with { action: 'review_analysis_plan', plan, currentPlan } on MemorySaver", async () => {
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async () => ({ baselineVal: 100, currentVal: 100 }),
    };
    const rcaRuntime = createRcaRuntime(deps);

    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: new MemorySaver() });

    const threadId = makeThreadId("u_t36", "s_1");
    const result = await testGraph.invoke(
      {
        question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
        ucId: RCA_UC_ID,
      },
      { configurable: { thread_id: threadId } },
    );

    const interrupts = (result as { __interrupt__?: unknown[] }).__interrupt__;
    expect(interrupts).toBeDefined();
    expect(interrupts).toHaveLength(1);

    const interruptPayload = (interrupts![0] as { value: Record<string, unknown> }).value;
    expect(interruptPayload.action).toBe("review_analysis_plan");
    expect(interruptPayload.plan).toBeDefined();
    expect(interruptPayload.currentPlan).toBeDefined();

    const plan = interruptPayload.plan as AnalysisPlan;
    expect(plan.isValidBaseline).toBe(true);
    expect(plan.absDelta).toBe(-460_000_000);
    expect(plan.steps.length).toBe(3);
    expect(plan.steps.every((s) => s.status === "todo")).toBe(true);
  });

  it("T36-T2: Resume with APPROVE continues execution and completes steps", async () => {
    const executedSteps: string[] = [];
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async (step: PlanStep) => {
        executedSteps.push(step.stepId);
        if (step.dimensionValue === "Miền Trung") {
          return { baselineVal: 1_000_000_000, currentVal: 605_000_000 };
        }
        return { baselineVal: 500_000_000, currentVal: 490_000_000 };
      },
    };
    const rcaRuntime = createRcaRuntime(deps);

    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: new MemorySaver() });

    const threadId = makeThreadId("u_t36", "s_2");
    await testGraph.invoke(
      {
        question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
        ucId: RCA_UC_ID,
      },
      { configurable: { thread_id: threadId } },
    );

    const resumed = (await testGraph.invoke(
      resumeDecision({ action: "APPROVE" }),
      { configurable: { thread_id: threadId } },
    )) as AgentState;

    expect(resumed.status).toBe("ok");
    expect(resumed.analysisPlan).toBeDefined();
    expect(resumed.analysisPlan?.steps.some((s) => s.status === "done")).toBe(true);
    expect(executedSteps).toContain("step_region_central");
    expect(resumed.answerText).toContain("Đã hoàn thành phân tích bóc tách");
  });

  it("T36-T3: Resume with MODIFY replaces steps with custom steps and executes them", async () => {
    const executedSteps: string[] = [];
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async (step: PlanStep) => {
        executedSteps.push(step.stepId);
        return { baselineVal: 1_000_000_000, currentVal: 700_000_000 };
      },
    };
    const rcaRuntime = createRcaRuntime(deps);

    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: new MemorySaver() });

    const threadId = makeThreadId("u_t36", "s_3");
    await testGraph.invoke(
      {
        question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
        ucId: RCA_UC_ID,
      },
      { configurable: { thread_id: threadId } },
    );

    const customSteps: PlanStep[] = [
      {
        stepId: "custom_step_shopee",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Shopee",
        dimensionPath: ["Shopee"],
        parentId: null,
        depth: 0,
        status: "todo",
        delta: 0,
        contributionPct: 0,
        sql: null,
        retryCount: 0,
        hypothesis: "Kiểm tra kênh Shopee do người dùng tùy biến",
      },
    ];

    const resumed = (await testGraph.invoke(
      resumeDecision({ action: "MODIFY", steps: customSteps }),
      { configurable: { thread_id: threadId } },
    )) as AgentState;

    expect(resumed.status).toBe("ok");
    expect(resumed.analysisPlan?.steps.some((s) => s.stepId === "custom_step_shopee")).toBe(true);
    expect(executedSteps).toContain("custom_step_shopee");
  });

  it("T36-T4: Pruning: Step with contribution < 30% stays leaf, no children generated, delta added to residualOtherAbs", async () => {
    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [{ id: "step_north", name: "Miền Bắc" }],
    )!;

    const deps = {
      fetchStepMetrics: async () => ({
        baselineVal: 300_000_000,
        currentVal: 280_000_000,
      }),
    };

    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      deps,
      mockPrincipal,
    );

    const step = executed.steps.find((s) => s.stepId === "step_north")!;
    expect(step.status).toBe("skipped");
    expect(step.contributionPct).toBe(10);
    expect(executed.steps.length).toBe(1);
    expect(executed.residualOtherAbs).toBe(20_000_000);
    expect(executed.unexploredBranches).toHaveLength(1);
    expect(executed.unexploredBranches[0].reason).toBe("PRUNED_BELOW_THRESHOLD");
    expect(executed.unexploredBranches[0].dimensionValue).toBe("Miền Bắc");
  });

  it("T36-T5: Drill-down: Step with contribution >= 30% generates child steps at depth + 1", async () => {
    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 600_000_000,
        absDelta: -400_000_000,
        pctDelta: -40.0,
        queriesExecuted: 2,
      },
      [{ id: "step_central", name: "Miền Trung" }],
    )!;

    let callCount = 0;
    const deps = {
      candidateChannels: ["Shopee", "Website"],
      fetchStepMetrics: async () => {
        callCount++;
        if (callCount === 1) {
          return { baselineVal: 500_000_000, currentVal: 180_000_000 };
        }
        return { baselineVal: 100_000_000, currentVal: 95_000_000 };
      },
    };

    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      deps,
      mockPrincipal,
    );

    const parentStep = executed.steps.find((s) => s.stepId === "step_central")!;
    expect(parentStep.status).toBe("done");
    expect(parentStep.contributionPct).toBe(80);

    const childSteps = executed.steps.filter((s) => s.parentId === "step_central");
    expect(childSteps.length).toBe(2);
    expect(childSteps[0].depth).toBe(1);
    expect(childSteps[0].dimensionOrFactor).toBe("channel");
    expect(childSteps.map((c) => c.dimensionValue)).toEqual(["Shopee", "Website"]);
  });

  it("T36-T6: Fault isolation: Step with simulated SQL errors retries 2 times, marks status: 'failed' with errorMessage, and workflow continues", async () => {
    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [
        { id: "step_failing", name: "Miền Bắc" },
        { id: "step_healthy", name: "Miền Nam" },
      ],
    )!;

    let failingAttempts = 0;
    const deps = {
      fetchStepMetrics: async (step: PlanStep) => {
        if (step.stepId === "step_failing") {
          failingAttempts++;
          throw new Error("DB statement_timeout simulated");
        }
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
    };

    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      deps,
      mockPrincipal,
    );

    const failingStep = executed.steps.find((s) => s.stepId === "step_failing")!;
    expect(failingStep.status).toBe("failed");
    expect(failingStep.retryCount).toBe(2);
    expect(failingStep.errorMessage).toContain("DB statement_timeout");
    expect(failingAttempts).toBe(3); // 1 initial + 2 retries

    const healthyStep = executed.steps.find((s) => s.stepId === "step_healthy")!;
    expect(healthyStep.status).toBe("done");
  });

  it("T36-T7: Max queries quota: Stops when totalQueriesCount >= maxQueriesLimit and marks remaining steps 'skipped' with 'MAX_QUERIES_REACHED'", async () => {
    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [
        { id: "step_1", name: "Miền Bắc" },
        { id: "step_2", name: "Miền Trung" },
        { id: "step_3", name: "Miền Nam" },
      ],
    )!;
    plan.steps.forEach((s) => {
      s.depth = 1;
    });

    const deps = {
      maxQueriesLimit: 4,
      maxDepthLimit: 1,
      fetchStepMetrics: async () => ({ baselineVal: 100_000_000, currentVal: 40_000_000 }),
    };

    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      deps,
      mockPrincipal,
    );

    expect(executed.totalQueriesCount).toBe(4);
    const doneSteps = executed.steps.filter((s) => s.status === "done");
    const skippedSteps = executed.steps.filter((s) => s.status === "skipped");
    expect(doneSteps.length).toBe(1);
    expect(skippedSteps.length).toBe(2);

    const quotaBranches = executed.unexploredBranches.filter(
      (b) => b.reason === "MAX_QUERIES_REACHED",
    );
    expect(quotaBranches.length).toBe(2);
  });

  it("T36-T8: Max depth quota: Step at depth = 4 with contribution >= 30% is not expanded, pushed to unexploredBranches with 'MAX_DEPTH_REACHED'", async () => {
    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [],
    )!;

    plan.steps = [
      {
        stepId: "step_depth_4",
        axis: "dimension",
        dimensionOrFactor: "product",
        dimensionValue: "Chảo chống dính Sunhouse",
        dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng", "Chảo chống dính Sunhouse"],
        parentId: "step_depth_3",
        depth: 4,
        status: "todo",
        delta: 0,
        contributionPct: 0,
        sql: null,
        retryCount: 0,
      },
    ];

    const deps = {
      maxDepthLimit: 4,
      fetchStepMetrics: async () => ({
        baselineVal: 200_000_000,
        currentVal: 100_000_000,
      }),
    };

    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      deps,
      mockPrincipal,
    );

    const step = executed.steps.find((s) => s.stepId === "step_depth_4")!;
    expect(step.status).toBe("done");
    expect(step.contributionPct).toBe(50);
    expect(executed.steps.length).toBe(1);

    const maxDepthBranch = executed.unexploredBranches.find(
      (b) => b.reason === "MAX_DEPTH_REACHED",
    );
    expect(maxDepthBranch).toBeDefined();
    expect(maxDepthBranch?.dimensionValue).toBe("Chảo chống dính Sunhouse");
  });

  it("T36-T9: Filter inheritance: Child step inherits parent filters (region + channel) and builds valid SQL", async () => {
    const parentStep: PlanStep = {
      stepId: "step_region_central",
      axis: "dimension",
      dimensionOrFactor: "region",
      dimensionValue: "Miền Trung",
      dimensionPath: ["Miền Trung"],
      parentId: null,
      depth: 0,
      status: "done",
      delta: -395_000_000,
      contributionPct: 85.87,
      sql: null,
      retryCount: 0,
    };

    const childStep: PlanStep = {
      stepId: "step_channel_shopee",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Shopee",
      dimensionPath: ["Miền Trung", "Shopee"],
      parentId: "step_region_central",
      depth: 1,
      status: "todo",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
    };

    const grandChildStep: PlanStep = {
      stepId: "step_cat_do_gia_dung",
      axis: "dimension",
      dimensionOrFactor: "category",
      dimensionValue: "Đồ gia dụng",
      dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
      parentId: "step_channel_shopee",
      depth: 2,
      status: "todo",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
    };

    const allSteps = [parentStep, childStep, grandChildStep];

    const childFilters = collectInheritedFilters(childStep, allSteps);
    expect(childFilters).toEqual({
      channel: "Shopee",
      region: "Miền Trung",
    });

    const grandChildFilters = collectInheritedFilters(grandChildStep, allSteps);
    expect(grandChildFilters).toEqual({
      category: "Đồ gia dụng",
      channel: "Shopee",
      region: "Miền Trung",
    });

    const period = { start: "2026-09-01", end: "2026-09-30" };
    const sql = buildStepQuery("net_revenue", "additive", period, grandChildFilters);

    expect(sql).toContain("c.region_group = 'Trung'");
    expect(sql).toContain("ch.channel_name = 'Shopee'");
    expect(sql).toContain("cat.name_vi = 'Đồ gia dụng'");
    expect(sql).toContain("o.purchase_date >= '2026-09-01'");
    expect(sql).toContain("o.purchase_date <= '2026-09-30'");

    const isValid = await verifySqlDateFilter(sql, period, ["purchase_date"], "orders");
    expect(isValid).toBe(true);
  });

  it("T36-T10: Executor failure is not masked as 0 and triggers retry + failed status", async () => {
    let runs = 0;
    const failingExecutor = {
      run: async () => {
        runs++;
        return {
          status: "error" as const,
          error: { code: "QUERY_TIMEOUT" as const, message: "statement_timeout" },
          sql: null,
          attempts: 1,
        };
      },
    };

    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [{ id: "step_failing", name: "Miền Bắc" }],
    )!;

    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      { executor: failingExecutor },
      mockPrincipal,
    );

    const step = executed.steps.find((s) => s.stepId === "step_failing")!;
    expect(step.status).toBe("failed");
    expect(step.retryCount).toBe(2);
    expect(step.errorMessage).toContain("statement_timeout");
    expect(runs).toBe(3); // 1 initial + 2 retries
  });

  it("T36-T11: Strictly enforces maxQueriesLimit and never exceeds quota during split queries or retries", async () => {
    let queryCalls = 0;
    const mockExecutor = {
      run: async () => {
        queryCalls++;
        return {
          status: "ok" as const,
          sql: "SELECT 100 AS val",
          tablesUsed: ["orders"],
          columns: ["val"],
          rows: [{ val: 100 }],
          maskedColumns: [],
          attempts: 1,
        };
      },
    };

    const plan = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2, // baseline check used 2
      },
      [
        { id: "step_1", name: "Miền Bắc" },
        { id: "step_2", name: "Miền Trung" },
        { id: "step_3", name: "Miền Nam" },
      ],
    )!;

    // Quota of 3: only 1 query can execute (step needs 2, so it stops after 1 query!)
    const executed = await executeAnalysis(
      plan,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      { executor: mockExecutor, maxQueriesLimit: 3 },
      mockPrincipal,
    );

    expect(executed.totalQueriesCount).toBeLessThanOrEqual(3);
    expect(queryCalls).toBeLessThanOrEqual(1);
    expect(executed.unexploredBranches.some((b) => b.reason === "MAX_QUERIES_REACHED")).toBe(true);

    // Verify that multi-attempt queries count all internal SQL executions against quota
    let multiAttemptCalls = 0;
    const repairingExecutor = {
      run: async () => {
        multiAttemptCalls++;
        return {
          status: "ok" as const,
          sql: "SELECT 100 AS val",
          tablesUsed: ["orders"],
          columns: ["val"],
          rows: [{ val: 100 }],
          maskedColumns: [],
          attempts: 2, // 2 SQL attempts inside executor repair loop
        };
      },
    };
    const plan2 = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [
        { id: "s1", name: "Bắc" },
        { id: "s2", name: "Trung" },
      ],
    )!;
    const executed2 = await executeAnalysis(
      plan2,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      { executor: repairingExecutor, maxQueriesLimit: 4 },
      mockPrincipal,
    );
    expect(executed2.totalQueriesCount).toBe(4); // 2 baseline check + 2 from first query = 4 reached!
    expect(multiAttemptCalls).toBe(1); // Second query skipped because quota (4) was reached after 1 call with 2 attempts
  });

  it("T36-T12: Resume does not re-run baseline queries or completed steps across restart without RAM cache", async () => {
    let baselineQueryCalls = 0;
    const executedStepIds: string[] = [];
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) => {
        baselineQueryCalls++;
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
      fetchStepMetrics: async (step: PlanStep) => {
        executedStepIds.push(step.stepId);
        return { baselineVal: 500_000_000, currentVal: 480_000_000 };
      },
    };
    const rcaRuntime1 = createRcaRuntime(deps);
    const sharedCheckpointer = new MemorySaver();

    const testGraph1 = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime1.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: sharedCheckpointer });

    const threadId = makeThreadId("u_t36", "s_persist");

    // 1. First run: baseline runs, plan created, pauses at interrupt
    await testGraph1.invoke(
      {
        question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
        ucId: RCA_UC_ID,
      },
      { configurable: { thread_id: threadId, runId: "run_persist_1" } },
    );

    expect(baselineQueryCalls).toBe(2); // baseline + current

    // 2. Simulate host process restart: completely new runtime & graph instances over the same checkpointer
    const rcaRuntime2 = createRcaRuntime(deps);
    const testGraph2 = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime2.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: sharedCheckpointer });

    // Second run (Resume): baseline MUST NOT re-run!
    const resumed = (await testGraph2.invoke(
      resumeDecision({ action: "APPROVE" }),
      { configurable: { thread_id: threadId, runId: "run_persist_1" } },
    )) as AgentState;

    expect(baselineQueryCalls).toBe(2); // Still 2, zero additional baseline queries!
    expect(resumed.status).toBe("ok");
    expect(executedStepIds.length).toBeGreaterThan(0);
  });

  it("T36-T14: Resume rehydrates plan from checkpointer pendingWrites without in-memory RAM cache", async () => {
    let baselineQueryCalls = 0;
    const deps = {
      fetchBaseline: async () => {
        baselineQueryCalls++;
        return 1_000_000;
      },
    };
    const rcaRuntime = createRcaRuntime(deps);

    // Simulated checkpointer (as PostgresSaver returns from checkpoint_writes table)
    const mockPlan: AnalysisPlan = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
      metricName: "net_revenue",
      metricType: "additive",
      direction: "decrease",
      isExplicitDirection: true,
      currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
      baselineVal: 2_500_000_000,
      currentVal: 2_040_000_000,
      absDelta: -460_000_000,
      pctDelta: -18.4,
      isValidBaseline: true,
      steps: [],
      unexploredBranches: [],
      maxDepthLimit: 4,
      maxQueriesLimit: 20,
      totalQueriesCount: 2,
      drilldownThreshold: 30,
      residualOtherAbs: 0,
      createdAt: new Date().toISOString(),
    };

    const mockCheckpointer = {
      getTuple: async () => ({
        checkpoint: { channel_values: {} },
        pendingWrites: [
          ["t1", "__interrupt__", { id: "int1", value: { action: "review_analysis_plan", currentPlan: mockPlan } }],
        ],
      }),
    } as unknown as BaseCheckpointSaver;

    const mockState: AgentState = {
      runId: "run_dur_1",
      threadId: "chat:u1:s1",
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?",
      ucId: RCA_UC_ID,
      status: "ok",
      answerText: "",
      sql: null,
      tablesUsed: [],
      columns: [],
      resultPreview: [],
      toolsCalled: [],
      intent: null,
      budget: { llmCalls: 0, maxLlmCalls: 10, tokensUsed: 0, maxTokens: 100000, deadlineMs: 0 },
      pendingClarification: null,
      analysisPlan: null,
    };

    const mockRt: RootRuntime = {
      emit: () => "",
      config: {
        configurable: {
          thread_id: "chat:u1:s1",
          runId: "run_dur_1",
          userId: "u1",
          roleScope: "sales_south",
          __pregel_checkpointer: mockCheckpointer,
        },
      },
    };

    const out = await rcaRuntime.entry(mockState, mockRt);
    expect(out.status).toBe("ok");
    expect(out.analysisPlan?.metricName).toBe("net_revenue");
    expect(out.analysisPlan?.absDelta).toBe(-460_000_000);
    expect(baselineQueryCalls).toBe(0); // ZERO baseline calls! Restored completely from checkpointer!
  });

  it("T36-T13: routeQuestionToUc classifies Why/Variance questions and integrates with rootGraph without explicit ucId", async () => {
    expect(routeQuestionToUc("Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?")).toBe(RCA_UC_ID);
    expect(routeQuestionToUc("Tại sao giá trị đơn hàng trung bình (AOV) miền Nam tuần 39/2026 giảm?")).toBe(RCA_UC_ID);
    expect(routeQuestionToUc("Nguyên nhân sụt giảm doanh thu Shopee là gì?")).toBe(RCA_UC_ID);
    expect(routeQuestionToUc("Why did revenue decrease in September?")).toBe(RCA_UC_ID);
    expect(routeQuestionToUc("Root cause of return rate variance")).toBe(RCA_UC_ID);

    // Standard queries use UC-01; explicit tracer requests remain supported.
    expect(routeQuestionToUc("Tổng doanh thu tháng hiện tại")).toBe("text-to-sql");
    expect(routeQuestionToUc("Top 5 sản phẩm bán chạy nhất tháng 8")).toBe("text-to-sql");
    expect(routeQuestionToUc("Tổng doanh thu tháng hiện tại", "tracer")).toBe("tracer");

    // Definitions and column-level reasons belong to UC-01/UC-02, not RCA.
    expect(routeQuestionToUc("Giải thích định nghĩa doanh thu thuần")).toBe("text-to-sql");
    expect(routeQuestionToUc("Giải thích công thức tính AOV")).toBe("text-to-sql");
    expect(routeQuestionToUc("Khách hàng hoạt động nghĩa là gì?")).toBe("text-to-sql");
    expect(routeQuestionToUc("Khách hàng hoạt động được tính thế nào?")).toBe("text-to-sql");
    expect(routeQuestionToUc("Lý do hủy đơn hàng phổ biến nhất trong quý 3 là gì?")).toBe("text-to-sql");
    expect(routeQuestionToUc("Top 3 lý do khách hàng đổi trả hàng")).toBe("text-to-sql");
    expect(routeQuestionToUc("Explain net revenue definition")).toBe("text-to-sql");
    expect(routeQuestionToUc("Reason for cancelled orders in Q3")).toBe("text-to-sql");
    expect(routeQuestionToUc("What is the formula for customer lifetime value?")).toBe("text-to-sql");

    // Root graph automatically routes question to RCA handler when ucId is empty
    let rcaCalled = false;
    const mockRcaEntry = async () => {
      rcaCalled = true;
      return { status: "ok" as const, answerText: "routed to rca" };
    };

    const rootGraph = buildRootGraph({
      checkpointer: new MemorySaver(),
      ucHandlers: {
        [RCA_UC_ID]: mockRcaEntry,
      },
    });

    const out = (await rootGraph.invoke(
      {
        question: "Vì sao doanh thu tháng 9 giảm so với tháng 8?",
        ucId: "", // Not set by caller!
      },
      {
        configurable: {
          thread_id: makeThreadId("u_route", "s_1"),
          runId: "run_route_test",
          userId: "u_route",
          roleScope: "sales_south",
        },
      },
    )) as AgentState;

    expect(rcaCalled).toBe(true);
    expect(out.answerText).toBe("routed to rca");
  });

  it("T36-T15: Resume with REJECT decision stops execution without running steps", async () => {
    let stepsExecuted = 0;
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async () => {
        stepsExecuted++;
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
    };
    const rcaRuntime = createRcaRuntime(deps);
    const memory = new MemorySaver();
    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    const threadId = makeThreadId("u_reject", "s_1");

    // 1. Initial run suspends at HITL interrupt
    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );

    // 2. Resume with REJECT decision
    const resumed = (await testGraph.invoke(
      resumeDecision({ action: "REJECT" }),
      { configurable: { thread_id: threadId } },
    )) as AgentState;

    expect(resumed.status).toBe("ok");
    expect(resumed.answerText).toContain("Kế hoạch phân tích đã bị từ chối bởi người dùng");
    expect(stepsExecuted).toBe(0); // 0 steps executed!
    expect(resumed.analysisPlan?.steps.every((s) => s.status === "todo")).toBe(true);
  });

  it("T36-T16: Resume with invalid/unrecognized decision returns status: 'error' without executing", async () => {
    let stepsExecuted = 0;
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async () => {
        stepsExecuted++;
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
    };
    const rcaRuntime = createRcaRuntime(deps);
    const memory = new MemorySaver();
    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    const threadId = makeThreadId("u_invalid_dec", "s_1");

    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );

    const resumed = (await testGraph.invoke(
      resumeDecision({ action: "UNKNOWN_ACTION" }),
      { configurable: { thread_id: threadId } },
    )) as AgentState;

    expect(resumed.status).toBe("error");
    expect(resumed.answerText).toContain("Quyết định duyệt kế hoạch không hợp lệ");
    expect(stepsExecuted).toBe(0);
  });

  it("T36-T18: Resume with undefined, null, or empty object is rejected with error status and does not execute plan steps", async () => {
    let stepsExecuted = 0;
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async () => {
        stepsExecuted++;
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
    };
    const rcaRuntime = createRcaRuntime(deps);
    const memory = new MemorySaver();
    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    // 1. undefined resume decision: LangGraph rejects empty resume input
    const threadId1 = makeThreadId("u_undef_dec", "s_1");
    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId1 } },
    );
    await expect(
      testGraph.invoke(
        resumeDecision(undefined),
        { configurable: { thread_id: threadId1 } },
      ),
    ).rejects.toThrow();
    expect(stepsExecuted).toBe(0);

    // 2. null resume decision: LangGraph Command rejects null/empty resume input
    const threadId2 = makeThreadId("u_null_dec", "s_2");
    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId2 } },
    );
    await expect(
      testGraph.invoke(
        resumeDecision(null),
        { configurable: { thread_id: threadId2 } },
      ),
    ).rejects.toThrow();
    expect(stepsExecuted).toBe(0);

    // 3. empty object {} resume decision
    const threadId3 = makeThreadId("u_empty_dec", "s_3");
    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId3 } },
    );
    const resumed3 = (await testGraph.invoke(
      resumeDecision({}),
      { configurable: { thread_id: threadId3 } },
    )) as AgentState;
    expect(resumed3.status).toBe("error");
    expect(resumed3.answerText).toContain("Quyết định duyệt kế hoạch không hợp lệ");
    expect(stepsExecuted).toBe(0);
  });

  it("T36-T17: Resume fail-closed: fails with error and executes 0 baseline queries if checkpoint cannot recover plan", async () => {
    let baselineQueryCalls = 0;
    const deps = {
      fetchBaseline: async () => {
        baselineQueryCalls++;
        return 2_000_000_000;
      },
    };
    const rcaRuntime = createRcaRuntime(deps);

    // Mock checkpointer that throws or returns no interrupt write
    const faultyCheckpointer = {
      getTuple: async () => ({
        config: { configurable: { thread_id: "chat:u_fail:s_1" } },
        pendingWrites: [],
      }),
    } as unknown as BaseCheckpointSaver;

    const mockState: AgentState = {
      runId: "run_fail_closed",
      threadId: "chat:u_fail:s_1",
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm?",
      ucId: RCA_UC_ID,
      status: "ok",
      answerText: "",
      sql: null,
      tablesUsed: [],
      columns: [],
      resultPreview: [],
      toolsCalled: [],
      intent: null,
      budget: { llmCalls: 0, maxLlmCalls: 10, tokensUsed: 0, maxTokens: 100000, deadlineMs: 0 },
      pendingClarification: null,
      analysisPlan: null,
    };

    const mockRt: RootRuntime = {
      emit: () => "",
      config: {
        configurable: {
          thread_id: "chat:u_fail:s_1",
          runId: "run_fail_closed",
          userId: "u_fail",
          roleScope: "sales_south",
          __pregel_checkpointer: faultyCheckpointer,
          __pregel_resuming: true, // Marked as resume!
        },
      },
    };

    const out = await rcaRuntime.entry(mockState, mockRt);
    expect(out.status).toBe("error");
    expect(out.answerText).toContain("Lỗi phục hồi state: Không thể khôi phục kế hoạch phân tích");
    expect(baselineQueryCalls).toBe(0); // ZERO baseline queries executed!
  });

  it("T36-T18: Quota edge case: strictly enforces quota when remaining quota is 1 or executor attempts 3 repairs", async () => {
    let executorCalls = 0;
    const receivedMaxAttempts: (number | undefined)[] = [];
    const mockExecutor = {
      run: async (input?: { maxAttempts?: number; question?: string }) => {
        executorCalls++;
        receivedMaxAttempts.push(input?.maxAttempts);
        const attempts =
          typeof input?.maxAttempts === "number" && input.maxAttempts > 0
            ? Math.min(input.maxAttempts, 3)
            : 3;
        const val = input?.question?.includes("baseline") ? 500_000_000 : 400_000_000;
        return {
          status: "ok" as const,
          sql: "SELECT 1",
          tablesUsed: ["orders"],
          columns: ["val"],
          rows: [{ val }],
          maskedColumns: [],
          attempts,
        };
      },
    };

    // Case A: Remaining quota is 1 (maxQueriesLimit: 3, baseline check = 2)
    // Step needs at least 2 queries. Since remaining is 1 (< 2), step should be skipped immediately.
    const planA = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [{ id: "s1", name: "Bắc" }],
    )!;

    const executedA = await executeAnalysis(
      planA,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      { executor: mockExecutor, maxQueriesLimit: 3 },
      mockPrincipal,
    );

    expect(executedA.totalQueriesCount).toBe(2); // Never started step, quota 3 not exceeded
    expect(executorCalls).toBe(0); // Executor was NOT called!
    expect(executedA.steps[0].status).toBe("skipped");
    expect(executedA.unexploredBranches[0].reason).toBe("MAX_QUERIES_REACHED");

    // Case B: Remaining quota is 2 (maxQueriesLimit: 4, baseline check = 2).
    // Both baseline and current queries are allocated exactly 1 attempt (maxAttempts: 1).
    // Both queries execute within their 1-attempt quota without exceeding maxQueriesLimit 4.
    const planB = createPlan(
      "Vì sao doanh thu giảm?",
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      {
        isValidBaseline: true,
        baselineVal: 1_000_000_000,
        currentVal: 800_000_000,
        absDelta: -200_000_000,
        pctDelta: -20.0,
        queriesExecuted: 2,
      },
      [{ id: "s1", name: "Bắc" }],
    )!;

    const executedB = await executeAnalysis(
      planB,
      {
        metricName: "net_revenue",
        metricType: "additive",
        direction: "decrease",
        isExplicitDirection: true,
        currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
        baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
        candidateTables: ["orders"],
      },
      { executor: mockExecutor, maxQueriesLimit: 4 },
      mockPrincipal,
    );

    expect(receivedMaxAttempts).toEqual([1, 1]); // Each query bounded strictly to remaining quota (1 attempt each)
    expect(executedB.totalQueriesCount).toBe(4); // Bounded strictly by maxAttempts without over-running
    expect(executorCalls).toBe(2); // Both baseline and current ran within 1 attempt
    expect(executedB.steps[0].status).toBe("done");
  });

  it("T36-T19: Step-by-step checkpoint persistence: step progress is saved into checkpointer and survives crash", async () => {
    const executedSteps: string[] = [];
    const memory = new MemorySaver();
    const threadId = makeThreadId("u_crash_test", "s_step_ckpt");

    let shouldCrashAfterStep1 = true;

    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async (step: PlanStep) => {
        executedSteps.push(step.stepId);
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
      onStepExecuted: async (step: PlanStep) => {
        if (shouldCrashAfterStep1 && step.stepId.includes("north")) {
          throw new Error("Simulated host process crash after step 1 checkpoint");
        }
      },
    };

    const rcaRuntime1 = createRcaRuntime(deps);
    const testGraph1 = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime1.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    // 1. Initial run creates plan and pauses at review_analysis_plan interrupt
    await testGraph1.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );

    // 2. Resume graph: step 1 checkpoints, then process crashes
    await expect(
      testGraph1.invoke(
        resumeDecision({ action: "APPROVE" }),
        { configurable: { thread_id: threadId } },
      ),
    ).rejects.toThrow("Simulated host process crash after step 1 checkpoint");

    // Verify intermediate step 1 write was persisted in checkpointer
    const tuple = await memory.getTuple({ configurable: { thread_id: threadId } });
    const stepInterruptWrites = tuple?.pendingWrites?.filter(
      (w: unknown[]) => Array.isArray(w) && w[1] === "__interrupt__",
    );
    expect(stepInterruptWrites).toBeDefined();
    expect(stepInterruptWrites!.length).toBeGreaterThan(0);

    // 3. Process restarts: new graph instance recovers state from checkpointer
    shouldCrashAfterStep1 = false;
    const rcaRuntime2 = createRcaRuntime(deps);
    const testGraph2 = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime2.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    const step1CallsBeforeRestart = executedSteps.filter((id) => id.includes("north")).length;
    expect(step1CallsBeforeRestart).toBe(1);

    const resumed = (await testGraph2.invoke(
      resumeDecision({ action: "APPROVE" }),
      { configurable: { thread_id: threadId } },
    )) as AgentState;

    expect(resumed.status).toBe("ok");
    // Step 1 was checkpointed, so on restart it was skipped and NOT re-executed!
    const step1CallsAfterRestart = executedSteps.filter((id) => id.includes("north")).length;
    expect(step1CallsAfterRestart).toBe(1); // Still 1! Never called again!
  });

  it("T36-T20: Fail-fast on step checkpoint error: throws explicit error and aborts if putWrites fails during step execution", async () => {
    const memory = new MemorySaver();
    const threadId = makeThreadId("u_putwrites_fail", "s_step_fail");

    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async () => ({ baselineVal: 500_000_000, currentVal: 400_000_000 }),
    };

    const originalPutWrites = memory.putWrites.bind(memory);
    memory.putWrites = async (config, writes, taskId) => {
      if (typeof taskId === "string" && taskId.startsWith("step_")) {
        throw new Error("Disk full or connection closed during putWrites");
      }
      return originalPutWrites(config, writes, taskId);
    };

    const rcaRuntime = createRcaRuntime(deps);
    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );

    // Resuming will run step 1 and attempt to checkpoint it with putWrites, which must throw
    await expect(
      testGraph.invoke(
        resumeDecision({ action: "APPROVE" }),
        { configurable: { thread_id: threadId } },
      ),
    ).rejects.toThrow("Lỗi lưu checkpoint tiến độ bước");
  });

  it("T36-T21: Fail-fast when currentTuple.config is missing during step checkpointing", async () => {
    const memory = new MemorySaver();
    const threadId = makeThreadId("u_tuple_config_missing", "s_step_fail");

    let inStepExecution = false;
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) =>
        period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
      fetchStepMetrics: async () => {
        inStepExecution = true;
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
    };

    const originalGetTuple = memory.getTuple.bind(memory);
    memory.getTuple = async (config) => {
      const res = await originalGetTuple(config);
      if (inStepExecution && res) {
        return { ...res, config: undefined as unknown as typeof res.config };
      }
      return res;
    };

    const rcaRuntime = createRcaRuntime(deps);
    const testGraph = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: memory });

    await testGraph.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );

    // Resuming will run step 1 and attempt to checkpoint it, but getTuple returns undefined config
    await expect(
      testGraph.invoke(
        resumeDecision({ action: "APPROVE" }),
        { configurable: { thread_id: threadId } },
      ),
    ).rejects.toThrow("Lỗi lưu checkpoint tiến độ bước");
  });

  it("T37-T1: getDisjointLeafNodes excludes parent nodes when a child step is marked done", () => {
    const steps: PlanStep[] = [
      {
        stepId: "step_region_central",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Trung",
        dimensionPath: ["Miền Trung"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: -400_000_000,
        contributionPct: 86.96,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "step_region_north",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Bắc",
        dimensionPath: ["Miền Bắc"],
        parentId: null,
        depth: 0,
        status: "skipped",
        delta: -40_000_000,
        contributionPct: 8.7,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "step_channel_shopee_central",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Shopee",
        dimensionPath: ["Miền Trung", "Shopee"],
        parentId: "step_region_central",
        depth: 1,
        status: "done",
        delta: -350_000_000,
        contributionPct: 76.09,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "step_channel_lazada_central",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Lazada",
        dimensionPath: ["Miền Trung", "Lazada"],
        parentId: "step_region_central",
        depth: 1,
        status: "skipped",
        delta: -50_000_000,
        contributionPct: 10.87,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "step_category_appliances_shopee_central",
        axis: "dimension",
        dimensionOrFactor: "category",
        dimensionValue: "Đồ gia dụng",
        dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
        parentId: "step_channel_shopee_central",
        depth: 2,
        status: "done",
        delta: -300_000_000,
        contributionPct: 65.22,
        sql: "SELECT ...",
        retryCount: 0,
      },
    ];

    const leaves = getDisjointLeafNodes(steps);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].stepId).toBe("step_category_appliances_shopee_central");
    expect(leaves[0].dimensionValue).toBe("Đồ gia dụng");
  });

  it("T37-T2: Waterfall Attribution Math Check PASS: sum of leaves + residual within 5% tolerance", () => {
    const leafNodes: PlanStep[] = [
      {
        stepId: "leaf_1",
        axis: "dimension",
        dimensionOrFactor: "category",
        dimensionValue: "Đồ gia dụng",
        dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
        parentId: "p1",
        depth: 2,
        status: "done",
        delta: -300_000_000,
        contributionPct: 65.22,
        sql: "SELECT 1",
        retryCount: 0,
      },
      {
        stepId: "leaf_2",
        axis: "dimension",
        dimensionOrFactor: "category",
        dimensionValue: "Thời trang",
        dimensionPath: ["Miền Nam", "TikTok Shop", "Thời trang"],
        parentId: "p2",
        depth: 2,
        status: "done",
        delta: -145_000_000,
        contributionPct: 31.52,
        sql: "SELECT 2",
        retryCount: 0,
      },
    ];

    const result = verifyWaterfallAttribution(leafNodes, 15_000_000, -460_000_000);
    expect(result.mathVerified).toBe(true);
    expect(result.mathDiffRatio).toBeLessThanOrEqual(0.05);
    expect(result.deltaExplained).toBe(-460_000_000);
  });

  it("T37-T3: Waterfall Attribution Math Check WARNING: sum differs > 5%", () => {
    const leafNodes: PlanStep[] = [
      {
        stepId: "leaf_1",
        axis: "dimension",
        dimensionOrFactor: "category",
        dimensionValue: "Đồ gia dụng",
        dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
        parentId: "p1",
        depth: 2,
        status: "done",
        delta: -200_000_000,
        contributionPct: 43.48,
        sql: "SELECT 1",
        retryCount: 0,
      },
    ];

    const result = verifyWaterfallAttribution(leafNodes, 10_000_000, -460_000_000);
    expect(result.mathVerified).toBe(false);
    expect(result.mathDiffRatio).toBeGreaterThan(0.05);
  });

  it("T37-T4: identifyPrimaryRootCauses selects top high impact causes sorted by contribution", () => {
    const leaves: PlanStep[] = [
      {
        stepId: "l1",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "TikTok",
        dimensionPath: ["TikTok"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: -80_000_000,
        contributionPct: 17.39,
        sql: "SELECT 1",
        retryCount: 0,
      },
      {
        stepId: "l2",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Shopee",
        dimensionPath: ["Shopee"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: -300_000_000,
        contributionPct: 65.22,
        sql: "SELECT 2",
        retryCount: 0,
      },
      {
        stepId: "l3",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Lazada",
        dimensionPath: ["Lazada"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: -80_000_000,
        contributionPct: 17.39,
        sql: "SELECT 3",
        retryCount: 0,
      },
    ];

    const primary = identifyPrimaryRootCauses(leaves);
    expect(primary).toHaveLength(1);
    expect(primary[0].stepId).toBe("l2");
    expect(primary[0].contributionPct).toBe(65.22);
    expect(primary[0].summaryVi).toContain("giảm");
  });

  it("T37-T5: synthesizeReport generates verified RootCauseAnswer with all 5 report sections and SQL evidence", () => {
    const plan: AnalysisPlan = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      metricName: "net_revenue",
      metricType: "additive",
      direction: "decrease",
      currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
      baselineVal: 2_500_000_000,
      currentVal: 2_040_000_000,
      absDelta: -460_000_000,
      pctDelta: -18.4,
      isValidBaseline: true,
      totalQueriesCount: 6,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      residualOtherAbs: 160_000_000,
      unexploredBranches: [
        {
          axis: "dimension",
          dimensionOrFactor: "region",
          dimensionValue: "Miền Bắc",
          parentId: null,
          reason: "PRUNED_BELOW_THRESHOLD",
        },
      ],
      steps: [
        {
          stepId: "s1",
          axis: "dimension",
          dimensionOrFactor: "category",
          dimensionValue: "Đồ gia dụng",
          dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
          parentId: null,
          depth: 2,
          status: "done",
          delta: -300_000_000,
          contributionPct: 65.22,
          sql: "SELECT SUM(price) FROM order_items WHERE category = 'Đồ gia dụng'",
          retryCount: 0,
        },
      ],
    };

    const answer = synthesizeReport(plan);
    expect(answer.question).toBe(plan.question);
    expect(answer.mathVerified).toBe(true);
    expect(answer.primaryCauses).toHaveLength(1);
    expect(answer.primaryCauses[0].sql).toContain("order_items");
    expect(answer.finalReportMarkdown).toContain("## 1. Hiện tượng & Mức biến động");
    expect(answer.finalReportMarkdown).toContain("## 2. Cây phân rã nguyên nhân");
    expect(answer.finalReportMarkdown).toContain("## 3. Nguyên nhân cốt lõi");
    expect(answer.finalReportMarkdown).toContain("## 4. Kiểm chứng số học Waterfall");
    expect(answer.finalReportMarkdown).toContain("## 5. Nhánh chưa phân tích & Giới hạn");
  });

  it("T37-T6: Waterfall Attribution handles offsetting/cancellation branches correctly", () => {
    const steps: PlanStep[] = [
      {
        stepId: "leaf_neg",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Trung",
        dimensionPath: ["Miền Trung"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: -300_000_000,
        contributionPct: 150.0,
        sql: "SELECT 1",
        retryCount: 0,
      },
      {
        stepId: "leaf_pos",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Nam",
        dimensionPath: ["Miền Nam"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: 100_000_000,
        contributionPct: -50.0,
        sql: "SELECT 2",
        retryCount: 0,
      },
    ];

    const result = verifyWaterfallAttribution(steps, 0, -200_000_000, steps);
    expect(result.mathVerified).toBe(true);
    expect(result.mathDiffRatio).toBe(0);
    expect(result.deltaExplained).toBe(-200_000_000);
  });

  it("T37-T7: Waterfall attribution FAILS when leaf delta has opposite sign to total delta", () => {
    const leafNodes: PlanStep[] = [
      {
        stepId: "wrong_sign_leaf",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Bắc",
        dimensionPath: ["Miền Bắc"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: 100_000_000, // positive attribution
        contributionPct: -100.0,
        sql: "SELECT 1",
        retryCount: 0,
      },
    ];

    // Total delta is negative (-100M). Absolute diff would be |100 - 100| = 0,
    // but strictly signed diff is |100 - (-100)| = 200M (200% diff).
    const result = verifyWaterfallAttribution(leafNodes, 0, -100_000_000);
    expect(result.mathVerified).toBe(false);
    expect(result.mathDiffRatio).toBe(2);
  });

  it("T37-T8: Parent node with all-skipped children is excluded from leaves to prevent double counting", () => {
    const steps: PlanStep[] = [
      {
        stepId: "parent_central",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Trung",
        dimensionPath: ["Miền Trung"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: -400_000_000,
        contributionPct: 100.0,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "child_channel_lazada",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Lazada",
        dimensionPath: ["Miền Trung", "Lazada"],
        parentId: "parent_central",
        depth: 1,
        status: "skipped",
        delta: -250_000_000,
        contributionPct: 62.5,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "child_channel_tiki",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Tiki",
        dimensionPath: ["Miền Trung", "Tiki"],
        parentId: "parent_central",
        depth: 1,
        status: "skipped",
        delta: -150_000_000,
        contributionPct: 37.5,
        sql: "SELECT ...",
        retryCount: 0,
      },
    ];

    // Parent must not be treated as a leaf because it has children in the decomposition tree
    const leaves = getDisjointLeafNodes(steps);
    expect(leaves).toHaveLength(0);

    const skipped = getDisjointSkippedNodes(steps);
    expect(skipped).toHaveLength(2);
    expect(skipped.map((s) => s.stepId)).toEqual(["child_channel_lazada", "child_channel_tiki"]);

    const result = verifyWaterfallAttribution(leaves, 400_000_000, -400_000_000, steps);
    expect(result.mathVerified).toBe(true);
    expect(result.deltaExplained).toBe(-400_000_000);
    expect(result.mathDiffRatio).toBe(0);
  });

  it("T37-T9: Preserves signedResidual = 0 when skipped branches cancel out, not falling back to residualOtherAbs", () => {
    const leaf: PlanStep = {
      stepId: "main_leaf",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Shopee",
      dimensionPath: ["Shopee"],
      parentId: null,
      depth: 0,
      status: "done",
      delta: -200_000_000,
      contributionPct: 100.0,
      sql: "SELECT ...",
      retryCount: 0,
    };

    const skipped1: PlanStep = {
      stepId: "skipped_pos",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Website",
      dimensionPath: ["Website"],
      parentId: null,
      depth: 0,
      status: "skipped",
      delta: 50_000_000, // +50M
      contributionPct: -25.0,
      sql: "SELECT ...",
      retryCount: 0,
    };

    const skipped2: PlanStep = {
      stepId: "skipped_neg",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Tiki",
      dimensionPath: ["Tiki"],
      parentId: null,
      depth: 0,
      status: "skipped",
      delta: -50_000_000, // -50M, cancels out skipped1 to 0 signed residual
      contributionPct: 25.0,
      sql: "SELECT ...",
      retryCount: 0,
    };

    const steps = [leaf, skipped1, skipped2];
    const leaves = [leaf];
    const residualOtherAbs = 100_000_000; // |50M| + |-50M| = 100M
    const totalDelta = -200_000_000;

    // Because signed residual data is present (+50M + -50M = 0), signedResidual must stay 0,
    // not fall back to inferring -100M from residualOtherAbs.
    const result = verifyWaterfallAttribution(leaves, residualOtherAbs, totalDelta, steps);
    expect(result.mathVerified).toBe(true);
    expect(result.deltaExplained).toBe(-200_000_000);
    expect(result.mathDiffRatio).toBe(0);
  });
});

describe("Issue #133 Acceptance Tests (TC-05-01 through TC-05-08)", () => {
  it("TC-05-01: Returns surge between two periods produces negative Return Effect and balances Delta Net Revenue", () => {
    // Baseline: Orders=1000, AOV=500k -> Delivered Rev=500M, Returns=20M -> Net Rev=480M
    // Current: Orders=1000, AOV=500k -> Delivered Rev=500M, Returns=80M -> Net Rev=420M
    // Delta Net Revenue = -60M
    const res = decomposeRevenueFactors({
      orders0: 1000,
      orders1: 1000,
      aov0: 500_000,
      aov1: 500_000,
      returns0: 20_000_000,
      returns1: 80_000_000,
    });

    expect(calculateReturnEffect(20_000_000, 80_000_000)).toBe(-60_000_000);
    expect(res.effectReturns).toBe(-60_000_000);
    expect(res.effectReturns).toBeLessThan(0);
    expect(res.effectOrders).toBe(0);
    expect(res.effectAov).toBe(0);
    expect(res.deltaNetRevenue).toBe(-60_000_000);
    expect(res.effectOrders + res.effectAov + res.effectReturns).toBe(res.deltaNetRevenue);

    // Verify waterfall attribution passes
    const steps: PlanStep[] = [
      {
        stepId: "step_orders",
        axis: "formula",
        dimensionOrFactor: "delivered_orders",
        dimensionValue: null,
        dimensionPath: ["formula", "delivered_orders"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: res.effectOrders,
        contributionPct: 0,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "step_aov",
        axis: "formula",
        dimensionOrFactor: "delivered_aov",
        dimensionValue: null,
        dimensionPath: ["formula", "delivered_aov"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: res.effectAov,
        contributionPct: 0,
        sql: "SELECT ...",
        retryCount: 0,
      },
      {
        stepId: "step_returns",
        axis: "formula",
        dimensionOrFactor: "return_deductions",
        dimensionValue: null,
        dimensionPath: ["formula", "return_deductions"],
        parentId: null,
        depth: 0,
        status: "done",
        delta: res.effectReturns,
        contributionPct: 100,
        sql: "SELECT ...",
        retryCount: 0,
      },
    ];

    const waterfall = verifyWaterfallAttribution(steps, 0, -60_000_000, steps, "formula");
    expect(waterfall.mathVerified).toBe(true);
    expect(waterfall.deltaExplained).toBe(-60_000_000);
    expect(waterfall.mathDiffRatio).toBe(0);
  });

  it("TC-05-02: Zero Delivered Orders in one period omits formula axis and attributes 100% via Dimension Waterfall", () => {
    // Delivered Orders = 0 in baseline period
    expect(canDecomposeOrdersAov(0, 100)).toBe(false);
    expect(canDecomposeOrdersAov(100, 0)).toBe(false);

    // decomposeRevenueFactors handles zero orders safely without throwing Shapley error
    const decomp = decomposeRevenueFactors({
      orders0: 0,
      orders1: 100,
      aov0: 0,
      aov1: 200_000,
      returns0: 0,
      returns1: 5_000_000,
    });
    expect(decomp.methodUsed).toBe("zero_orders_omitted");
    expect(decomp.effectOrders).toBe(0);
    expect(decomp.effectAov).toBe(0);
    expect(decomp.notes).toContain("Delivered Orders = 0");

    // Shapley strictly rejects zero orders
    expect(() => shapleyTwoFactor(0, 100, 0, 200_000)).toThrow(/positive Orders and positive AOV/);

    // createPlan omits formula axis when delivered orders = 0
    const intent = parseRcaIntent("Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?");
    const plan = createPlan(
      "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      intent,
      {
        isValidBaseline: true,
        baselineVal: 200_000_000,
        currentVal: 150_000_000,
        absDelta: -50_000_000,
        pctDelta: -25.0,
        queriesExecuted: 2,
      },
      undefined,
      {
        includeFormulaAxisForAdditive: true,
        deliveredOrdersBaseline: 0,
        deliveredOrdersCurrent: 50,
      },
    );

    expect(plan).not.toBeNull();
    // Formula steps must NOT be added
    const formulaSteps = plan!.steps.filter((s) => s.axis === "formula");
    expect(formulaSteps).toHaveLength(0);
    // All steps belong to dimension waterfall
    const dimSteps = plan!.steps.filter((s) => s.axis === "dimension");
    expect(dimSteps.length).toBeGreaterThan(0);
  });

  it("TC-05-03: Two periods have equal revenue (Y0 = Y1) but Orders and AOV offset, preserving exact algebraic zero sum", () => {
    // Orders doubled (100 -> 200), AOV halved (200k -> 100k)
    // Y0 = 20M, Y1 = 20M, Delta Y = 0
    const res = lmdiDecompose(100, 200, 200_000, 100_000);

    expect(res.deltaDeliveredRevenue).toBe(0);
    expect(res.effectOrders).toBeGreaterThan(0); // Orders doubled: positive force
    expect(res.effectAov).toBeLessThan(0); // AOV halved: negative force
    // Individual forces cancel out completely
    expect(Math.abs(res.effectOrders + res.effectAov)).toBeLessThan(1e-9);
    expect(res.effectOrders + res.effectAov).toBe(0);
  });

  it("TC-05-04: Near-equal revenue (|Y1 - Y0| very small) uses Math.log1p with residual allocation preserving exact equality", () => {
    // High revenue with delta = 1e-9 relative change
    const orders0 = 1000;
    const aov0 = 1_000_000; // Y0 = 1,000,000,000
    const orders1 = 1000.000001;
    const aov1 = 1_000_000; // Y1 = 1,000,000,001

    const y0 = orders0 * aov0;
    const y1 = orders1 * aov1;
    const expectedDelta = y1 - y0;

    const res = lmdiDecompose(orders0, orders1, aov0, aov1);
    expect(Number.isFinite(res.effectOrders)).toBe(true);
    expect(Number.isFinite(res.effectAov)).toBe(true);
    expect(Number.isNaN(res.effectOrders)).toBe(false);
    expect(Number.isNaN(res.effectAov)).toBe(false);
    expect(res.effectOrders + res.effectAov).toBe(expectedDelta);
  });

  it("TC-05-05: Insignificant rate change (|Delta R| < 10^-4) is classified as insignificant_change without mislabeling", () => {
    const segments = [
      { id: "s1", name: "Segment 1", n0: 1000, d0: 10000, n1: 1000.5, d1: 10000 },
    ];
    // R0 = 0.1000, R1 = 0.10005, deltaR = 0.00005 < 1e-4
    const res = shiftShareDecompose(segments);

    expect(Math.abs(res.deltaR)).toBeLessThan(1e-4);
    expect(res.classification).toBe("insignificant_change");
  });

  it("TC-05-06: Shift-Share with Structural Entry and Exit preserves exact 100% total Delta R with R0 reference", () => {
    // Continuing segment A: n0=10, d0=100 (r0=0.10); n1=15, d1=100 (r1=0.15)
    // Exit segment B: n0=20, d0=100 (r0=0.20); n1=0, d1=0
    // Entry segment C: n0=0, d0=0; n1=10, d1=100 (r1=0.10)
    // D0 = 200, N0 = 30 -> R0 = 0.15
    // D1 = 200, N1 = 25 -> R1 = 0.125
    // Delta R = -0.025
    const segments = [
      { id: "seg_cont", name: "Continuing A", n0: 10, d0: 100, n1: 15, d1: 100 },
      { id: "seg_exit", name: "Exit B", n0: 20, d0: 100, n1: 0, d1: 0 },
      { id: "seg_entry", name: "Entry C", n0: 0, d0: 0, n1: 10, d1: 100 },
    ];

    const res = shiftShareDecompose(segments);

    expect(res.r0).toBe(0.15);
    expect(res.r1).toBe(0.125);
    expect(res.deltaR).toBeCloseTo(-0.025, 6);

    const entrySeg = res.segments.find((s) => s.id === "seg_entry")!;
    expect(entrySeg.type).toBe("entry");
    expect(entrySeg.rateEffect).toBe(0);
    // MixEffect_entry = w1 * (r1 - R0) = 0.5 * (0.10 - 0.15) = -0.025
    expect(entrySeg.mixEffect).toBeCloseTo(-0.025, 6);

    const exitSeg = res.segments.find((s) => s.id === "seg_exit")!;
    expect(exitSeg.type).toBe("exit");
    expect(exitSeg.rateEffect).toBe(0);
    // MixEffect_exit = w0 * (R0 - r0) = 0.5 * (0.15 - 0.20) = -0.025
    expect(exitSeg.mixEffect).toBeCloseTo(-0.025, 6);

    const contSeg = res.segments.find((s) => s.id === "seg_cont")!;
    expect(contSeg.type).toBe("continuing");
    // RateEffect_cont = w0 * (r1 - r0) = 0.5 * (0.15 - 0.10) = +0.025
    expect(contSeg.rateEffect).toBeCloseTo(0.025, 6);
    // MixEffect_cont = (w1 - w0) * (r1 - R0) = 0 * (0.15 - 0.15) = 0
    expect(contSeg.mixEffect).toBeCloseTo(0, 6);

    // Conservation check: Total Rate + Total Mix === Delta R
    expect(res.totalRateEffect + res.totalMixEffect).toBeCloseTo(res.deltaR, 6);
    expect(res.totalRateEffect).toBeCloseTo(0.025, 6);
    expect(res.totalMixEffect).toBeCloseTo(-0.050, 6);
  });

  it("TC-05-07: Offsetting Guard triggers when Net Delta < 10% Gross, pruning < 30% components into residual_other", () => {
    const leaf1: PlanStep = {
      stepId: "leaf_shopee",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Shopee",
      dimensionPath: ["Shopee"],
      parentId: null,
      depth: 0,
      status: "done",
      delta: 50_000_000,
      contributionPct: 1000.0,
      sql: "SELECT ...",
      retryCount: 0,
    };

    const leaf2: PlanStep = {
      stepId: "leaf_lazada",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Lazada",
      dimensionPath: ["Lazada"],
      parentId: null,
      depth: 0,
      status: "done",
      delta: -46_000_000,
      contributionPct: -920.0,
      sql: "SELECT ...",
      retryCount: 0,
    };

    const leaf3: PlanStep = {
      stepId: "leaf_tiki",
      axis: "dimension",
      dimensionOrFactor: "channel",
      dimensionValue: "Tiki",
      dimensionPath: ["Tiki"],
      parentId: null,
      depth: 0,
      status: "done",
      delta: 1_000_000,
      contributionPct: 20.0, // < 30% threshold
      sql: "SELECT ...",
      retryCount: 0,
    };

    const totalDelta = 5_000_000; // Net delta = +5M
    const leaves = [leaf1, leaf2, leaf3];

    // Gross = 50M + 46M + 1M = 97M. |5M| < 0.1 * 97M = 9.7M -> Offsetting active!
    const guard = applyOffsettingGuard(leaves, totalDelta, 30.0);

    expect(guard.isOffsettingActive).toBe(true);
    expect(guard.residualOtherStep).not.toBeNull();
    expect(guard.residualOtherStep!.delta).toBe(1_000_000);
    expect(guard.residualOtherStep!.contributionPct).toBe(20.0);
    expect(guard.retainedLeaves).toHaveLength(3); // leaf1, leaf2, residualOtherStep

    // Total delta explained is 100% preserved
    const sumRetained = guard.retainedLeaves.reduce((acc, s) => acc + s.delta, 0);
    expect(sumRetained).toBe(totalDelta);

    // Verify waterfall attribution passes
    const result = verifyWaterfallAttribution(guard.retainedLeaves, 0, totalDelta, guard.retainedLeaves);
    expect(result.mathVerified).toBe(true);
    expect(result.deltaExplained).toBe(totalDelta);
    expect(result.mathDiffRatio).toBe(0);
  });

  it("TC-05-08: Segment Reversal classifies as Simpson's Paradox when 100% comparable subgroups reverse, else Mix-Induced Reversal or Mix-Dominated", () => {
    // Sub-case A: True Simpson's Paradox (100% comparable subgroups reversed)
    // Subgroup 1: D0=100, N0=20 (20%); D1=800, N1=120 (15%) -> Delta R1 = -5% (decrease)
    // Subgroup 2: D0=900, N0=90 (10%); D1=200, N1=10 (5%) -> Delta R2 = -5% (decrease)
    // Total: D0=1000, N0=110 (11%); D1=1000, N1=130 (13%) -> Total Delta R = +2% (increase!)
    const simpsonSegments = [
      { id: "g1", name: "High-risk group", n0: 20, d0: 100, n1: 120, d1: 800 },
      { id: "g2", name: "Low-risk group", n0: 90, d0: 900, n1: 10, d1: 200 },
    ];
    const simpsonRes = shiftShareDecompose(simpsonSegments);
    expect(simpsonRes.deltaR).toBeGreaterThan(0); // Overall rate increased (+2%)
    expect(simpsonRes.totalRateEffect).toBeLessThan(0); // Rate effect decreased
    expect(simpsonRes.classification).toBe("simpsons_paradox");

    // Sub-case B: Mix-Induced Reversal (only 1 of 2 subgroups reversed)
    // Group 1: 20% -> 15% (decreased by -5%) with dominant baseline weight (w0 = 10/11)
    // Group 2: 30% -> 35% (increased by +5%) with small baseline weight (w0 = 1/11)
    // Total rate effect is negative (-0.0409), but mix shifts heavily to Group 2 (w1 = 8/10),
    // driving total rate up from 20.91% to 31.00% (deltaR = +0.1009 > 0).
    const reversalSegments = [
      { id: "g1", name: "Group 1", n0: 200, d0: 1000, n1: 30, d1: 200 },
      { id: "g2", name: "Group 2", n0: 30, d0: 100, n1: 280, d1: 800 },
    ];
    const revRes = shiftShareDecompose(reversalSegments);
    expect(revRes.deltaR).toBeGreaterThan(0);
    expect(revRes.totalRateEffect).toBeLessThan(0);
    expect(revRes.classification).toBe("mix_induced_reversal");

    // Sub-case C: Mix-Dominated (Rate Effect < 1e-4)
    const mixDomSegments = [
      { id: "g1", name: "Group 1", n0: 10, d0: 100, n1: 50, d1: 500 }, // 10% -> 10% (rate unchanged)
      { id: "g2", name: "Group 2", n0: 50, d0: 100, n1: 10, d1: 20 },  // 50% -> 50% (rate unchanged)
    ];
    const mixDomRes = shiftShareDecompose(mixDomSegments);
    expect(Math.abs(mixDomRes.totalRateEffect)).toBeLessThan(1e-4);
    expect(mixDomRes.classification).toBe("mix_dominated");
  });

  it("TC-05-09: Mixed plan (Formula + Dimension) independently validates both axes and preserves formula drivers in report", () => {
    const totalDelta = -460_000_000;
    const plan: AnalysisPlan = {
      question: "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      metricName: "net_revenue",
      metricType: "additive",
      direction: "decrease",
      currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
      baselineVal: 2_500_000_000,
      currentVal: 2_040_000_000,
      absDelta: totalDelta,
      pctDelta: -18.4,
      isValidBaseline: true,
      totalQueriesCount: 8,
      maxQueriesLimit: 20,
      maxDepthLimit: 4,
      drilldownThreshold: 30,
      residualOtherAbs: 60_000_000,
      unexploredBranches: [],
      steps: [
        // Formula Axis Steps (sum = -460M)
        {
          stepId: "f_orders",
          axis: "formula",
          dimensionOrFactor: "delivered_orders",
          dimensionValue: null,
          dimensionPath: ["formula", "delivered_orders"],
          parentId: null,
          depth: 0,
          status: "done",
          delta: -300_000_000,
          contributionPct: 65.22,
          sql: "SELECT COUNT(*)",
          retryCount: 0,
        },
        {
          stepId: "f_aov",
          axis: "formula",
          dimensionOrFactor: "delivered_aov",
          dimensionValue: null,
          dimensionPath: ["formula", "delivered_aov"],
          parentId: null,
          depth: 0,
          status: "done",
          delta: -140_000_000,
          contributionPct: 30.43,
          sql: "SELECT AVG(price)",
          retryCount: 0,
        },
        {
          stepId: "f_returns",
          axis: "formula",
          dimensionOrFactor: "return_deductions",
          dimensionValue: null,
          dimensionPath: ["formula", "return_deductions"],
          parentId: null,
          depth: 0,
          status: "done",
          delta: -20_000_000,
          contributionPct: 4.35,
          sql: "SELECT SUM(returns)",
          retryCount: 0,
        },
        // Dimension Axis Steps (sum = -400M leaves + 60M residual = -460M)
        {
          stepId: "d_central",
          axis: "dimension",
          dimensionOrFactor: "region",
          dimensionValue: "Miền Trung",
          dimensionPath: ["Miền Trung"],
          parentId: null,
          depth: 0,
          status: "done",
          delta: -400_000_000,
          contributionPct: 86.96,
          sql: "SELECT SUM(price) WHERE region = 'Trung'",
          retryCount: 0,
        },
      ],
    };

    const answer = synthesizeReport(plan);
    expect(answer.mathVerified).toBe(true);
    expect(answer.mathDiffRatio).toBeLessThanOrEqual(0.05);

    // Primary causes must contain drivers from both axes
    const formulaCauses = answer.primaryCauses.filter((c) => c.axis === "formula");
    const dimCauses = answer.primaryCauses.filter((c) => c.axis === "dimension");
    expect(formulaCauses.length).toBeGreaterThanOrEqual(1);
    expect(dimCauses.length).toBeGreaterThanOrEqual(1);
    expect(formulaCauses[0].dimensionOrFactor).toBe("delivered_orders");
    expect(dimCauses[0].dimensionValue).toBe("Miền Trung");

    // Markdown report mentions multi-axis verification
    expect(answer.finalReportMarkdown).toContain("Xác minh đa trục");
  });

  it("TC-05-10: executeAnalysis executes LMDI decomposition in runtime, updating step deltas and contribution percentages", async () => {
    const baselineVal = 2_000_000_000;
    const currentVal = 1_540_000_000;
    const absDelta = currentVal - baselineVal; // -460_000_000

    const intent = parseRcaIntent("Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?");
    const plan = createPlan(
      "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      intent,
      {
        isValidBaseline: true,
        baselineVal,
        currentVal,
        absDelta,
        pctDelta: -23.0,
        queriesExecuted: 2,
      },
      undefined,
      { includeFormulaAxisForAdditive: true },
    );

    // Mock step queries:
    // orders: 10,000 -> 8,000
    // aov: 205,000 -> 200,000
    // returns: 50,000,000 -> 60,000,000 (delta +10M, Return Effect = -10M)
    const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
      step_factor_delivered_orders: { baselineVal: 10_000, currentVal: 8_000 },
      step_factor_delivered_aov: { baselineVal: 205_000, currentVal: 200_000 },
      step_factor_return_deductions: { baselineVal: 50_000_000, currentVal: 60_000_000 },
      step_region_central: { baselineVal: 1_000_000_000, currentVal: 600_000_000 },
      step_region_north: { baselineVal: 600_000_000, currentVal: 560_000_000 },
      step_region_south: { baselineVal: 400_000_000, currentVal: 380_000_000 },
    };

    const deps: RcaRuntimeDeps = {
      fetchStepMetrics: async (step) =>
        stepMetricsMap[step.stepId] ?? { baselineVal: 100_000_000, currentVal: 100_000_000 },
      maxDepthLimit: 1,
    };

    const executedPlan = await executeAnalysis(
      plan,
      intent,
      deps,
      { runId: "test_run", userId: "test_user", roleScope: "admin" },
    );

    const ordersStep = executedPlan.steps.find((s) => s.dimensionOrFactor === "delivered_orders");
    const aovStep = executedPlan.steps.find((s) => s.dimensionOrFactor === "delivered_aov");
    const returnsStep = executedPlan.steps.find((s) => s.dimensionOrFactor === "return_deductions");

    expect(ordersStep).toBeDefined();
    expect(aovStep).toBeDefined();
    expect(returnsStep).toBeDefined();

    // Verify that ordersStep.delta is NOT the raw count diff (-2000), but attributed VND impact
    expect(ordersStep!.delta).toBeLessThan(-100_000_000);
    expect(aovStep!.delta).toBeLessThan(0);
    expect(returnsStep!.delta).toBe(-10_000_000);

    const formulaSum = ordersStep!.delta + aovStep!.delta + returnsStep!.delta;
    // LMDI exactly attributes delivered revenue + returns to total net revenue delta
    const expectedDeliveredDelta = (8_000 * 200_000) - (10_000 * 205_000); // 1.6B - 2.05B = -450M
    expect(formulaSum).toBeCloseTo(expectedDeliveredDelta - 10_000_000, 2);
  });

  it("TC-05-11: executeAnalysis with shiftShareSegments assigns Rate and Mix effects into dimension steps", async () => {
    const baselineVal = 0.20; // 20% Return Rate
    const currentVal = 0.15; // 15% Return Rate
    const absDelta = -0.05;

    const intent = parseRcaIntent("Vì sao tỷ lệ trả hàng (return_rate) tháng 09/2026 giảm so với tháng 08/2026?");
    const plan = createPlan(
      "Vì sao tỷ lệ trả hàng tháng 09/2026 giảm?",
      intent,
      {
        isValidBaseline: true,
        baselineVal,
        currentVal,
        absDelta,
        pctDelta: -25.0,
        queriesExecuted: 2,
      },
      undefined,
      { includeFormulaAxisForAdditive: true },
    );

    const shiftShareSegments: ShiftShareSegment[] = [
      { id: "step_region_north", name: "Miền Bắc", n0: 100, d0: 500, n1: 60, d1: 400 },
      { id: "step_region_central", name: "Miền Trung", n0: 50, d0: 250, n1: 30, d1: 300 },
      { id: "step_region_south", name: "Miền Nam", n0: 50, d0: 250, n1: 60, d1: 300 },
    ];

    const deps: RcaRuntimeDeps = {
      shiftShareSegments,
      fetchStepMetrics: async () => ({ baselineVal: 0.20, currentVal: 0.15 }),
      candidateChannels: [],
    };

    const executedPlan = await executeAnalysis(
      plan,
      intent,
      deps,
      { runId: "test_run", userId: "test_user", roleScope: "admin" },
    );

    const northStep = executedPlan.steps.find((s) => s.stepId === "step_region_north");
    expect(northStep).toBeDefined();
    expect(northStep!.hypothesis).toContain("Shift-Share");
    expect(northStep!.hypothesis).toContain("RateEffect=");
    expect(northStep!.hypothesis).toContain("MixEffect=");

    const totalSegDelta = executedPlan.steps
      .filter((s) => s.axis === "dimension")
      .reduce((sum, s) => sum + s.delta, 0);

    expect(totalSegDelta).toBeCloseTo(absDelta, 5);
  });

  it("TC-05-12: decomposeRevenueFactors safely omits formula axis when AOV is zero in one period", () => {
    // Case 1: aov0 = 0, aov1 > 0
    const res1 = decomposeRevenueFactors({
      orders0: 100,
      orders1: 150,
      aov0: 0,
      aov1: 200_000,
      returns0: 0,
      returns1: 0,
    });
    expect(res1.methodUsed).toBe("zero_orders_omitted");
    expect(res1.effectOrders).toBe(0);
    expect(res1.effectAov).toBe(0);
    expect(res1.notes).toContain("AOV <= 0");
    expect(canDecomposeOrdersAov(100, 150, 0, 200_000)).toBe(false);

    // Case 2: aov0 > 0, aov1 = 0
    const res2 = decomposeRevenueFactors({
      orders0: 100,
      orders1: 150,
      aov0: 200_000,
      aov1: 0,
      returns0: 0,
      returns1: 0,
    });
    expect(res2.methodUsed).toBe("zero_orders_omitted");
    expect(res2.effectOrders).toBe(0);
    expect(res2.effectAov).toBe(0);
    expect(res2.notes).toContain("AOV <= 0");
    expect(canDecomposeOrdersAov(100, 150, 200_000, 0)).toBe(false);
  });

  it("TC-05-13: decomposeRevenueFactors and helpers safely reject formula decomposition when AOV is negative", () => {
    // Negative AOV in period 0
    const resNeg0 = decomposeRevenueFactors({
      orders0: 100,
      orders1: 150,
      aov0: -10_000,
      aov1: 200_000,
      returns0: 0,
      returns1: 0,
    });
    expect(resNeg0.methodUsed).toBe("zero_orders_omitted");
    expect(resNeg0.effectOrders).toBe(0);
    expect(resNeg0.effectAov).toBe(0);
    expect(resNeg0.notes).toContain("AOV <= 0");
    expect(canDecomposeOrdersAov(100, 150, -10_000, 200_000)).toBe(false);

    // Negative AOV in period 1
    const resNeg1 = decomposeRevenueFactors({
      orders0: 100,
      orders1: 150,
      aov0: 200_000,
      aov1: -50_000,
      returns0: 0,
      returns1: 0,
    });
    expect(resNeg1.methodUsed).toBe("zero_orders_omitted");
    expect(resNeg1.effectOrders).toBe(0);
    expect(resNeg1.effectAov).toBe(0);
    expect(resNeg1.notes).toContain("AOV <= 0");
    expect(canDecomposeOrdersAov(100, 150, 200_000, -50_000)).toBe(false);

    // Raw shapley throws explicit error
    expect(() => shapleyTwoFactor(100, 150, -10_000, 200_000)).toThrow(/positive Orders and positive AOV/);
    expect(() => shapleyTwoFactor(100, 150, 200_000, -50_000)).toThrow(/positive Orders and positive AOV/);

    // Raw lmdi returns safe fallback without throwing
    const lmdiFallback = lmdiDecompose(100, 150, -10_000, 200_000);
    expect(lmdiFallback.effectOrders).toBe(0);
    expect(lmdiFallback.effectAov).toBe(0);
  });

  it("TC-05-14: Net delta with delivered revenue change but invalid AOV omits all formula steps and attributes 100% via dimensions", async () => {
    const baselineVal = 2_000_000_000;
    const currentVal = 1_500_000_000;
    const absDelta = -500_000_000;

    const intent = parseRcaIntent("Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?");
    const plan = createPlan(
      "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?",
      intent,
      {
        isValidBaseline: true,
        baselineVal,
        currentVal,
        absDelta,
        pctDelta: -25.0,
        queriesExecuted: 2,
      },
      undefined,
      { includeFormulaAxisForAdditive: true },
    );

    // Mock step queries:
    // orders: 10,000 -> 7,500
    // aov: 0 -> 200,000 (AOV0 = 0 is invalid!)
    // returns: 0 -> 0
    const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
      step_factor_delivered_orders: { baselineVal: 10_000, currentVal: 7_500 },
      step_factor_delivered_aov: { baselineVal: 0, currentVal: 200_000 },
      step_factor_return_deductions: { baselineVal: 0, currentVal: 0 },
      step_region_central: { baselineVal: 1_200_000_000, currentVal: 800_000_000 }, // -400M
      step_region_north: { baselineVal: 500_000_000, currentVal: 450_000_000 },    // -50M
      step_region_south: { baselineVal: 300_000_000, currentVal: 250_000_000 },    // -50M
    };

    const deps: RcaRuntimeDeps = {
      fetchStepMetrics: async (step) =>
        stepMetricsMap[step.stepId] ?? { baselineVal: 0, currentVal: 0 },
      candidateChannels: [],
      drilldownThreshold: 5.0,
    };

    const executedPlan = await executeAnalysis(
      plan,
      intent,
      deps,
      { runId: "test_run", userId: "test_user", roleScope: "admin" },
    );

    // All formula steps must be marked skipped
    const formulaSteps = executedPlan.steps.filter((s) => s.axis === "formula");
    expect(formulaSteps.length).toBe(3);
    for (const fs of formulaSteps) {
      expect(fs.status).toBe("skipped");
    }

    // unexploredBranches must contain formula_axis with PRUNED_BELOW_THRESHOLD
    const formulaUnexplored = executedPlan.unexploredBranches.find((b) => b.dimensionOrFactor === "formula_axis");
    expect(formulaUnexplored).toBeDefined();
    expect(formulaUnexplored?.reason).toBe("PRUNED_BELOW_THRESHOLD");

    // Dimension steps are executed and explain 100% of delta
    const dimLeaves = executedPlan.steps.filter((s) => s.axis === "dimension" && s.status === "done");
    const dimSum = dimLeaves.reduce((sum, s) => sum + s.delta, 0);
    expect(dimSum).toBeCloseTo(absDelta, 2);

    // synthesizeReport succeeds with mathVerified: true and solely dimension causes
    const answer = synthesizeReport(executedPlan);
    expect(answer.mathVerified).toBe(true);
    expect(answer.primaryCauses.every((c) => c.axis === "dimension")).toBe(true);
    expect(answer.finalReportMarkdown).not.toContain("Xác minh đa trục");
  });

  it("TC-05-15: lmdiDecompose with Y0 === Y1 respects deltaDeliveredRevenueTarget when provided", () => {
    // orders0 = 100, aov0 = 100 -> Y0 = 10,000
    // orders1 = 200, aov1 = 50  -> Y1 = 10,000
    // Y0 === Y1, but caller specifies target = 500 (e.g. slight external adjustment or target)
    const resWithTarget = lmdiDecompose(100, 200, 100, 50, 500);
    expect(resWithTarget.deltaDeliveredRevenue).toBe(500);
    expect(resWithTarget.effectOrders + resWithTarget.effectAov).toBeCloseTo(500, 6);

    // Default target undefined -> deltaDeliveredRevenue === 0
    const resDefault = lmdiDecompose(100, 200, 100, 50);
    expect(resDefault.deltaDeliveredRevenue).toBe(0);
    expect(resDefault.effectOrders + resDefault.effectAov).toBeCloseTo(0, 6);
  });

  it("TC-05-16: All decomposition helpers reject non-finite (NaN, Infinity) values safely", () => {
    // 1. canDecomposeOrdersAov rejects NaN and Infinity
    expect(canDecomposeOrdersAov(NaN, 100, 200_000, 200_000)).toBe(false);
    expect(canDecomposeOrdersAov(100, Infinity, 200_000, 200_000)).toBe(false);
    expect(canDecomposeOrdersAov(100, 100, NaN, 200_000)).toBe(false);
    expect(canDecomposeOrdersAov(100, 100, 200_000, -Infinity)).toBe(false);

    // 2. lmdiDecompose returns safe fallback on NaN / Infinity without throwing
    const lmdiNan = lmdiDecompose(NaN, 100, 200_000, 200_000);
    expect(lmdiNan.effectOrders).toBe(0);
    expect(lmdiNan.effectAov).toBe(0);
    expect(lmdiNan.deltaDeliveredRevenue).toBe(0);

    const lmdiInf = lmdiDecompose(100, 100, Infinity, 200_000);
    expect(lmdiInf.effectOrders).toBe(0);
    expect(lmdiInf.effectAov).toBe(0);

    // 3. shapleyTwoFactor throws descriptive error on non-finite values
    expect(() => shapleyTwoFactor(NaN, 100, 200_000, 200_000)).toThrow(/positive Orders and positive AOV/);
    expect(() => shapleyTwoFactor(100, 100, Infinity, 200_000)).toThrow(/positive Orders and positive AOV/);

    // 4. calculateReturnEffect returns 0 on non-finite
    expect(calculateReturnEffect(NaN, 100)).toBe(0);
    expect(calculateReturnEffect(100, Infinity)).toBe(0);

    // 5. decomposeRevenueFactors safely omits formula axis on non-finite values
    const resDecomp = decomposeRevenueFactors({
      orders0: 100,
      orders1: 150,
      aov0: 200_000,
      aov1: Infinity,
      returns0: 0,
      returns1: 0,
    });
    expect(resDecomp.methodUsed).toBe("zero_orders_omitted");
    expect(resDecomp.notes).toContain("Non-finite values");

    // 6. decomposeRatioFormula safely falls back on non-finite
    const ratioNan = decomposeRatioFormula(NaN, 100, 200, 200);
    expect(ratioNan.effectNumerator).toBe(0);
    expect(ratioNan.effectDenominator).toBe(0);
  });
});
