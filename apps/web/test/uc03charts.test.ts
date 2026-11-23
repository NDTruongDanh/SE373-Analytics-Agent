// UC-03 web view-model tests (node-safe: chartView.ts has no React/CSS).
import { describe, expect, it } from "vitest";
import { buildChartView, isTrustedOpenuiLang } from "../src/chartView.js";
import type { InsightReport } from "@shared/contracts";

const BAR: InsightReport = {
  chartType: "bar",
  chartSpec: {
    chart: "BarChart",
    labels: ["Nam", "Trung", "Bac"],
    series: [{ category: "revenue", values: [5200, 3100, 2800] }],
  },
  chartReason: "Three regions compared, so a bar chart fits.",
  insights: [
    {
      claim: "South led with 5,200M VND.",
      evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
    },
  ],
  caveats: [],
};

const NONE: InsightReport = {
  chartType: "none",
  chartSpec: { chart: "None" },
  chartReason: "A single scalar value needs no chart.",
  insights: [],
  caveats: ["No rows matched the filters."],
};

describe("UC-03 web chart view", () => {
  it("marks serializer Lang as renderable with a text fallback", () => {
    const lang = [
      "root = Card([title, chart, notes])",
      'title = TextContent("Revenue", "large-heavy")',
      'chart = BarChart(labels, [s1], "grouped")',
      'labels = ["Nam","Trung","Bac"]',
      's1 = Series("revenue", [5200,3100,2800])',
      'notes = TextContent("South led with 5,200M VND.", "default")',
    ].join("\n");
    const view = buildChartView("Revenue", BAR, lang);
    expect(view.renderable).toBe(true);
    expect(view.lang).toBe(lang);
    expect(view.fallbackText).toContain("Revenue");
    expect(view.fallbackText).toContain("South led with 5,200M VND.");
  });

  it("validates all serializer chart constructors and rejects untrusted Lang", () => {
    const lineLang = [
      "root = Card([title, chart])",
      'title = TextContent("Trend", "large-heavy")',
      'chart = LineChart(labels, [s1], "natural", "month", "revenue")',
      'labels = ["2026-08","2026-09"]',
      's1 = Series("revenue", [4815,5200])',
    ].join("\n");
    const pieLang = [
      "root = Card([title, chart])",
      'title = TextContent("Share", "large-heavy")',
      'chart = PieChart(labels, values, "donut")',
      'labels = ["A","B"]',
      "values = [60,40]",
    ].join("\n");
    const scatterLang = [
      "root = Card([title, chart])",
      'title = TextContent("Scatter", "large-heavy")',
      "chart = ScatterChart([d1])",
      'd1 = ScatterSeries("orders", [p1_1])',
      "p1_1 = Point(100, 50)",
    ].join("\n");
    const tableLang = [
      "root = Card([title, chart])",
      'title = TextContent("Detail", "large-heavy")',
      "chart = Table([c1, c2])",
      'c1 = Col("region", ["Nam","Bac"], "string")',
      'c2 = Col("revenue", [5200,2800], "number")',
    ].join("\n");

    expect(isTrustedOpenuiLang(lineLang)).toBe(true);
    expect(isTrustedOpenuiLang(pieLang)).toBe(true);
    expect(isTrustedOpenuiLang(scatterLang)).toBe(true);
    expect(isTrustedOpenuiLang(tableLang)).toBe(true);
    expect(
      isTrustedOpenuiLang(
        'root = Card([title])\ntitle = TextContent("How does Query() work?", "large-heavy")',
      ),
    ).toBe(true);

    expect(isTrustedOpenuiLang('root = Stack([evil])\nevil = Query("DROP TABLE orders")')).toBe(false);
    expect(isTrustedOpenuiLang('root = Card([evil])\nevil = Query("DROP TABLE orders")')).toBe(false);
    expect(isTrustedOpenuiLang('root = Card([Query("DROP TABLE orders")])')).toBe(false);
    expect(isTrustedOpenuiLang('root = Card([evil])\nevil = Mutation("DELETE FROM orders")')).toBe(false);
    expect(isTrustedOpenuiLang("")).toBe(false);
  });

  it("falls back to text for none reports", () => {
    const view = buildChartView("Count", NONE, "root = Card([title])");
    expect(view.renderable).toBe(false);
    expect(view.fallbackText).toContain("No rows matched the filters.");
  });

  it("never renders Lang outside the serializer envelope", () => {
    const hostile = 'root = Stack([evil])\nevil = Query("DROP TABLE orders")';
    const hostileCard = 'root = Card([evil])\nevil = Query("DROP TABLE orders")';
    expect(buildChartView("T", BAR, hostile).renderable).toBe(false);
    expect(buildChartView("T", BAR, hostileCard).renderable).toBe(false);
    expect(buildChartView("T", BAR, "").renderable).toBe(false);
  });
});
