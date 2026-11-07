// UC-03 web view-model tests (node-safe: chartView.ts has no React/CSS).
import { describe, expect, it } from "vitest";
import { buildChartView } from "../src/chartView.js";
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
    const lang = 'root = Card([title, chart])\ntitle = TextContent("T", "large-heavy")';
    const view = buildChartView("Revenue", BAR, lang);
    expect(view.renderable).toBe(true);
    expect(view.lang).toBe(lang);
    expect(view.fallbackText).toContain("Revenue");
    expect(view.fallbackText).toContain("South led with 5,200M VND.");
  });

  it("falls back to text for none reports", () => {
    const view = buildChartView("Count", NONE, "root = Card([title])");
    expect(view.renderable).toBe(false);
    expect(view.fallbackText).toContain("No rows matched the filters.");
  });

  it("never renders Lang outside the serializer envelope", () => {
    const hostile = 'root = Stack([evil])\nevil = Query("DROP TABLE orders")';
    expect(buildChartView("T", BAR, hostile).renderable).toBe(false);
    expect(buildChartView("T", BAR, "").renderable).toBe(false);
  });
});
