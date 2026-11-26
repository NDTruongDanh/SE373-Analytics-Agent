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
import { buildRootGraph } from "../../packages/agent/src/graph.js";
import { RCA_ROUTE } from "../../packages/agent/src/constants.js";
import { createChatModel } from "../../packages/agent/src/models/factory.js";
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
  expectedMetric?: string;
  expectedDirection?: string;
  expectedDimensions?: string[];
  expectedMathPass?: boolean;
  expectedStatus?: string;
  maxQueriesAllowed?: number;
  hitlAction?: string;
  simulateErrorBranch?: boolean;
  maxQueriesLimit?: number;
  isLiveGraph?: boolean;
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

export interface GradeUc05Options {
  liveMcpUrl?: string;
  liveToken?: string;
}

export async function gradeUc05(
  repoRoot: string,
  opts: GradeUc05Options = {},
): Promise<{
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
          step_factor_numerator: { baselineVal: 450_000, currentVal: 334_350 },
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
      } else if (c.caseId === "EC-08" || c.isLiveGraph) {
        // Live graph execution (Issue #94): the router picks the route from the
        // question via RCA regex patterns against the seeded slice
        // against seeded slice (Lazada x Nam x Điện gia dụng).
        // Queries real database over live MCP gateway when available, validating seeded baseline.
        // Reaches HITL plan interrupt and verifies skill_call event is emitted.
        const emittedSpans: Array<{ node: string; type: string; payload?: unknown }> = [];
        const skillsDir = path.resolve(repoRoot, "skills");

        const threadId = makeThreadId("eval_uc05", c.id);
        const mcpUrl = opts.liveMcpUrl ?? process.env.MCP_URL ?? "http://127.0.0.1:8081/mcp";
        const token = opts.liveToken ?? process.env.MCP_TOKEN_ADMIN ?? "";

        // Verify live MCP gateway availability; fail-closed without mocks (Issue #94 review)
        let isLiveMcpAvailable = false;
        if (mcpUrl && token) {
          try {
            const probe = await fetch(mcpUrl.replace(/\/mcp$/, "/healthz"), { signal: AbortSignal.timeout(2000) });
            isLiveMcpAvailable = probe.ok;
          } catch {
            isLiveMcpAvailable = false;
          }
        }

        if (!isLiveMcpAvailable) {
          results.push({
            id: c.id,
            status: "fail",
            exPass: false,
            ms: Date.now() - startMs,
            tokens: 0,
            note: `Failed (infra): Live MCP gateway unreachable at ${mcpUrl} (healthz probe failed or token missing) — live seeded scenario requires running MCP server`,
          });
          continue;
        }

        // Propose baseline queries matching the seeded scenario dimensions:
        // Lazada x Nam x Điện gia dụng
        const scenarioFilterSql = `
FROM public.order_items i
JOIN public.orders o USING (order_id)
JOIN public.customers c USING (customer_id)
JOIN public.channels ch USING (channel_id)
JOIN public.products p USING (product_id)
JOIN public.categories cat USING (category_id)
WHERE o.status = 'delivered'
  AND ch.channel_name = 'Lazada'
  AND c.region_group = 'Nam'
  AND cat.name_vi = 'Điện gia dụng'`;

        const baseSql = `SELECT COALESCE(SUM(i.price_vnd), 0)::float AS val ${scenarioFilterSql} AND o.purchase_date >= '2026-08-01' AND o.purchase_date < '2026-09-01'`;
        const currSql = `SELECT COALESCE(SUM(i.price_vnd), 0)::float AS val ${scenarioFilterSql} AND o.purchase_date >= '2026-09-01' AND o.purchase_date < '2026-10-01'`;
        const sqlResponses = [
          JSON.stringify({ sql: baseSql, tablesUsed: ["orders", "order_items", "customers", "channels", "products", "categories"] }),
          JSON.stringify({ sql: currSql, tablesUsed: ["orders", "order_items", "customers", "channels", "products", "categories"] }),
        ];
        const sqlModel = createChatModel("sql", { fake: { responses: sqlResponses } });

        const deps: RcaRuntimeDeps = {
          skillsDir,
          sqlModel: sqlModel as never,
        };

        const rcaRuntime = createRcaRuntime(deps);
        const rootGraph = buildRootGraph({
          checkpointer: new MemorySaver(),
          emitSpan: (evt) => {
            emittedSpans.push(evt);
            return `span_${emittedSpans.length}`;
          },
          routes: { [RCA_ROUTE]: rcaRuntime.entry },
        });

        const out = await rootGraph.invoke(
          {
            question: c.question,
          },
          {
            configurable: {
              thread_id: threadId,
              mcpUrl,
              token,
              runId: threadId,
              userId: "eval",
              roleScope: "admin",
            },
          },
        );

        const interrupts = (out as { __interrupt__?: Array<{ value?: Record<string, unknown> }> })
          .__interrupt__;
        const hasInterrupt = Array.isArray(interrupts) && interrupts.length > 0;
        const interruptPayload = hasInterrupt ? interrupts[0]?.value : undefined;
        const isPlanInterrupt = interruptPayload?.action === "review_analysis_plan";
        const plan = interruptPayload?.plan as {
          baselineVal?: number;
          currentVal?: number;
          absDelta?: number;
          pctDelta?: number;
          isValidBaseline?: boolean;
          steps?: unknown[];
        } | undefined;
        const isValidBaseline = plan?.isValidBaseline === true;

        const hasSkillCall = emittedSpans.some(
          (s) =>
            s.type === "skill_call" &&
            (s.payload as { skill?: string } | undefined)?.skill === "root-cause-analysis",
        );

        // Scenario validation against expected drop magnitude ~12% (0.88 multiplier in load.ts).
        // Synchronized with packages/data/src/verify.ts: inBand(entry.id, num(row["pct"]), -0.2, -0.05).
        // Rather than hard-coding fixed revenue totals (which depend on database scale),
        // we dynamically verify:
        // 1. Positive baseline and current values retrieved from the database.
        // 2. Negative delta reflecting revenue drop (absDelta < 0).
        // 3. Mathematical consistency: absDelta === currentVal - baselineVal AND pctDelta === (absDelta / baselineVal) * 100.
        // 4. pctDelta lands strictly within the verified seed scenario drop band [-20%, -5%] (from verify.ts).
        // 5. pctDelta aligns with expected scenario magnitude (-12% +/- 8%).
        const isBaselinePositive = typeof plan?.baselineVal === "number" && plan.baselineVal > 0;
        const isCurrentPositive = typeof plan?.currentVal === "number" && plan.currentVal > 0;
        const isDeltaNegative = typeof plan?.absDelta === "number" && plan.absDelta < 0;

        const calculatedAbsDelta = (plan?.currentVal ?? 0) - (plan?.baselineVal ?? 0);
        const calculatedPctDelta = (plan?.baselineVal ?? 0) !== 0
          ? (calculatedAbsDelta / Math.abs(plan?.baselineVal ?? 1)) * 100
          : 0;

        const isAbsDeltaConsistent =
          isBaselinePositive &&
          isCurrentPositive &&
          isDeltaNegative &&
          Math.abs((plan?.absDelta ?? 0) - calculatedAbsDelta) < 1;

        const isPctDeltaConsistent =
          typeof plan?.pctDelta === "number" &&
          Math.abs(plan.pctDelta - calculatedPctDelta) < 0.05;

        const isMathConsistent = isAbsDeltaConsistent && isPctDeltaConsistent;

        const SEED_MIN_PCT_DROP = -20; // verify.ts inBand floor: -0.20 (-20%)
        const SEED_MAX_PCT_DROP = -5;  // verify.ts inBand ceiling: -0.05 (-5%)
        const isDeltaInBand =
          typeof plan?.pctDelta === "number" &&
          plan.pctDelta <= SEED_MAX_PCT_DROP &&
          plan.pctDelta >= SEED_MIN_PCT_DROP;

        const expectedMagnitude = -0.12;
        const expectedPct = expectedMagnitude * 100;
        const isNearExpectedMagnitude =
          typeof plan?.pctDelta === "number" &&
          Math.abs(plan.pctDelta - expectedPct) <= 8;

        exPass = Boolean(
          hasInterrupt &&
            isPlanInterrupt &&
            isValidBaseline &&
            hasSkillCall &&
            isBaselinePositive &&
            isCurrentPositive &&
            isDeltaInBand &&
            isNearExpectedMagnitude &&
            isMathConsistent,
        );
        note = exPass
          ? `Passed: Live graph router picked the root-cause-analysis route, queried real DB via live MCP run_query (baseline=${plan?.baselineVal}, current=${plan?.currentVal}, pctDelta=${plan?.pctDelta?.toFixed(2)}% in verify.ts band [-20%, -5%], target magnitude ${expectedPct}%), skill loaded (skill_call emitted), reached HITL plan interrupt`
          : `Failed: hasInterrupt=${hasInterrupt}, isPlanInterrupt=${isPlanInterrupt}, isValidBaseline=${isValidBaseline}, hasSkillCall=${hasSkillCall}, isDeltaInBand=${isDeltaInBand} (got ${plan?.pctDelta}%, required [-20%, -5%]), isNearExpectedMagnitude=${isNearExpectedMagnitude} (target ${expectedPct}%), isAbsDeltaConsistent=${isAbsDeltaConsistent}, isPctDeltaConsistent=${isPctDeltaConsistent}`;
      } else if (c.caseId === "EC-09") {
        // EC-09: AOV Mix-Shift / Formula Decomposition (Issue #133)
        // Two-Axis MECE: decomposes AOV into formula factors (net_revenue & delivered_orders)
        // and dimension hierarchy with Shift-Share Rate/Mix attribution.
        const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
          step_factor_numerator: { baselineVal: 2_500_000_000, currentVal: 2_000_000_000 },
          step_factor_denominator: { baselineVal: 10_000, currentVal: 10_000 },
          step_region_north: { baselineVal: 250_000, currentVal: 200_000 },
          step_region_central: { baselineVal: 250_000, currentVal: 200_000 },
          step_region_south: { baselineVal: 250_000, currentVal: 200_000 },
        };

        const shiftShareSegments = [
          { id: "step_region_north", name: "Miền Bắc", n0: 1_000_000_000, d0: 4_000, n1: 700_000_000, d1: 3_500 },
          { id: "step_region_central", name: "Miền Trung", n0: 1_000_000_000, d0: 4_000, n1: 800_000_000, d1: 4_000 },
          { id: "step_region_south", name: "Miền Nam", n0: 500_000_000, d0: 2_000, n1: 500_000_000, d1: 2_500 },
        ];

        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          shiftShareSegments,
          fetchBaseline: async () => 250_000,
          fetchStepMetrics: async (step) =>
            stepMetricsMap[step.stepId] ?? { baselineVal: 250_000, currentVal: 200_000 },
          candidateChannels: [],
        };

        // Alternate baseline check to return -50k delta
        let callCount = 0;
        deps.fetchBaseline = async () => {
          callCount++;
          return callCount % 2 === 1 ? 250_000 : 200_000;
        };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        const mathVerified = Boolean(out.rootCauseAnswer?.mathVerified);
        const numStep = out.analysisPlan?.steps.find((s) => s.stepId === "step_factor_numerator");
        const hasFormulaAttribution = Boolean(numStep && numStep.delta !== 0);
        const hasShiftShareInHypothesis = Boolean(
          out.analysisPlan?.steps.some((s) => s.hypothesis?.includes("Shift-Share")),
        );

        exPass = out.status === "ok" && mathVerified && hasFormulaAttribution && hasShiftShareInHypothesis;
        note = exPass
          ? `Passed: AOV formula decomposition (-50k VND) + Shift-Share rate/mix verified, mathVerified=true`
          : `Failed: status=${out.status}, mathVerified=${mathVerified}, hasFormula=${hasFormulaAttribution}, hasShiftShare=${hasShiftShareInHypothesis}`;
      } else if (c.caseId === "EC-10") {
        // EC-10: Offsetting Movement Guard with Residual Other (Issue #133)
        // Net delta is small (-5M), but gross movement is large (99M).
        // Components < 30% gross are pruned into residual_other while preserving 100% attribution.
        const totalDelta = -5_000_000;
        const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
          step_region_central: { baselineVal: 100_000_000, currentVal: 55_000_000 },  // -45M (45.5% gross >= 30%) -> retain
          step_region_north: { baselineVal: 60_000_000, currentVal: 100_000_000 },    // +40M (40.4% gross >= 30%) -> retain
          step_region_south: { baselineVal: 50_000_000, currentVal: 50_000_000 },     // 0M -> skipped
        };

        const deps: RcaRuntimeDeps = {
          skipHitlReview: true,
          drilldownThreshold: 30,
          candidateChannels: [],
          fetchBaseline: async (_m, _t, period) =>
            period.start.includes("08") ? 500_000_000 : 495_000_000, // -5M net delta
          fetchStepMetrics: async (step) =>
            stepMetricsMap[step.stepId] ?? { baselineVal: 50_000_000, currentVal: 50_000_000 },
        };

        const runtime = createRcaRuntime(deps);
        const out = await runtime.entry(fakeState(c.question), fakeRuntime());

        const mathVerified = Boolean(out.rootCauseAnswer?.mathVerified && out.rootCauseAnswer?.absDelta === totalDelta);
        const primaryCauses = out.rootCauseAnswer?.primaryCauses ?? [];
        const hasMajorDrivers = primaryCauses.some((c) => c.dimensionValue === "Miền Trung" || c.dimensionValue === "Miền Bắc");

        exPass = out.status === "ok" && mathVerified && hasMajorDrivers;
        note = exPass
          ? `Passed: Offsetting movement handled, net delta (-5M) reconciled with gross movements, mathVerified=true`
          : `Failed: status=${out.status}, mathVerified=${mathVerified}, hasMajorDrivers=${hasMajorDrivers}`;
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
