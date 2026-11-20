// UC-03 eval grader (PRD §6, docs/UC-plan/UC03.md §4).
// Grades chart-label fixtures (selector accuracy >= 80% + 100% headless
// spec validity + OpenUI Lang emission), K7 strip-guard checks (100%
// delivered numeric fidelity + causal gating), and insight synthesis
// fidelity (100% numeric fidelity gate per PRD UC-03 #3 / arch §1.2.4).
//
// Modes:
// - deterministic (default, DB-free, keyless): runs scripted clean insight
//   cases and adversarial strip-guard fixtures separately so intentional
//   strip tests verify K7 defense without dragging numeric fidelity to 50%.
// - live (EVAL_USE_LIVE_MODEL=1 or --live, DB-free): runs real Profile-3
//   model over insights.jsonl (ignoring scripted drafts) and gates on 100%
//   live numeric fidelity, chart validity, tokens, cost, and latency.
// - live_graph (EVAL_UC03_LIVE_GRAPH=1 or --live-graph): also runs end-to-end
//   root-graph queries (retrieve -> intent -> textToSql -> vizSeam -> answer)
//   via the injected liveGraphRunner against the real DB + MCP gateway.

import { readFileSync } from "node:fs";
import path from "node:path";
import { redactPII } from "@shared/access-policy";
import { createChatModel } from "../../packages/agent/src/models/factory.js";
import type {
  AgentState,
  RootRuntime,
} from "../../packages/agent/src/state.js";
import { serializeOpenuiLang } from "../../packages/agent/src/subgraphs/uc03/serialize.js";
import { buildSpecForChart } from "../../packages/agent/src/subgraphs/uc03/specBuilders.js";
import {
  VizDraftSchema,
  type VizModelLike,
} from "../../packages/agent/src/subgraphs/uc03/synthesize.js";
import {
  createUc03Viz,
  type Uc03VizSpec,
} from "../../packages/agent/src/subgraphs/uc03/viz.js";
import { selectChartType } from "../../packages/agent/src/validators/chartSelector.js";
import { verifyNumericClaims } from "../../packages/agent/src/validators/claimValidator.js";
import { validateChart } from "../../packages/agent/src/validators/renderChart.js";

/** PRD UC-03 acceptance thresholds. */
export const UC03_LABEL_ACCURACY_MIN = 0.8;
export const UC03_SPEC_VALIDITY_MIN = 1.0;
export const UC03_NUMERIC_FIDELITY_MIN = 1.0;

export type Uc03EvalMode = "deterministic" | "live" | "live_graph";

export interface GradedCase {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
  costUsd?: number;
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
  fixtureRole?: "insight" | "strip_guard";
  scriptedOnly?: boolean;
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

export interface LiveGraphCaseInput {
  id: string;
  question: string;
  role?: string;
  expectStatus: string;
  expectedChartTypes: string[];
}

export interface LiveGraphCaseOutput {
  status: string;
  columns: string[];
  rows: Record<string, unknown>[];
  vizSpec: Uc03VizSpec | null;
  answerText: string;
  ms: number;
  tokens: number;
  costUsd?: number;
  reason?: string;
}

export type LiveGraphRunner = (c: LiveGraphCaseInput) => Promise<LiveGraphCaseOutput>;

export interface GradeUc03Options {
  mode?: Uc03EvalMode;
  model?: VizModelLike;
  liveGraphRunner?: LiveGraphRunner;
}

interface EmittedSpan {
  node: string;
  type: string;
  payload?: Record<string, unknown>;
}

function readJsonl(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function fakeRuntime(spans: EmittedSpan[]): RootRuntime {
  return {
    emit: (event: EmittedSpan) => {
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

function isStripGuardFixture(fixture: InsightFixture): boolean {
  return fixture.fixtureRole === "strip_guard" || fixture.expectStripped > 0;
}

function spanCostUsd(spans: EmittedSpan[]): number {
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    if (spans[i]?.type === "node_done") {
      const cost = spans[i]?.payload?.["estimatedCostUsd"];
      if (typeof cost === "number" && Number.isFinite(cost)) return cost;
    }
  }
  return 0;
}

function hasFallbackCaveat(caveats: string[]): boolean {
  return caveats.some((c) =>
    /no model key|rate-limited|Draft validation failed|budget exceeded/i.test(c),
  );
}

export interface Uc03Summary {
  mode: Uc03EvalMode;
  labelAccuracy: number;
  labelTotal: number;
  specValidity: number;
  numericFidelity: number;
  deliveredNumericFidelity: number;
  stripGuardsPassed: number;
  stripGuardsTotal: number;
  causalStrips: number;
  meanLatencyMs: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  totalCostUsd: number;
  gatesPassed: boolean;
  gateFailures: string[];
}

export interface Uc03Results {
  cases: GradedCase[];
  summary: Uc03Summary;
  gatesPassed: boolean;
}

/** Evaluate PRD UC-03 acceptance gates over summary metrics. */
export function evaluateUc03Gates(
  summary: Pick<
    Uc03Summary,
    | "labelAccuracy"
    | "labelTotal"
    | "specValidity"
    | "numericFidelity"
    | "deliveredNumericFidelity"
    | "stripGuardsPassed"
    | "stripGuardsTotal"
  >,
): { gatesPassed: boolean; gateFailures: string[] } {
  const labelRate = summary.labelTotal > 0 ? summary.labelAccuracy / summary.labelTotal : 1;
  const specRate = summary.labelTotal > 0 ? summary.specValidity / summary.labelTotal : 1;
  const gateFailures: string[] = [];
  if (labelRate < UC03_LABEL_ACCURACY_MIN) {
    gateFailures.push(
      `chart-type accuracy ${(labelRate * 100).toFixed(1)}% < ${(UC03_LABEL_ACCURACY_MIN * 100).toFixed(1)}%`,
    );
  }
  if (specRate < UC03_SPEC_VALIDITY_MIN) {
    gateFailures.push(
      `spec validity ${(specRate * 100).toFixed(1)}% < ${(UC03_SPEC_VALIDITY_MIN * 100).toFixed(1)}%`,
    );
  }
  if (summary.numericFidelity < UC03_NUMERIC_FIDELITY_MIN) {
    gateFailures.push(
      `numeric fidelity ${(summary.numericFidelity * 100).toFixed(1)}% < ${(UC03_NUMERIC_FIDELITY_MIN * 100).toFixed(1)}%`,
    );
  }
  if (summary.deliveredNumericFidelity < UC03_NUMERIC_FIDELITY_MIN) {
    gateFailures.push(
      `delivered numeric fidelity ${(summary.deliveredNumericFidelity * 100).toFixed(1)}% < ${(UC03_NUMERIC_FIDELITY_MIN * 100).toFixed(1)}%`,
    );
  }
  if (summary.stripGuardsPassed < summary.stripGuardsTotal) {
    gateFailures.push(
      `strip guards ${summary.stripGuardsPassed}/${summary.stripGuardsTotal} passed`,
    );
  }
  return { gatesPassed: gateFailures.length === 0, gateFailures };
}

function resolveEvalMode(opts: GradeUc03Options): Uc03EvalMode {
  if (opts.mode) return opts.mode;
  if (process.env.EVAL_UC03_LIVE_GRAPH === "1") return "live_graph";
  if (process.env.EVAL_USE_LIVE_MODEL === "1") return "live";
  return "deterministic";
}

export async function gradeUc03(
  repoRoot: string,
  opts: GradeUc03Options = {},
): Promise<Uc03Results> {
  const mode = resolveEvalMode(opts);
  let liveModel: VizModelLike | null = opts.model ?? null;
  if (mode !== "deterministic" && liveModel === null) {
    if (!process.env.AGENT_MODEL_API_KEY) {
      throw new Error(
        "uc03 live mode requires EVAL_USE_LIVE_MODEL=1 and AGENT_MODEL_API_KEY; refusing to fall back to scripted fixtures.",
      );
    }
    liveModel = createChatModel("synthesis") as unknown as VizModelLike;
  }
  if (mode === "live_graph" && !opts.liveGraphRunner) {
    throw new Error(
      "uc03 live_graph mode requires a liveGraphRunner (DB + MCP gateway); refusing to fall back.",
    );
  }

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
      (selection.chartType === "none"
        ? lang.startsWith("root = Card([title])")
        : lang.includes(selection.chartType === "table" ? "Table(" : "Chart("));
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
  let missingInsightCases = 0;
  let expectedInsightCases = 0;
  let deliveredVerified = 0;
  let deliveredStripped = 0;
  let stripGuardsPassed = 0;
  let stripGuardsTotal = 0;
  let causalStrips = 0;
  let latencyTotal = 0;
  let promptTokensTotal = 0;
  let completionTokensTotal = 0;
  let costUsdTotal = 0;
  let vizRunCount = 0;

  // 1. Run deterministic K7 strip-guard verification across adversarial fixtures
  //    in ALL modes so numeric/delta/causal strip defenses never regress.
  for (const fixture of insights.filter(isStripGuardFixture)) {
    const t0 = Date.now();
    const spans: EmittedSpan[] = [];
    const draft = VizDraftSchema.parse(fixture.draft);
    const model: VizModelLike = {
      withStructuredOutput: () => ({
        invoke: async () => draft,
      }),
    };
    const viz = createUc03Viz({ model });
    const out = await viz(fakeState(fixture), fakeRuntime(spans));
    const spec = out.vizSpec as Uc03VizSpec;
    const ms = Date.now() - t0;
    const buffer = { columns: fixture.columns, rows: fixture.rows };
    const deliveredCheck = verifyNumericClaims(spec.report.insights, buffer);
    deliveredVerified += deliveredCheck.verified.length;
    deliveredStripped += deliveredCheck.stripped.length;
    if (spec.stripped.some((item) => /cause is unverified/.test(item.reason))) {
      causalStrips += 1;
    }
    const pass =
      spec.report.chartType === fixture.chartType &&
      spec.report.insights.length === fixture.expectVerified &&
      spec.stripped.length === fixture.expectStripped &&
      (fixture.expectCaveat ? spec.report.caveats.length > 0 : true) &&
      deliveredCheck.stripped.length === 0 &&
      spec.openuiLang.startsWith("root = Card(");
    stripGuardsTotal += 1;
    if (pass) stripGuardsPassed += 1;
    if (mode === "deterministic") {
      latencyTotal += ms;
      vizRunCount += 1;
      cases.push({
        id: fixture.id,
        status: spec.report.chartType,
        exPass: pass,
        ms,
        tokens: 0,
        ...(pass
          ? {}
          : {
              note: `strip-guard verified=${spec.report.insights.length}/${fixture.expectVerified} stripped=${spec.stripped.length}/${fixture.expectStripped} deliveredStripped=${deliveredCheck.stripped.length} chart=${spec.report.chartType}/${fixture.chartType} caveats=${spec.report.caveats.length}`,
            }),
      });
    } else if (!pass) {
      cases.push({
        id: `${fixture.id}-guard`,
        status: spec.report.chartType,
        exPass: false,
        ms,
        tokens: 0,
        note: `strip-guard failed: verified=${spec.report.insights.length}/${fixture.expectVerified} stripped=${spec.stripped.length}/${fixture.expectStripped}`,
      });
    }
  }

  // 2. Run clean insight fixtures in deterministic mode, OR run the live
  //    Profile-3 model across insights.jsonl in live / live_graph mode.
  const insightTargets =
    mode === "deterministic"
      ? insights.filter((fixture) => !isStripGuardFixture(fixture))
      : insights.filter((fixture) => !fixture.scriptedOnly);

  for (const fixture of insightTargets) {
    const t0 = Date.now();
    const spans: EmittedSpan[] = [];
    const model: VizModelLike =
      mode === "deterministic"
        ? {
            withStructuredOutput: () => ({
              invoke: async () => VizDraftSchema.parse(fixture.draft),
            }),
          }
        : (liveModel as VizModelLike);
    const viz = createUc03Viz({ model });
    const out = await viz(fakeState(fixture), fakeRuntime(spans));
    const spec = out.vizSpec as Uc03VizSpec;
    const ms = Date.now() - t0;
    const buffer = { columns: fixture.columns, rows: fixture.rows };
    const chartCheck = validateChart(spec.report.chartType, spec.report.chartSpec, buffer);
    const deliveredCheck = verifyNumericClaims(spec.report.insights, buffer);
    const piiHit = redactPII(JSON.stringify(spec.report)).hit;
    const promptTokens = mode === "deterministic" ? 0 : (out.telemetry?.promptTokens ?? 0);
    const completionTokens = mode === "deterministic" ? 0 : (out.telemetry?.completionTokens ?? 0);
    const costUsd = mode === "deterministic" ? 0 : spanCostUsd(spans);

    latencyTotal += ms;
    promptTokensTotal += promptTokens;
    completionTokensTotal += completionTokens;
    costUsdTotal += costUsd;
    vizRunCount += 1;

    deliveredVerified += deliveredCheck.verified.length;
    deliveredStripped += deliveredCheck.stripped.length;
    verifiedTotal += spec.report.insights.length;
    strippedTotal += spec.stripped.length;

    const expectsInsights = fixture.status === "ok" && fixture.rows.length > 0;
    if (expectsInsights) expectedInsightCases += 1;
    const missingInsights =
      expectsInsights &&
      spec.report.insights.length === 0 &&
      spec.stripped.length === 0;
    if (missingInsights) missingInsightCases += 1;

    let pass: boolean;
    let failureNote = "";
    if (mode === "deterministic") {
      const checks = [
        spec.report.chartType === fixture.chartType,
        chartCheck.ok,
        spec.report.insights.length === fixture.expectVerified,
        spec.stripped.length === fixture.expectStripped,
        fixture.expectCaveat ? spec.report.caveats.length > 0 : true,
        deliveredCheck.stripped.length === 0,
        !piiHit,
        spec.openuiLang.startsWith("root = Card("),
      ];
      pass = checks.every(Boolean);
      if (!pass) {
        failureNote = `verified=${spec.report.insights.length}/${fixture.expectVerified} stripped=${spec.stripped.length}/${fixture.expectStripped} deliveredStripped=${deliveredCheck.stripped.length} chart=${spec.report.chartType}/${fixture.chartType} chartValid=${chartCheck.ok} caveats=${spec.report.caveats.length}`;
      }
    } else {
      const noFallback = !spec.deterministic && !hasFallbackCaveat(spec.report.caveats);
      const statusChecks = expectsInsights
        ? spec.report.insights.length >= 1 && spec.stripped.length === 0
        : spec.report.insights.length === 0 && spec.report.caveats.length > 0;
      const checks = [
        noFallback,
        spec.report.chartType === fixture.chartType,
        chartCheck.ok,
        deliveredCheck.stripped.length === 0,
        statusChecks,
        !piiHit,
        spec.openuiLang.startsWith("root = Card("),
      ];
      pass = checks.every(Boolean);
      if (!pass) {
        failureNote =
          `deterministic=${spec.deterministic} verified=${spec.report.insights.length} ` +
          `stripped=${spec.stripped.length} deliveredStripped=${deliveredCheck.stripped.length} ` +
          `chart=${spec.report.chartType}/${fixture.chartType} chartValid=${chartCheck.ok} ` +
          `piiHit=${piiHit} caveats=${JSON.stringify(spec.report.caveats)}`;
      }
    }

    cases.push({
      id: fixture.id,
      status: spec.report.chartType,
      exPass: pass,
      ms,
      tokens: promptTokens + completionTokens,
      ...(costUsd > 0 ? { costUsd } : {}),
      ...(pass ? {} : { note: failureNote }),
    });
  }

  // 3. Optional end-to-end live-graph UC-03 cases (retrieve -> intent -> SQL -> VIZ).
  if (mode === "live_graph" && opts.liveGraphRunner) {
    const liveCases = readJsonl(path.join(dir, "live-cases.jsonl")) as LiveGraphCaseInput[];
    for (const liveCase of liveCases) {
      const out = await opts.liveGraphRunner(liveCase);
      const spec = out.vizSpec;
      const buffer = { columns: out.columns, rows: out.rows };
      const expectsInsights = liveCase.expectStatus === "ok" && out.rows.length > 0;
      if (expectsInsights) expectedInsightCases += 1;

      if (!spec || spec.kind !== "insight_report") {
        missingInsightCases += expectsInsights ? 1 : 0;
        cases.push({
          id: liveCase.id,
          status: out.status,
          exPass: false,
          ms: out.ms,
          tokens: out.tokens,
          ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}),
          note: `missing insight_report vizSpec (status=${out.status}, reason=${out.reason ?? "none"})`,
        });
        continue;
      }

      const chartCheck = validateChart(spec.report.chartType, spec.report.chartSpec, buffer);
      const deliveredCheck = verifyNumericClaims(spec.report.insights, buffer);
      const piiHit = redactPII(`${JSON.stringify(spec.report)}\n${out.answerText}`).hit;

      latencyTotal += out.ms;
      costUsdTotal += out.costUsd ?? 0;
      vizRunCount += 1;
      deliveredVerified += deliveredCheck.verified.length;
      deliveredStripped += deliveredCheck.stripped.length;
      verifiedTotal += spec.report.insights.length;
      strippedTotal += spec.stripped.length;

      const missingInsights =
        expectsInsights &&
        spec.report.insights.length === 0 &&
        spec.stripped.length === 0;
      if (missingInsights) missingInsightCases += 1;

      const noFallback =
        !expectsInsights || (!spec.deterministic && !hasFallbackCaveat(spec.report.caveats));
      const statusChecks = expectsInsights
        ? spec.report.insights.length >= 1 && spec.stripped.length === 0
        : spec.report.insights.length === 0 && spec.report.caveats.length > 0;
      const pass =
        out.status === liveCase.expectStatus &&
        noFallback &&
        liveCase.expectedChartTypes.includes(spec.report.chartType) &&
        chartCheck.ok &&
        deliveredCheck.stripped.length === 0 &&
        statusChecks &&
        !piiHit &&
        spec.openuiLang.startsWith("root = Card(");

      cases.push({
        id: liveCase.id,
        status: out.status,
        exPass: pass,
        ms: out.ms,
        tokens: out.tokens,
        ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}),
        ...(pass
          ? {}
          : {
              note:
                `status=${out.status}/${liveCase.expectStatus} chart=${spec.report.chartType} ` +
                `(expected ${liveCase.expectedChartTypes.join("|")}) chartValid=${chartCheck.ok} ` +
                `verified=${spec.report.insights.length} stripped=${spec.stripped.length} ` +
                `deliveredStripped=${deliveredCheck.stripped.length} piiHit=${piiHit}`,
            }),
      });
    }
  }

  const fidelityDenom = verifiedTotal + strippedTotal + missingInsightCases;
  const numericFidelity =
    fidelityDenom > 0
      ? verifiedTotal / fidelityDenom
      : expectedInsightCases > 0
        ? 0
        : 1;
  const deliveredDenom = deliveredVerified + deliveredStripped;
  const deliveredNumericFidelity =
    deliveredDenom > 0 ? deliveredVerified / deliveredDenom : 1;

  const partialSummary = {
    mode,
    labelAccuracy: labelPassed,
    labelTotal: labels.length,
    specValidity: specValid,
    numericFidelity,
    deliveredNumericFidelity,
    stripGuardsPassed,
    stripGuardsTotal,
    causalStrips,
    meanLatencyMs: vizRunCount > 0 ? latencyTotal / vizRunCount : 0,
    meanPromptTokens: vizRunCount > 0 ? promptTokensTotal / vizRunCount : 0,
    meanCompletionTokens: vizRunCount > 0 ? completionTokensTotal / vizRunCount : 0,
    totalCostUsd: costUsdTotal,
  };
  const { gatesPassed, gateFailures } = evaluateUc03Gates(partialSummary);
  const summary: Uc03Summary = {
    ...partialSummary,
    gatesPassed,
    gateFailures,
  };

  return {
    cases,
    summary,
    gatesPassed,
  };
}

export function printUc03Report(results: Uc03Results): void {
  const passed = results.cases.filter((c) => c.exPass).length;
  const accuracy =
    results.summary.labelTotal > 0
      ? ((results.summary.labelAccuracy / results.summary.labelTotal) * 100).toFixed(1)
      : "n/a";
  const tokenNote =
    results.summary.mode === "deterministic"
      ? "0 prompt tokens in deterministic mode"
      : `mean ${results.summary.meanPromptTokens.toFixed(0)} prompt / ${results.summary.meanCompletionTokens.toFixed(0)} completion tokens, cost $${results.summary.totalCostUsd.toFixed(4)} in ${results.summary.mode} mode`;
  console.log(
    `eval uc03 [${results.summary.mode}]: ${passed}/${results.cases.length} pass ` +
      `(chart-type accuracy ${accuracy}% on ${results.summary.labelTotal} labels, ` +
      `${results.summary.specValidity} valid specs, ` +
      `numeric fidelity ${(results.summary.numericFidelity * 100).toFixed(1)}%, ` +
      `delivered fidelity ${(results.summary.deliveredNumericFidelity * 100).toFixed(1)}%, ` +
      `${results.summary.stripGuardsPassed}/${results.summary.stripGuardsTotal} strip guards, ` +
      `${results.summary.causalStrips} causal strips, ` +
      `mean VIZ latency ${results.summary.meanLatencyMs.toFixed(1)}ms, ${tokenNote})`,
  );
  if (!results.summary.gatesPassed) {
    console.log(`  GATE FAIL: ${results.summary.gateFailures.join("; ")}`);
  }
  for (const c of results.cases.filter((c) => !c.exPass)) {
    console.log(`  FAIL ${c.id}: ${c.note ?? "mismatch"}`);
  }
}
