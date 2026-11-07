import { describe, expect, it } from "vitest";
import { MemorySaver, StateGraph, START, END } from "@langchain/langgraph";
import {
  buildBaselineQuery,
  createPlan,
  createRcaRuntime,
  parseRcaIntent,
  validateBaseline,
  RCA_UC_ID,
} from "../src/subgraphs/rootCauseAnalysis.js";
import { createChatModel } from "../src/models/factory.js";
import { buildRootGraph } from "../src/graph.js";
import { getUcEntry, isKnownUc } from "../src/subgraphs/registry.js";
import { pauseForApproval, resumeDecision, makeThreadId } from "../src/hitl.js";
import { AgentStateSchema, type AgentState } from "../src/state.js";

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
});

