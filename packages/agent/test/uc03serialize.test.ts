// UC-03 OpenUI Lang serializer tests: exact Lang per chart type.
import { describe, expect, it } from "vitest";
import { serializeOpenuiLang } from "../src/subgraphs/uc03/serialize.js";

describe("UC-03 OpenUI Lang serializer", () => {
  it("serializes a bar chart against the chat library", () => {
    const lang = serializeOpenuiLang({
      title: "Revenue by region",
      spec: {
        chart: "BarChart",
        labels: ["Nam", "Trung", "Bac"],
        series: [{ category: "revenue", values: [5200, 3100, 2800] }],
        variant: "grouped",
      },
      notes: ["South led at 5,200M VND."],
    });
    expect(lang).toBe(
      [
        "root = Card([title, chart, notes])",
        'title = TextContent("Revenue by region", "large-heavy")',
        "chart = BarChart(labels, [s1], \"grouped\")",
        'labels = ["Nam","Trung","Bac"]',
        's1 = Series("revenue", [5200,3100,2800])',
        'notes = TextContent("South led at 5,200M VND.", "default")',
      ].join("\n"),
    );
  });

  it("serializes a line chart with explicit variant and axis labels", () => {
    const lang = serializeOpenuiLang({
      title: "Revenue trend",
      spec: {
        chart: "LineChart",
        labels: ["2026-08", "2026-09"],
        series: [{ category: "revenue", values: [4815, 5200] }],
        variant: "natural",
        xLabel: "month",
        yLabel: "revenue",
      },
    });
    expect(lang).toContain('chart = LineChart(labels, [s1], "natural", "month", "revenue")');
    expect(lang).toContain('labels = ["2026-08","2026-09"]');
  });

  it("serializes a pie chart with plucked label/value arrays", () => {
    const lang = serializeOpenuiLang({
      title: "Share",
      spec: {
        chart: "PieChart",
        labels: ["A", "B"],
        values: [60, 40],
        variant: "donut",
      },
    });
    expect(lang).toContain('chart = PieChart(labels, values, "donut")');
    expect(lang).toContain("values = [60,40]");
  });

  it("serializes a scatter chart with dataset and point variables", () => {
    const lang = serializeOpenuiLang({
      title: "Price vs quantity",
      spec: {
        chart: "ScatterChart",
        datasets: [{ name: "orders", points: [{ x: 100, y: 50 }] }],
      },
    });
    expect(lang).toContain("chart = ScatterChart([d1])");
    expect(lang).toContain('d1 = ScatterSeries("orders", [p1_1])');
    expect(lang).toContain("p1_1 = Point(100, 50)");
  });

  it("serializes a table with column variables", () => {
    const lang = serializeOpenuiLang({
      title: "Detail",
      spec: {
        chart: "Table",
        columns: [
          { label: "region", data: ["Nam", "Bac"], type: "string" },
          { label: "revenue", data: [5200, 2800], type: "number" },
        ],
      },
    });
    expect(lang).toContain("chart = Table([c1, c2])");
    expect(lang).toContain('c1 = Col("region", ["Nam","Bac"], "string")');
    expect(lang).toContain('c2 = Col("revenue", [5200,2800], "number")');
  });

  it("emits title only for the None sentinel", () => {
    const lang = serializeOpenuiLang({ title: "Count", spec: { chart: "None" } });
    expect(lang).toBe('root = Card([title])\ntitle = TextContent("Count", "large-heavy")');
  });

  it("JSON-escapes hostile strings so Lang stays parseable", () => {
    const lang = serializeOpenuiLang({
      title: 'Say "hi"\nbye',
      spec: { chart: "None" },
    });
    expect(lang).toContain('TextContent("Say \\"hi\\"\\nbye"');
  });
});
