import { describe, expect, it } from "vitest";
import {
  AgentResponseSchema,
  CHART_TYPE_TO_COMPONENT,
  EvidencePointerSchema,
  InsightChartTypeSchema,
  InsightClaimSchema,
  InsightReportResponseSchema,
  InsightReportSchema,
  OpenuiChartSpecSchema,
  RenderChartInputSchema,
} from "../src/index.js";

function validReport() {
  return {
    chartType: "line" as const,
    chartSpec: {
      chart: "LineChart" as const,
      labels: ["2026-06", "2026-07", "2026-08", "2026-09"],
      series: [{ category: "revenue", values: [4100, 4520, 4815, 5200] }],
      xLabel: "month",
      yLabel: "revenue (M VND)",
    },
    chartReason: "Four-month revenue is a time series, so a line chart shows the trend.",
    insights: [
      {
        claim: "Revenue in September 2026 was 5,200M VND, up 8.0% vs August (4,815M VND).",
        evidence: [
          { column: "revenue", rowKey: "2026-09", value: 5200 },
          { column: "revenue", rowKey: "2026-08", value: 4815 },
        ],
      },
      {
        claim: "The South region led with 2,100M VND in September.",
        evidence: [{ column: "revenue", rowKey: "Nam|2026-09", value: 2100 }],
      },
    ],
    caveats: ["October 2026 covers only the first 6 days."],
  };
}

describe("UC-03 InsightReport contracts", () => {
  it("accepts a fully-evidenced line-chart report", () => {
    const parsed = InsightReportSchema.parse(validReport());
    expect(parsed.chartType).toBe("line");
    expect(parsed.insights).toHaveLength(2);
    expect(parsed.caveats).toHaveLength(1);
  });

  it("defaults missing caveats to an empty array", () => {
    const full = validReport();
    const { chartType, chartSpec, chartReason, insights } = full;
    const parsed = InsightReportSchema.parse({ chartType, chartSpec, chartReason, insights });
    expect(parsed.caveats).toEqual([]);
  });

  it("accepts an empty-insights none-chart report for no_data", () => {
    const parsed = InsightReportSchema.parse({
      chartType: "none",
      chartSpec: { chart: "None" },
      chartReason: "Single scalar with no rows, so no chart is drawn.",
      insights: [],
      caveats: ["No rows matched the filter; October data is partial."],
    });
    expect(parsed.insights).toEqual([]);
  });

  it("accepts all six chart types with their OpenUI component specs", () => {
    const specs = {
      line: { chart: "LineChart", labels: ["a", "b"], series: [{ category: "s", values: [1, 2] }] },
      bar: { chart: "BarChart", labels: ["Nam", "Trung", "Bac"], series: [{ category: "revenue", values: [5, 3, 4] }] },
      pie: { chart: "PieChart", labels: ["A", "B", "C"], values: [50, 30, 20] },
      scatter: {
        chart: "ScatterChart",
        datasets: [{ name: "orders", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
      },
      table: {
        chart: "Table",
        columns: [
          { label: "region", data: ["Nam", "Bac"] },
          { label: "revenue", data: [5200, 3100] },
        ],
      },
      none: { chart: "None" },
    } as const;
    for (const [chartType, chartSpec] of Object.entries(specs)) {
      expect(InsightChartTypeSchema.parse(chartType)).toBe(chartType);
      expect(CHART_TYPE_TO_COMPONENT[chartType as keyof typeof CHART_TYPE_TO_COMPONENT]).toBe(
        (chartSpec as { chart: string }).chart,
      );
      expect(
        InsightReportSchema.parse({ ...validReport(), chartType, chartSpec }).chartType,
      ).toBe(chartType);
    }
    expect(() => InsightChartTypeSchema.parse("3d")).toThrow();
  });

  it("rejects chartType/spec mismatches", () => {
    expect(() =>
      InsightReportSchema.parse({
        ...validReport(),
        chartType: "pie",
        chartSpec: {
          chart: "LineChart",
          labels: ["a"],
          series: [{ category: "s", values: [1] }],
        },
      }),
    ).toThrow();
    // Vega-Lite-style specs no longer parse
    expect(() =>
      OpenuiChartSpecSchema.parse({ mark: "bar", encoding: { x: { field: "region" } } }),
    ).toThrow();
  });

  it("rejects ragged series, pie length drift, and ragged table columns", () => {
    expect(() =>
      InsightReportSchema.parse({
        ...validReport(),
        chartSpec: { chart: "LineChart", labels: ["a", "b"], series: [{ category: "s", values: [1] }] },
      }),
    ).toThrow();
    expect(() =>
      InsightReportSchema.parse({
        ...validReport(),
        chartType: "pie",
        chartSpec: { chart: "PieChart", labels: ["A", "B"], values: [1] },
      }),
    ).toThrow();
    expect(() =>
      InsightReportSchema.parse({
        ...validReport(),
        chartType: "table",
        chartSpec: {
          chart: "Table",
          columns: [
            { label: "a", data: [1, 2] },
            { label: "b", data: [1] },
          ],
        },
      }),
    ).toThrow();
  });

  it("accepts numeric and string evidence values", () => {
    expect(EvidencePointerSchema.parse({ column: "region", rowKey: "Nam", value: "Nam" }).value).toBe("Nam");
    expect(EvidencePointerSchema.parse({ column: "revenue", rowKey: "2026-09", value: 5200 }).value).toBe(5200);
  });

  it("rejects evidence with empty column, empty rowKey, or non-cell values", () => {
    expect(() => EvidencePointerSchema.parse({ column: "", rowKey: "2026-09", value: 1 })).toThrow();
    expect(() => EvidencePointerSchema.parse({ column: "revenue", rowKey: "", value: 1 })).toThrow();
    expect(() => EvidencePointerSchema.parse({ column: "revenue", rowKey: "2026-09", value: true })).toThrow();
    expect(() => EvidencePointerSchema.parse({ column: "revenue", rowKey: "2026-09", value: null })).toThrow();
    // snake_case row_key is not canonical — rowKey is required
    expect(() =>
      EvidencePointerSchema.parse({ column: "revenue", row_key: "2026-09", value: 5200 }),
    ).toThrow();
  });

  it("rejects claims without evidence and empty claims", () => {
    expect(() => InsightClaimSchema.parse({ claim: "Revenue grew.", evidence: [] })).toThrow();
    expect(() =>
      InsightClaimSchema.parse({ claim: "", evidence: [{ column: "revenue", rowKey: "2026-09", value: 1 }] }),
    ).toThrow();
  });

  it("rejects empty chartReason and more than ten insights", () => {
    expect(() => InsightReportSchema.parse({ ...validReport(), chartReason: "" })).toThrow();
    const many = Array.from({ length: 11 }, (_, i) => ({
      claim: `Claim ${i}`,
      evidence: [{ column: "revenue", rowKey: `row-${i}`, value: i }],
    }));
    expect(() => InsightReportSchema.parse({ ...validReport(), insights: many })).toThrow();
  });

  it("wires the strict payload into AgentResponse kind insight_report", () => {
    const parsed = AgentResponseSchema.parse({
      kind: "insight_report",
      status: "ok",
      summary: "Two verified insights with a line chart.",
      data: validReport(),
    });
    expect(parsed.kind).toBe("insight_report");

    const direct = InsightReportResponseSchema.parse({
      kind: "insight_report",
      status: "ok",
      summary: "Two verified insights with a line chart.",
      data: validReport(),
    });
    expect(direct.data.chartType).toBe("line");

    // loose data no longer parses
    expect(() =>
      AgentResponseSchema.parse({ kind: "insight_report", status: "ok", summary: "x", data: { n: 1 } }),
    ).toThrow();
    // envelope still requires status + summary
    expect(() => AgentResponseSchema.parse({ kind: "insight_report", status: "ok", data: validReport() })).toThrow();
  });

  it("validates the render_chart tool input against the same OpenUI spec", () => {
    const report = validReport();
    expect(
      RenderChartInputSchema.parse({ chartType: report.chartType, spec: report.chartSpec }).chartType,
    ).toBe("line");
    expect(() =>
      RenderChartInputSchema.parse({ chartType: "bar", spec: { chart: "None" } }),
    ).toThrow();
  });
});
