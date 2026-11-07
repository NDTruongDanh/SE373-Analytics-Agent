// UC-03 eval grader (PRD §6, docs/UC-plan/UC03.md §4): pure, DB-free.
// Grades chart-label fixtures (selector accuracy + headless spec validity)
// and insight cases (end-to-end VIZ seam with a scripted model: numeric
// fidelity, causal-strip behavior, caveat discipline, latency). Runs under
// `pnpm eval --uc uc03` without booting the gateway — validators are local
// deterministic code, and the scripted model stands in for Profile 3.

import { readFileSync } from "node:fs";
import path from "node:path";
import { selectChartType } from "../../packages/agent/src/validators/chartSelector.js";
import { validateChart } from "../../packages/agent/src/validators/renderChart.js";
import { buildSpecForChart } from "../../packages/agent/src/subgraphs/uc03/specBuilders.js";
import {
  createUc03Viz,
  type Uc03VizSpec,
} from "../../packages/agent/src/subgraphs/uc03/viz.js";
import { VizDraftSchema } from "../../packages/agent/src/subgraphs/uc03/synthesize.js";
import type {
  AgentState,
  RootRuntime,
} from "../../packages/agent/src/state.js";
import { serializeOpenuiLang } from "../../packages/agent/src/subgraphs/uc03/serialize.js";

export interface GradedCase {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
  note?: string;
}

interface LabelFixture {
  id: string;
  columns: string[];
  rows: Record<string, unknown>[];
  status: string;
  expectedChartType: string;
  note?: string;
}

interface InsightFixture {
  id: string;
  question: string;
  chartType: string;
  status: string;
  columns: string[];
  rows: Record<string, unknown>[];
  draft: unknown;
  expectVerified: number;
  expectStripped: number;
  expectCaveat: boolean;
}

function readJsonl(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function fakeRuntime(spans: unknown[]): RootRuntime {
  return {
    emit: (event: { node: string; type: string; payload?: unknown }) => {
      spans.push(event);
      return `span-${spans.length}`;
    },
    config: { configurable: {} },
  } as unknown as RootRuntime;
}

function fakeState(fixture: InsightFixture): AgentState {
  return {
    question: fixture.question,
    ucId: "uc03-eval",
    intent: {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
      queryMode: "standard_query",
    },
    semanticChunks: [],
    resultPreview: fixture.rows,
    columns: fixture.columns,
    sql: null,
    tablesUsed: [],
    toolsCalled: [],
    status: fixture.status,
    answerText: "",
    budget: { llmCalls: 0, tokensUsed: 0, maxLlmCalls: 20, maxTokens: 60000, deadlineMs: 0 },
    telemetry: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    runId: `eval-${fixture.id}`,
    threadId: `eval-${fixture.id}`,
    vizSpec: null,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
  } as unknown as AgentState;
}

export interface Uc03Summary {
  labelAccuracy: number;
  labelTotal: number;
  specValidity: number;
  numericFidelity: number;
  causalStrips: number;
  meanLatencyMs: number;
}

export interface Uc03Results {
  cases: GradedCase[];
  summary: Uc03Summary;
}

export async function gradeUc03(repoRoot: string): Promise<Uc03Results> {
  const dir = path.join(repoRoot, "evals", "uc03");
  const labels = readJsonl(path.join(dir, "chart-labels.jsonl")) as LabelFixture[];
  const insights = readJsonl(path.join(dir, "insights.jsonl")) as InsightFixture[];
  const cases: GradedCase[] = [];
  let specValid = 0;
  let labelPassed = 0;

  for (const fixture of labels) {
    const t0 = Date.now();
    const buffer = { columns: fixture.columns, rows: fixture.rows };
    const selection = selectChartType(buffer, fixture.status);
    const built = buildSpecForChart(selection.chartType, buffer);
    const validity = built
      ? validateChart(selection.chartType, built, buffer)
      : { ok: false as const };
    const shapeOk = validity.ok === true;
    if (shapeOk) specValid += 1;
    // Serialize the code-built spec: Lang emission is part of validity.
    let lang = "";
    if (shapeOk && validity.ok) {
      lang = serializeOpenuiLang({ title: fixture.id, spec: validity.spec, notes: [] });
    }
    const pass =
      selection.chartType === fixture.expectedChartType &&
      shapeOk &&
      (selection.chartType === "none" ? lang.startsWith("root = Card([title])") : lang.includes(selection.chartType === "table" ? "Table(" : "Chart("));
    if (pass) labelPassed += 1;
    cases.push({
      id: fixture.id,
      status: "ok",
      exPass: pass,
      ms: Date.now() - t0,
      tokens: 0,
      ...(pass
        ? {}
        : {
            note: `expected ${fixture.expectedChartType}, got ${selection.chartType} (specValid=${shapeOk})`,
          }),
    });
  }

  let verifiedTotal = 0;
  let strippedTotal = 0;
  let causalStrips = 0;
  let latencyTotal = 0;
  for (const fixture of insights) {
    const t0 = Date.now();
    const spans: unknown[] = [];
    const draft = VizDraftSchema.parse(fixture.draft);
    const model = {
      withStructuredOutput: () => ({
        invoke: async () => draft,
      }),
    };
    const viz = createUc03Viz({ model });
    const out = await viz(fakeState(fixture), fakeRuntime(spans));
    const spec = out.vizSpec as Uc03VizSpec;
    const ms = Date.now() - t0;
    latencyTotal += ms;
    verifiedTotal += spec.report.insights.length;
    strippedTotal += spec.stripped.length;
    if (spec.stripped.some((item) => /cause is unverified/.test(item.reason))) {
      causalStrips += 1;
    }
    const checks = [
      spec.report.chartType === fixture.chartType,
      spec.report.insights.length === fixture.expectVerified,
      spec.stripped.length === fixture.expectStripped,
      fixture.expectCaveat ? spec.report.caveats.length > 0 : true,
      spec.openuiLang.startsWith("root = Card("),
    ];
    const pass = checks.every(Boolean);
    cases.push({
      id: fixture.id,
      status: spec.report.chartType,
      exPass: pass,
      ms,
      tokens: out.telemetry?.promptTokens ?? 0,
      ...(pass
        ? {}
        : {
            note: `verified=${spec.report.insights.length}/${fixture.expectVerified} stripped=${spec.stripped.length}/${fixture.expectStripped} chart=${spec.report.chartType}/${fixture.chartType} caveats=${spec.report.caveats.length}`,
          }),
    });
  }

  const claimed = verifiedTotal + strippedTotal;
  return {
    cases,
    summary: {
      labelAccuracy: labelPassed,
      labelTotal: labels.length,
      specValidity: specValid,
      numericFidelity: claimed > 0 ? verifiedTotal / claimed : 1,
      causalStrips,
      meanLatencyMs: insights.length > 0 ? latencyTotal / insights.length : 0,
    },
  };
}

export function printUc03Report(results: Uc03Results): void {
  const passed = results.cases.filter((c) => c.exPass).length;
  const accuracy =
    results.summary.labelTotal > 0
      ? ((results.summary.labelAccuracy / results.summary.labelTotal) * 100).toFixed(1)
      : "n/a";
  console.log(
    `eval uc03: ${passed}/${results.cases.length} pass ` +
      `(chart-type accuracy ${accuracy}% on ${results.summary.labelTotal} labels, ` +
      `${results.summary.specValidity} valid specs, ` +
      `numeric fidelity ${(results.summary.numericFidelity * 100).toFixed(1)}%, ` +
      `${results.summary.causalStrips} causal strips, ` +
      `mean VIZ latency ${results.summary.meanLatencyMs.toFixed(1)}ms, 0 prompt tokens in deterministic mode)`,
  );
  for (const c of results.cases.filter((c) => !c.exPass)) {
    console.log(`  FAIL ${c.id}: ${c.note ?? "mismatch"}`);
  }
}
