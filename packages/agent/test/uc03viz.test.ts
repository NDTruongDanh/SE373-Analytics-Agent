// UC-03 VIZ seam tests: deterministic path, live path, repairs, fallback.
import { describe, expect, it } from "vitest";
import type { AgentState, RootRuntime } from "../src/state.js";
import { createUc03Viz, type Uc03VizSpec } from "../src/subgraphs/uc03/viz.js";
import {
  VizDraftSchema,
  type VizModelLike,
} from "../src/subgraphs/uc03/synthesize.js";
import { UNTRUSTED_DATA_CLOSE, UNTRUSTED_DATA_OPEN } from "../src/constants.js";

function stateOf(partial: Record<string, unknown>): AgentState {
  // Plain-object state: the frozen root validates on invoke, but the seam
  // is unit-tested by direct call, so defaults are inlined here.
  return {
    question: "Revenue by region?",
    ucId: "uc03-test",
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
    resultPreview: [],
    columns: [],
    sql: null,
    tablesUsed: [],
    toolsCalled: [],
    status: "no_data",
    answerText: "",
    budget: { llmCalls: 0, tokensUsed: 0, maxLlmCalls: 20, maxTokens: 60000, deadlineMs: 0 },
    telemetry: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    runId: "run-uc03",
    threadId: "thread-uc03",
    vizSpec: null,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
    ...partial,
  } as unknown as AgentState;
}

interface Seen {
  prompts: string[];
  spans: { node: string; type: string; payload?: unknown }[];
}

function harness() {
  const seen: Seen = { prompts: [], spans: [] };
  const rt = {
    emit: (event: { node: string; type: string; payload?: unknown }) => {
      seen.spans.push({ node: event.node, type: event.type, payload: event.payload });
      return `span-${seen.spans.length}`;
    },
    config: { configurable: {} },
  } as unknown as RootRuntime;
  return { seen, rt };
}

function scriptedModel(drafts: unknown[], seen: Seen): VizModelLike {
  let index = 0;
  return {
    withStructuredOutput: () => ({
      invoke: async (input: string) => {
        seen.prompts.push(input);
        const draft = drafts[Math.min(index, drafts.length - 1)];
        index += 1;
        return VizDraftSchema.parse(draft);
      },
    }),
  };
}

const BAR_BUFFER = {
  columns: ["region", "revenue"],
  rows: [
    { region: "Nam", revenue: 5200 },
    { region: "Trung", revenue: 3100 },
    { region: "Bac", revenue: 2800 },
  ],
};

const BAR_SPEC = {
  chart: "BarChart",
  labels: ["Nam", "Trung", "Bac"],
  series: [{ category: "revenue", values: [5200, 3100, 2800] }],
  variant: "grouped",
};

function barDraft(claim = "South led with 5,200M VND.") {
  return {
    chartType: "bar",
    chartSpec: BAR_SPEC,
    chartReason: "Three regions compared, so a bar chart fits.",
    insights: [
      {
        claim,
        evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
      },
    ],
    caveats: [],
  };
}

describe("UC-03 VIZ seam", () => {
  it("skips non-ok/no_data statuses without touching state", async () => {
    const { rt } = harness();
    const out = await createUc03Viz({ model: null })(
      stateOf({ status: "restricted", ...BAR_BUFFER, resultPreview: BAR_BUFFER.rows }),
      rt,
    );
    expect(out).toEqual({});
  });

  it("runs the deterministic path with no model: valid chart, no insights", async () => {
    const { seen, rt } = harness();
    const before = stateOf({ status: "ok", ...BAR_BUFFER, resultPreview: BAR_BUFFER.rows });
    const out = await createUc03Viz({ model: null })(before, rt);
    const spec = out.vizSpec as Uc03VizSpec;
    expect(spec.kind).toBe("insight_report");
    expect(spec.report.chartType).toBe("bar");
    expect(spec.report.insights).toEqual([]);
    expect(spec.report.caveats.join(" ")).toMatch(/no model key/);
    expect(spec.deterministic).toBe(true);
    expect(spec.openuiLang).toContain("chart = BarChart(labels, [s1]");
    // Never touches the answer seam's fields.
    expect(out).not.toHaveProperty("answerText");
    expect(out).not.toHaveProperty("toolsCalled");
    expect(out).not.toHaveProperty("status");
    expect(out.budget).toMatchObject({ llmCalls: 0, tokensUsed: 0 });
    expect(seen.spans.map((span) => span.type)).toContain("chart_selected");
    expect(seen.spans.map((span) => span.type)).toContain("node_done");
  });

  it("reports none with required caveats for no_data", async () => {
    const { rt } = harness();
    const out = await createUc03Viz({ model: null })(
      stateOf({ status: "no_data", columns: ["region"], resultPreview: [] }),
      rt,
    );
    const spec = out.vizSpec as Uc03VizSpec;
    expect(spec.report.chartType).toBe("none");
    expect(spec.report.chartSpec).toEqual({ chart: "None" });
    expect(spec.report.caveats.length).toBeGreaterThan(0);
    expect(spec.report.insights).toEqual([]);
  });

  it("verifies a live draft and binds zero tools over untrusted rows", async () => {
    const { seen, rt } = harness();
    const model = scriptedModel([barDraft()], seen);
    expect((model as unknown as { bindTools?: unknown }).bindTools).toBeUndefined();
    const out = await createUc03Viz({ model })(
      stateOf({ status: "ok", ...BAR_BUFFER, resultPreview: BAR_BUFFER.rows }),
      rt,
    );
    const spec = out.vizSpec as Uc03VizSpec;
    expect(spec.report.insights).toHaveLength(1);
    expect(spec.stripped).toHaveLength(0);
    expect(spec.repairs).toBe(0);
    expect(spec.openuiLang).toContain("BarChart");
    // Prompt hygiene: rows delimited, columns named, model via structured output.
    expect(seen.prompts).toHaveLength(1);
    expect(seen.prompts[0]).toContain(UNTRUSTED_DATA_OPEN);
    expect(seen.prompts[0]).toContain(UNTRUSTED_DATA_CLOSE);
    expect(out.budget?.llmCalls).toBe(1);
  });

  it("strips fabricated numbers and traces the removal", async () => {
    const { seen, rt } = harness();
    const model = scriptedModel([barDraft("South led with 9,999M VND.")], seen);
    // Evidence still cites the real cell, so the pointer is valid but the
    // claimed number matches nothing — the claim must go.
    const out = await createUc03Viz({ model })(
      stateOf({ status: "ok", ...BAR_BUFFER, resultPreview: BAR_BUFFER.rows }),
      rt,
    );
    const spec = out.vizSpec as Uc03VizSpec;
    expect(spec.report.insights).toHaveLength(0);
    expect(spec.stripped).toHaveLength(1);
    expect(spec.stripped[0].reason).toMatch(/matches no query result/);
    expect(spec.report.caveats.join(" ")).toMatch(/failed numeric verification/);
    expect(seen.spans.map((span) => span.type)).toContain("claim_stripped");
  });

  it("repairs a chartType mismatch within the 2-repair bound", async () => {
    const { rt } = harness();
    const bad = {
      ...barDraft(),
      chartSpec: {
        chart: "LineChart",
        labels: ["Nam", "Trung", "Bac"],
        series: [{ category: "revenue", values: [5200, 3100, 2800] }],
      },
    };
    const seen2: Seen = { prompts: [], spans: [] };
    const rt2 = {
      emit: (event: { node: string; type: string; payload?: unknown }) => {
        seen2.spans.push({ node: event.node, type: event.type, payload: event.payload });
        return "s";
      },
      config: { configurable: {} },
    } as unknown as RootRuntime;
    const model = scriptedModel([bad, barDraft()], seen2);
    const out = await createUc03Viz({ model })(
      stateOf({ status: "ok", ...BAR_BUFFER, resultPreview: BAR_BUFFER.rows }),
      rt2,
    );
    const spec = out.vizSpec as Uc03VizSpec;
    expect(spec.report.chartType).toBe("bar");
    expect(spec.repairs).toBe(1);
    expect(out.budget?.llmCalls).toBe(2);
    expect(seen2.prompts).toHaveLength(2);
    expect(seen2.prompts[1]).toMatch(/Repair attempt 1/);
    void rt;
  });

  it("falls back to the result table after exhausted repairs", async () => {
    const { seen, rt } = harness();
    // Two categorical splits force chartType "table"; every draft is an
    // unrepairable shape violation, so all 3 attempts fail headlessly.
    const tableBuffer = {
      columns: ["region", "product", "revenue"],
      rows: [
        { region: "Nam", product: "Nồi cơm", revenue: 5200 },
        { region: "Bac", product: "Áo thun", revenue: 2800 },
      ],
    };
    const bad = {
      chartType: "table",
      chartSpec: {
        chart: "LineChart",
        labels: ["Nam", "Bac"],
        series: [{ category: "revenue", values: [5200, 2800] }],
      },
      chartReason: "wrong component for a table report",
      insights: [],
      caveats: [],
    };
    const model = scriptedModel([bad, bad, bad, bad], seen);
    const out = await createUc03Viz({ model })(
      stateOf({ status: "ok", ...tableBuffer, resultPreview: tableBuffer.rows }),
      rt,
    );
    const spec = out.vizSpec as Uc03VizSpec;
    expect(spec.report.chartType).toBe("table");
    expect(spec.repairs).toBe(2);
    expect(out.budget?.llmCalls).toBe(3);
  });
});
