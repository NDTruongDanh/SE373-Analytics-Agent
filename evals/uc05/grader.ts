// UC-05 eval grader (PRD §4.3, §6, docs/UC-plan/UC05.md §VI): pure, deterministic.
// Grades all 7 acceptance cases (EC-01 to EC-07) for Root Cause Analysis:
// 1. Seeded Scenario 1 (Net revenue drop, Shopee x Miền Trung x Đồ gia dụng)
// 2. Seeded Scenario 2 (AOV ratio drop, TikTok Shop x Thời trang nữ)
// 3. Seeded Scenario 3 (Net revenue growth, Website x Laptop & IT)
// 4. False premise early stop (stops in <= 2 queries with false_premise)
// 5. HITL Plan modification (executes modified custom plan)
// 6. Fault isolation (isolated SQL failure with retry, other branches finish)
// 7. Hard quota enforcement (stops at maxQueriesLimit with MAX_QUERIES_REACHED)

import { readFileSync } from "node:fs";
import path from "node:path";
import { MemorySaver, StateGraph, START, END } from "../../packages/agent/node_modules/@langchain/langgraph/dist/index.js";
import {
  createRcaRuntime,
  type RcaRuntimeDeps,
} from "../../packages/agent/src/subgraphs/rootCauseAnalysis.js";
import { AgentStateSchema, type AgentState, type RootRuntime } from "../../packages/agent/src/state.js";
import { resumeDecision, makeThreadId } from "../../packages/agent/src/hitl.js";
import type { PlanStep } from "../../packages/contracts/src/index.js";

export interface GradedCase {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
  note?: string;
}

interface CaseItem {
  id: string;
  caseId: string;
  name: string;
  question: string;
  expectedMetric: string;
  expectedDirection: string;
  expectedDimensions?: string[];
  expectedMathPass?: boolean;
  expectedStatus: string;
  maxQueriesAllowed?: number;
  hitlAction?: string;
  simulateErrorBranch?: boolean;
  maxQueriesLimit?: number;
  notes?: string;
}

function readJsonl(file: string): CaseItem[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CaseItem);
}

function fakeRuntime(): RootRuntime {
  return {
    emit: () => "span_eval_uc05",
    config: {
      configurable: {
        runId: "run_eval_uc05",
        userId: "eval_grader",
        roleScope: "sales_south",
      },
    },
  } as unknown as RootRuntime;
}

function fakeState(question: string): AgentState {
  return {
    question,
    ucId: "root-cause-analysis",
    status: "ok",
    answerText: "",
    sql: null,
    tablesUsed: [],
    columns: [],
    resultPreview: [],
    totalRows: 0,
    toolsCalled: [],
    clarificationRounds: 0,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
    intent: {
      metric: null,
      dimensions: [],
      filters: [],
      queryMode: "standard_query",
    },
    semanticChunks: [],
    budget: {
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      sqlAttempts: 0,
      sqlFailures: 0,
      repairs: 0,
      estimatedCostUsd: 0,
    },
    vizSpec: null,
  };
}

export async function gradeUc05(repoRoot: string): Promise<{
  cases: GradedCase[];
  summary: Record<string, unknown>;
}> {
  const casesFile = path.join(repoRoot, "evals", "uc05", "cases.jsonl");
  const caseItems = readJsonl(casesFile);
  const results: GradedCase[] = [];

  for (const c of caseItems) {
    const startMs = Date.now();
    let exPass = false;
    let note = "";

    try {
      if (c.caseId === "EC-01") {
        // KB1: August 2.50B, September 2.04B (-460M, -18.4%)
        // Dimension hierarchy: Region -> Channel -> Category -> Product
        const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
          step_region_central: { baselineVal: 1_200_000_000, currentVal: 800_000_000 }, // -400M (86.96%) -> expand
          step_region_north: { baselineVal: 800_000_000, currentVal: 760_000_000 }, // -40M (8.7%) -> skipped
          step_region_south: { baselineVal: 500_000_000, currentVal: 480_000_000 }, // -20M (4.35%) -> skipped
          step_channel_shopee_step_region_central: { baselineVal: 800_000_000, currentVal: 450_000_000 }, // -350M (76.09%) -> expand
          step_channel_lazada_step_region_central: { baselineVal: 250_000_000, currentVal: 220_000_000 }, // -30M -> skipped
          step_channel_tiki_step_region_central: { baselineVal: 150_000_000, currentVal: 130_000_000 }, // -20M -> skipped
          step_category_do_gia_dung_step_channel_shopee_step_region_central: { baselineVal: 500_000_000, currentVal: 200_000_000 }, // -300M (65.22%) -> done
          step_category_thoi_trang_step_channel_shopee_step_region_central: { baselineVal: 200_000_000, currentVal: 170_000_000 }, // -30M -> skipped
          step_category_my_pham_step_channel_shopee_step_region_central: { baselineVal: 100_000_000, currentVal: 80_000_000 }, // -20M -> skipped
        };

        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          maxDepthLimit: 2,
          candidateChannels: ["Shopee", "Lazada", "Tiki"],
          candidateCategories: ["Đồ gia dụng", "Thời trang", "Mỹ phẩm"],
          candidateProducts: ["Nồi chiên không dầu", "Máy ép chậm"],
          fetchBaseline: async (_m, _t, period) =>
            period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
          fetchStepMetrics: async (step) =>
            stepMetricsMap[step.stepId] ?? { baselineVal: 100_000_000, currentVal: 90_000_000 },
        };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        const primaryCauses = out.rootCauseAnswer?.primaryCauses ?? [];
        const foundDims = primaryCauses.some((cause) => {
          const pathJoined = cause.dimensionPath.join(" ");
          return pathJoined.includes("Miền Trung") && pathJoined.includes("Shopee") && pathJoined.includes("Đồ gia dụng");
        });

        const mathOk = Boolean(out.rootCauseAnswer?.mathVerified && (out.rootCauseAnswer?.mathDiffRatio ?? 1) <= 0.05);
        exPass = out.status === "ok" && foundDims && mathOk;
        note = exPass
          ? `Passed: found Shopee x Miền Trung x Đồ gia dụng, math diff ratio ${(out.rootCauseAnswer?.mathDiffRatio ?? 0) * 100}%`
          : `Failed: status=${out.status}, foundDims=${foundDims}, mathOk=${mathOk}`;
      } else if (c.caseId === "EC-02") {
        // KB2: AOV ratio drop in Southern region, week 39/2026
        // TikTok Shop x Thời trang nữ voucher bug
        const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
          step_factor_numerator: { baselineVal: 450_000, currentVal: 450_000 },
          step_factor_denominator: { baselineVal: 1, currentVal: 1 },
          step_region_south: { baselineVal: 450_000, currentVal: 334_350 }, // -115,650 (100%) -> expand
          step_region_central: { baselineVal: 450_000, currentVal: 450_000 }, // 0 -> skipped
          step_region_north: { baselineVal: 450_000, currentVal: 450_000 }, // 0 -> skipped
          step_channel_tiktok_shop_step_region_south: { baselineVal: 450_000, currentVal: 350_000 }, // -100,000 (86.47%) -> expand
          step_channel_shopee_step_region_south: { baselineVal: 450_000, currentVal: 434_350 }, // -15,650 -> skipped
          step_category_thoi_trang_nu_step_channel_tiktok_shop_step_region_south: { baselineVal: 400_000, currentVal: 310_000 }, // -90,000 (77.82%) -> done
          step_category_do_gia_dung_step_channel_tiktok_shop_step_region_south: { baselineVal: 500_000, currentVal: 490_000 }, // -10,000 -> skipped
        };

        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          maxDepthLimit: 2,
          candidateChannels: ["TikTok Shop", "Shopee"],
          candidateCategories: ["Thời trang nữ", "Đồ gia dụng"],
          fetchBaseline: async () => 450_000, // baseline
        };

        // For AOV ratio, mock validateBaseline and execute
        let callCount = 0;
        deps.fetchBaseline = async () => {
          callCount++;
          return callCount % 2 === 1 ? 450_000 : 334_350; // -25.7% drop
        };
        deps.fetchStepMetrics = async (step) =>
          stepMetricsMap[step.stepId] ?? { baselineVal: 450_000, currentVal: 450_000 };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        const primaryCauses = out.rootCauseAnswer?.primaryCauses ?? [];
        const hasTiktokAndFashion = primaryCauses.some((cause) => {
          const pathJoined = cause.dimensionPath.join(" ");
          return pathJoined.includes("TikTok") && pathJoined.includes("Thời trang");
        });
        const mathOk = Boolean(out.rootCauseAnswer?.mathVerified);

        exPass = out.status === "ok" && hasTiktokAndFashion && mathOk;
        note = exPass
          ? `Passed: AOV drop identified with TikTok Shop / Thời trang nữ, mathVerified=${mathOk}`
          : `Failed: status=${out.status}, hasDims=${hasTiktokAndFashion}, mathOk=${mathOk}`;
      } else if (c.caseId === "EC-03") {
        // KB3: Net revenue growth in Northern region, August 2026 vs July 2026 (+630M, +31.5%)
        const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
          step_region_north: { baselineVal: 2_000_000_000, currentVal: 2_630_000_000 }, // +630M (100%)
          step_region_central: { baselineVal: 1_000_000_000, currentVal: 1_000_000_000 }, // 0 -> skipped
          step_region_south: { baselineVal: 1_000_000_000, currentVal: 1_000_000_000 }, // 0 -> skipped
          step_channel_website_step_region_north: { baselineVal: 1_000_000_000, currentVal: 1_500_000_000 }, // +500M (79.37%)
          step_channel_shopee_step_region_north: { baselineVal: 1_000_000_000, currentVal: 1_130_000_000 }, // +130M
          step_category_laptop_thiet_bi_it_step_channel_website_step_region_north: { baselineVal: 500_000_000, currentVal: 950_000_000 }, // +450M (71.43%)
          step_category_phu_kien_step_channel_website_step_region_north: { baselineVal: 500_000_000, currentVal: 550_000_000 },
        };

        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          maxDepthLimit: 2,
          candidateChannels: ["Website", "Shopee"],
          candidateCategories: ["Laptop & Thiết bị IT", "Phụ kiện"],
          fetchBaseline: async (_m, _t, period) =>
            period.start.includes("07") ? 2_000_000_000 : 2_630_000_000,
          fetchStepMetrics: async (step) =>
            stepMetricsMap[step.stepId] ?? { baselineVal: 500_000_000, currentVal: 500_000_000 },
        };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        const primaryCauses = out.rootCauseAnswer?.primaryCauses ?? [];
        const hasWebsiteAndIt = primaryCauses.some((cause) => {
          const pathJoined = cause.dimensionPath.join(" ");
          return pathJoined.includes("Website") && pathJoined.includes("Laptop");
        });
        const mathOk = Boolean(out.rootCauseAnswer?.mathVerified);

        exPass = out.status === "ok" && hasWebsiteAndIt && mathOk && out.analysisPlan?.direction === "increase";
        note = exPass
          ? `Passed: Growth scenario identified Website x Laptop & IT, direction=increase, mathVerified=${mathOk}`
          : `Failed: status=${out.status}, hasDims=${hasWebsiteAndIt}, mathOk=${mathOk}`;
      } else if (c.caseId === "EC-04") {
        // False premise: question claims drop, but actual metric grew from 1.5B to 2.04B (+540M)
        let queriesExecuted = 0;
        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          fetchBaseline: async (_m, _t, period) => {
            queriesExecuted++;
            return period.start.includes("2025") ? 1_500_000_000 : 2_040_000_000;
          },
        };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        exPass = out.status === "false_premise" && queriesExecuted <= 2;
        note = exPass
          ? `Passed: Halted with false_premise after ${queriesExecuted} baseline queries (<= 2 limit)`
          : `Failed: status=${out.status}, queriesExecuted=${queriesExecuted}`;
      } else if (c.caseId === "EC-05") {
        // HITL Plan modification: user modifies steps and workflow executes custom plan
        const executedSteps: string[] = [];
        const deps: RcaRuntimeDeps = {
          fetchBaseline: async (_m, _t, period) =>
            period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
          fetchStepMetrics: async (step) => {
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

        const threadId = makeThreadId("eval_ec05", "hitl_modify");
        // 1. Initial invoke pauses at interrupt
        await testGraph.invoke(
          fakeState(c.question),
          { configurable: { thread_id: threadId } },
        );

        // 2. Custom modified steps
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

        // 3. Resume with MODIFY and customSteps
        const resumed = (await testGraph.invoke(
          resumeDecision({ action: "MODIFY", steps: customSteps }),
          { configurable: { thread_id: threadId } },
        )) as AgentState;

        const hasCustomStepInPlan = Boolean(
          resumed.analysisPlan?.steps.some((s) => s.stepId === "custom_step_shopee"),
        );
        const customStepExecuted = executedSteps.includes("custom_step_shopee");
        const hasReport = Boolean(resumed.rootCauseAnswer?.finalReportMarkdown);

        exPass = resumed.status === "ok" && hasCustomStepInPlan && customStepExecuted && hasReport;
        note = exPass
          ? `Passed: HITL plan modified, custom_step_shopee executed and reported`
          : `Failed: status=${resumed.status}, inPlan=${hasCustomStepInPlan}, executed=${customStepExecuted}`;
      } else if (c.caseId === "EC-06") {
        // Fault isolation: Simulated SQL failure on one branch retries 2 times, marks failed,
        // while other branches continue and final report is successfully synthesized.
        let failedBranchRetried = 0;
        const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
          step_region_central: { baselineVal: 1_200_000_000, currentVal: 800_000_000 },
          step_region_south: { baselineVal: 500_000_000, currentVal: 480_000_000 },
        };

        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          fetchBaseline: async (_m, _t, period) =>
            period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
          fetchStepMetrics: async (step) => {
            if (step.dimensionValue === "Miền Bắc") {
              failedBranchRetried++;
              throw new Error("Simulated database timeout on region North");
            }
            return stepMetricsMap[step.stepId] ?? { baselineVal: 200_000_000, currentVal: 180_000_000 };
          },
        };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        const hasFailedStep = out.analysisPlan?.steps.some((s) => s.status === "failed");
        const hasDoneStep = out.analysisPlan?.steps.some((s) => s.status === "done");
        const hasReport = Boolean(out.rootCauseAnswer?.finalReportMarkdown);

        exPass = out.status === "ok" && Boolean(hasFailedStep) && Boolean(hasDoneStep) && hasReport;
        note = exPass
          ? `Passed: Fault isolated (retries=${failedBranchRetried}), workflow survived and generated report`
          : `Failed: hasFailed=${hasFailedStep}, hasDone=${hasDoneStep}, hasReport=${hasReport}`;
      } else if (c.caseId === "EC-07") {
        // Hard quota enforcement: stops when totalQueriesCount >= maxQueriesLimit (3)
        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          maxQueriesLimit: 3,
          fetchBaseline: async (_m, _t, period) =>
            period.start.includes("08") ? 2_500_000_000 : 2_040_000_000,
          fetchStepMetrics: async () => ({
            baselineVal: 500_000_000,
            currentVal: 400_000_000,
          }),
        };

        const runtime = createRcaRuntime(deps);
        const state = fakeState(c.question);
        const out = await runtime.entry(state, fakeRuntime());

        const totalQueries = out.analysisPlan?.totalQueriesCount ?? 0;
        const hasMaxQueriesReached = Boolean(
          out.analysisPlan?.unexploredBranches.some((b) => b.reason === "MAX_QUERIES_REACHED"),
        );
        const hasSkippedStep = Boolean(
          out.analysisPlan?.steps.some((s) => s.status === "skipped"),
        );

        exPass = out.status === "ok" && totalQueries <= 3 && hasMaxQueriesReached && hasSkippedStep;
        note = exPass
          ? `Passed: Hard quota respected (${totalQueries} queries <= 3), remaining branches recorded as MAX_QUERIES_REACHED`
          : `Failed: totalQueries=${totalQueries}, hasMaxQueriesReached=${hasMaxQueriesReached}, hasSkipped=${hasSkippedStep}`;
      }
    } catch (err) {
      exPass = false;
      note = `Exception: ${err instanceof Error ? err.message : String(err)}`;
    }

    const durationMs = Date.now() - startMs;
    results.push({
      id: c.id,
      status: exPass ? "pass" : "fail",
      exPass,
      ms: durationMs,
      tokens: 0,
      note,
    });
  }

  const passedCount = results.filter((r) => r.exPass).length;
  const summary = {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    passRate: Number(((passedCount / results.length) * 100).toFixed(1)),
  };

  return { cases: results, summary };
}

export function printUc05Report(result: {
  cases: GradedCase[];
  summary: Record<string, unknown>;
}): void {
  console.log("\n=======================================================");
  console.log("            UC-05 EVAL REPORT (Root Cause Analysis)");
  console.log("=======================================================");
  console.log(`Cases: ${result.summary["passed"]}/${result.summary["total"]} passed (${result.summary["passRate"]}%)`);
  console.log("-------------------------------------------------------");
  for (const c of result.cases) {
    const icon = c.exPass ? "✓" : "✗";
    console.log(` ${icon} [${c.id}] (${c.ms}ms): ${c.note ?? ""}`);
  }
  console.log("=======================================================\n");
}
