// UC-03 eval grader & numeric fidelity gate tests (Issue #93).
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateUc03Gates,
  gradeUc03,
  type LiveGraphRunner,
} from "../../../evals/uc03/grader.js";
import type { VizModelLike } from "../src/subgraphs/uc03/synthesize.js";
import type { Uc03VizSpec } from "../src/subgraphs/uc03/viz.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function jsonModelFromPrompt(
  claimBuilder: (prompt: string) => {
    insights: Array<{ claim: string; evidence: Array<{ column: string; rowKey: string; value: string | number }> }>;
  },
): VizModelLike {
  const buildDraft = (prompt: string) => {
    const chartMatch = prompt.match(/Required chartType: (\w+)\./);
    const chartType = (chartMatch?.[1] ?? "none") as
      | "line"
      | "bar"
      | "pie"
      | "scatter"
      | "table"
      | "none";
    const rowsMatch = prompt.match(/<untrusted_data>([\s\S]*?)<\/untrusted_data>/);
    const rows = rowsMatch ? (JSON.parse(rowsMatch[1]) as Record<string, unknown>[]) : [];
    const colsMatch = prompt.match(/Columns: ([^\n]+)/);
    const cols = colsMatch ? colsMatch[1].split(",").map((c) => c.trim()) : [];

    let chartSpec: Record<string, unknown> = { chart: "None" };
    if (chartType === "line" && rows.length > 0) {
      chartSpec = {
        chart: "LineChart",
        labels: rows.map((r) => String(r[cols[0]])),
        series: [{ category: cols[1], values: rows.map((r) => Number(r[cols[1]])) }],
      };
    } else if (chartType === "bar" && rows.length > 0) {
      chartSpec = {
        chart: "BarChart",
        labels: rows.map((r) => String(r[cols[0]])),
        series: [{ category: cols[1], values: rows.map((r) => Number(r[cols[1]])) }],
      };
    } else if (chartType === "pie" && rows.length > 0) {
      chartSpec = {
        chart: "PieChart",
        labels: rows.map((r) => String(r[cols[0]])),
        values: rows.map((r) => Number(r[cols[1]])),
      };
    } else if (chartType === "table" && rows.length > 0) {
      chartSpec = {
        chart: "Table",
        columns: cols.slice(0, 2).map((col) => ({
          label: col,
          data: rows.map((r) => r[col] as string | number),
        })),
      };
    }

    const { insights } = claimBuilder(prompt);
    return {
      chartType,
      chartSpec,
      chartReason: `Selected ${chartType} based on result shape.`,
      insights,
      caveats: [],
    };
  };

  return {
    withStructuredOutput: () => ({
      invoke: async (prompt: string) => buildDraft(prompt),
    }),
  };
}

describe("UC-03 eval grader & numeric fidelity gate (#93)", () => {
  it("passes deterministic mode with 100% clean & delivered numeric fidelity", async () => {
    const res = await gradeUc03(repoRoot, { mode: "deterministic" });
    expect(res.gatesPassed).toBe(true);
    expect(res.summary.mode).toBe("deterministic");
    expect(res.summary.numericFidelity).toBe(1);
    expect(res.summary.deliveredNumericFidelity).toBe(1);
    expect(res.summary.stripGuardsPassed).toBe(res.summary.stripGuardsTotal);
    expect(res.summary.stripGuardsTotal).toBe(4);
    expect(res.summary.causalStrips).toBe(1);
    expect(res.cases.every((c) => c.exPass)).toBe(true);
  });

  it("gates below PRD thresholds (numeric fidelity, delivered fidelity, label accuracy, spec validity)", () => {
    const base = {
      labelAccuracy: 16,
      labelTotal: 16,
      specValidity: 16,
      numericFidelity: 1,
      deliveredNumericFidelity: 1,
      stripGuardsPassed: 4,
      stripGuardsTotal: 4,
    };
    expect(evaluateUc03Gates(base).gatesPassed).toBe(true);

    const lowFidelity = evaluateUc03Gates({ ...base, numericFidelity: 0.5 });
    expect(lowFidelity.gatesPassed).toBe(false);
    expect(lowFidelity.gateFailures.join(" ")).toContain("numeric fidelity 50.0% < 100.0%");

    const lowDelivered = evaluateUc03Gates({ ...base, deliveredNumericFidelity: 0.8 });
    expect(lowDelivered.gatesPassed).toBe(false);
    expect(lowDelivered.gateFailures.join(" ")).toContain("delivered numeric fidelity");

    const lowLabels = evaluateUc03Gates({ ...base, labelAccuracy: 12 });
    expect(lowLabels.gatesPassed).toBe(false);
    expect(lowLabels.gateFailures.join(" ")).toContain("chart-type accuracy");

    const badSpec = evaluateUc03Gates({ ...base, specValidity: 15 });
    expect(badSpec.gatesPassed).toBe(false);
    expect(badSpec.gateFailures.join(" ")).toContain("spec validity");
  });

  it("passes live mode when the model emits 100% grounded insights", async () => {
    const model = jsonModelFromPrompt((prompt) => {
      if (prompt.includes("997715")) {
        return {
          insights: [
            {
              claim: "Total orders reached 997,715.",
              evidence: [{ column: "n", rowKey: "997715", value: 997715 }],
            },
          ],
        };
      }
      if (prompt.includes("Điện tử")) {
        return {
          insights: [
            {
              claim: "Electronics leads with 35% share.",
              evidence: [{ column: "share", rowKey: "Điện tử", value: 35 }],
            },
          ],
        };
      }
      if (prompt.includes("Bac")) {
        return {
          insights: [
            {
              claim: "South led with 5,200M VND.",
              evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
            },
          ],
        };
      }
      if (prompt.includes("ignore previous instructions")) {
        return {
          insights: [
            {
              claim: "Nam reached 5,200M VND.",
              evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
            },
          ],
        };
      }
      return {
        insights: [
          {
            claim: "September 2026 reached 5,200M VND, up 8.0% vs August (4,815M VND); nguyên nhân chưa rõ.",
            evidence: [
              { column: "revenue", rowKey: "2026-09", value: 5200 },
              { column: "revenue", rowKey: "2026-08", value: 4815 },
            ],
          },
        ],
      };
    });

    const res = await gradeUc03(repoRoot, { mode: "live", model });
    expect(res.summary.mode).toBe("live");
    expect(res.summary.numericFidelity).toBe(1);
    expect(res.summary.deliveredNumericFidelity).toBe(1);
    expect(res.summary.stripGuardsPassed).toBe(4);
    expect(res.gatesPassed).toBe(true);
    expect(res.cases.every((c) => c.exPass)).toBe(true);
  });

  it("fails live mode when the model hallucinates a number or returns empty insights", async () => {
    const hallucinatingModel = jsonModelFromPrompt((prompt) => {
      if (prompt.includes("997715")) {
        return {
          insights: [
            {
              claim: "Total orders reached 997,715.",
              evidence: [{ column: "n", rowKey: "997715", value: 997715 }],
            },
          ],
        };
      }
      return {
        insights: [
          {
            claim: "Revenue hit 9,999M VND.",
            evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
          },
        ],
      };
    });

    const badRes = await gradeUc03(repoRoot, { mode: "live", model: hallucinatingModel });
    expect(badRes.gatesPassed).toBe(false);
    expect(badRes.summary.numericFidelity).toBeLessThan(1);

    const emptyModel = jsonModelFromPrompt(() => ({ insights: [] }));
    const emptyRes = await gradeUc03(repoRoot, { mode: "live", model: emptyModel });
    expect(emptyRes.gatesPassed).toBe(false);
    expect(emptyRes.summary.numericFidelity).toBe(0);
  });

  it("fails closed when live mode is requested without AGENT_MODEL_API_KEY", async () => {
    const saved = process.env.AGENT_MODEL_API_KEY;
    delete process.env.AGENT_MODEL_API_KEY;
    try {
      await expect(gradeUc03(repoRoot, { mode: "live" })).rejects.toThrow(
        /AGENT_MODEL_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env.AGENT_MODEL_API_KEY = saved;
    }
  });

  it("supports live_graph mode via injected liveGraphRunner", async () => {
    const model = jsonModelFromPrompt((prompt) => {
      if (prompt.includes("997715")) {
        return {
          insights: [
            {
              claim: "Total orders reached 997,715.",
              evidence: [{ column: "n", rowKey: "997715", value: 997715 }],
            },
          ],
        };
      }
      if (prompt.includes("Điện tử")) {
        return {
          insights: [
            {
              claim: "Electronics leads with 35% share.",
              evidence: [{ column: "share", rowKey: "Điện tử", value: 35 }],
            },
          ],
        };
      }
      return {
        insights: [
          {
            claim: "Revenue reached 5,200M VND.",
            evidence: [{ column: "revenue", rowKey: prompt.includes("Bac") || prompt.includes("ignore") ? "Nam" : "2026-09", value: 5200 }],
          },
        ],
      };
    });

    const liveGraphRunner: LiveGraphRunner = async (c) => {
      if (c.expectStatus === "no_data") {
        const spec: Uc03VizSpec = {
          kind: "insight_report",
          report: {
            chartType: "none",
            chartSpec: { chart: "None" },
            chartReason: "No data matched.",
            insights: [],
            caveats: ["No rows matched the filters."],
          },
          openuiLang: 'root = Card([title])\ntitle = TextContent("Empty")',
          stripped: [],
          repairs: 0,
          deterministic: false,
        };
        return {
          status: "no_data",
          columns: ["region", "revenue"],
          rows: [],
          vizSpec: spec,
          answerText: "No data",
          ms: 10,
          tokens: 0,
        };
      }
      if (c.expectedChartTypes.includes("none")) {
        const spec: Uc03VizSpec = {
          kind: "insight_report",
          report: {
            chartType: "none",
            chartSpec: { chart: "None" },
            chartReason: "Single scalar.",
            insights: [
              {
                claim: "Delivered orders: 120.",
                evidence: [{ column: "n", rowKey: "120", value: 120 }],
              },
            ],
            caveats: [],
          },
          openuiLang: 'root = Card([title])\ntitle = TextContent("Count")',
          stripped: [],
          repairs: 0,
          deterministic: false,
        };
        return {
          status: "ok",
          columns: ["n"],
          rows: [{ n: 120 }],
          vizSpec: spec,
          answerText: "120",
          ms: 15,
          tokens: 100,
        };
      }
      if (c.expectedChartTypes.includes("line")) {
        const spec: Uc03VizSpec = {
          kind: "insight_report",
          report: {
            chartType: "line",
            chartSpec: {
              chart: "LineChart",
              labels: ["2026-08", "2026-09"],
              series: [{ category: "revenue", values: [100, 120] }],
            },
            chartReason: "Time series.",
            insights: [
              {
                claim: "2026-09 revenue reached 120.",
                evidence: [{ column: "revenue", rowKey: "2026-09", value: 120 }],
              },
            ],
            caveats: [],
          },
          openuiLang: 'root = Card([title, chart])\ntitle = TextContent("Line")\nchart = LineChart(["2026-08","2026-09"], [])',
          stripped: [],
          repairs: 0,
          deterministic: false,
        };
        return {
          status: "ok",
          columns: ["month", "revenue"],
          rows: [
            { month: "2026-08", revenue: 100 },
            { month: "2026-09", revenue: 120 },
          ],
          vizSpec: spec,
          answerText: "120",
          ms: 20,
          tokens: 150,
        };
      }
      const spec: Uc03VizSpec = {
        kind: "insight_report",
        report: {
          chartType: "bar",
          chartSpec: {
            chart: "BarChart",
            labels: ["Nam", "Bac"],
            series: [{ category: "revenue", values: [200, 100] }],
          },
          chartReason: "Comparison.",
          insights: [
            {
              claim: "Nam reached 200.",
              evidence: [{ column: "revenue", rowKey: "Nam", value: 200 }],
            },
          ],
          caveats: [],
        },
        openuiLang: 'root = Card([title, chart])\ntitle = TextContent("Bar")\nchart = BarChart(["Nam","Bac"], [])',
        stripped: [],
        repairs: 0,
        deterministic: false,
      };
      return {
        status: "ok",
        columns: ["region", "revenue"],
        rows: [
          { region: "Nam", revenue: 200 },
          { region: "Bac", revenue: 100 },
        ],
        vizSpec: spec,
        answerText: "Nam 200",
        ms: 20,
        tokens: 150,
      };
    };

    const res = await gradeUc03(repoRoot, {
      mode: "live_graph",
      model,
      liveGraphRunner,
    });
    expect(res.summary.mode).toBe("live_graph");
    expect(res.gatesPassed).toBe(true);
    expect(res.cases.some((c) => c.id === "uc03-live-01" && c.exPass)).toBe(true);
  });
});
