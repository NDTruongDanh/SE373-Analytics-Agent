// UC-05 sample trace writer: drives Root Cause Analysis (KB1 scenario:
// Net revenue drop in Sept 2026 vs Aug 2026, decomposed along Region -> Channel -> Category)
// with K7 Waterfall Attribution Gate verification and records spans through the real
// redacted span emitter into traces/uc05/. Run via:
//   pnpm exec tsx evals/uc05/write-trace.ts
// The committed jsonl is the UC-05 Definition-of-Done trace (intent -> baseline
// -> plan review -> tree execution -> waterfall verification -> report).
// Fixture data is fake vi_VN retail data; the writer redacts before disk write regardless.

import path from "node:path";
import { createSpanEmitter } from "../../packages/agent/src/telemetry/spans.js";
import {
  createRcaRuntime,
  type RcaRuntimeDeps,
} from "../../packages/agent/src/subgraphs/rootCauseAnalysis.js";
import type { AgentState, RootRuntime } from "../../packages/agent/src/state.js";

const RUN_ID = "e05a5f1e-7b2d-4c8e-9f0a-1b2c3d4e5f60";
const THREAD_ID = `chat:eval:${RUN_ID}`;
const TRACES_DIR = path.join("traces", "uc05");
const QUESTION = "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?";

async function main(): Promise<void> {
  const emit = createSpanEmitter({
    runId: RUN_ID,
    threadId: THREAD_ID,
    userId: "eval",
    role: "sales_south",
    tracesDir: TRACES_DIR,
  });

  // 1. Emit intent parsed span
  emit({
    node: "intent",
    type: "intent_parsed",
    durationMs: 5,
    payload: {
      metric: "net_revenue",
      direction: "decrease",
      currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
      baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
    },
  });

  // 2. Setup RCA deps with KB1 Seeded Scenario (Shopee x Miền Trung x Đồ gia dụng)
  const stepMetricsMap: Record<string, { baselineVal: number; currentVal: number }> = {
    step_region_central: { baselineVal: 1_200_000_000, currentVal: 800_000_000 },
    step_region_north: { baselineVal: 800_000_000, currentVal: 760_000_000 },
    step_region_south: { baselineVal: 500_000_000, currentVal: 480_000_000 },
    step_channel_shopee_step_region_central: { baselineVal: 800_000_000, currentVal: 450_000_000 },
    step_channel_lazada_step_region_central: { baselineVal: 250_000_000, currentVal: 220_000_000 },
    step_channel_tiki_step_region_central: { baselineVal: 150_000_000, currentVal: 130_000_000 },
    step_category_do_gia_dung_step_channel_shopee_step_region_central: {
      baselineVal: 500_000_000,
      currentVal: 200_000_000,
    },
    step_category_thoi_trang_step_channel_shopee_step_region_central: {
      baselineVal: 200_000_000,
      currentVal: 170_000_000,
    },
    step_category_my_pham_step_channel_shopee_step_region_central: {
      baselineVal: 100_000_000,
      currentVal: 80_000_000,
    },
  };

  const deps: RcaRuntimeDeps = {
    skipHitlReview: true,
    maxDepthLimit: 2,
    candidateChannels: ["Shopee", "Lazada", "Tiki"],
    candidateCategories: ["Đồ gia dụng", "Thời trang", "Mỹ phẩm"],
    candidateProducts: ["Nồi chiên không dầu", "Máy ép chậm"],
    fetchBaseline: async (_m, _t, period) => {
      emit.emitToolCall("rca", "run_query", {
        rowCount: 1,
        columns: ["val"],
      });
      return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
    },
    fetchStepMetrics: async (step) => {
      emit.emitToolCall("rca", "run_query", {
        rowCount: 1,
        columns: ["val"],
      });
      return stepMetricsMap[step.stepId] ?? { baselineVal: 100_000_000, currentVal: 90_000_000 };
    },
  };

  const rt = {
    emit: (event: { node: string; type: string; durationMs: number; payload?: unknown }) =>
      emit(event),
    config: {
      configurable: {
        runId: RUN_ID,
        userId: "eval",
        roleScope: "sales_south",
        threadId: THREAD_ID,
      },
    },
  } as unknown as RootRuntime;

  const baseState = {
    question: QUESTION,
    ucId: "root-cause-analysis",
    status: "ok",
    answerText: "",
    sql: null,
    tablesUsed: ["orders", "order_items", "channels", "categories", "regions"],
    columns: ["val"],
    resultPreview: [],
    totalRows: 0,
    toolsCalled: [],
    clarificationRounds: 0,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
    intent: {
      metric: "net_revenue",
      dimensions: ["region", "channel", "category"],
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
    runId: RUN_ID,
    threadId: THREAD_ID,
  } as unknown as AgentState;

  const runtime = createRcaRuntime(deps);
  const out = await runtime.entry(baseState, rt);

  // 3. Emit RCA completion node_done span
  emit({
    node: "rca",
    type: "node_done",
    durationMs: 12,
    payload: {
      status: out.status,
      mathVerified: out.rootCauseAnswer?.mathVerified ?? false,
      mathDiffRatio: out.rootCauseAnswer?.mathDiffRatio ?? 1,
      primaryCausesCount: out.rootCauseAnswer?.primaryCauses.length ?? 0,
      totalQueriesCount: out.analysisPlan?.totalQueriesCount ?? 0,
    },
  });

  // 4. Terminal run_done span
  emit.emitRunDone(out.status === "ok" ? "ok" : "error");

  console.log(
    `trace ${TRACES_DIR}/${RUN_ID}.jsonl status=${out.status} mathVerified=${out.rootCauseAnswer?.mathVerified} diffRatio=${out.rootCauseAnswer?.mathDiffRatio}`,
  );
}

await main();

