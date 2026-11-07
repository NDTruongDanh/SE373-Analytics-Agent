// UC-03 render_chart validator tests: shape, type match, data grounding.
import { describe, expect, it } from "vitest";
import {
  buildTableSpec,
  validateChart,
  validateChartGrounding,
  validateChartSpec,
} from "../src/validators/renderChart.js";
import type { SelectorBuffer } from "../src/validators/chartSelector.js";

const BUFFER: SelectorBuffer = {
  columns: ["region", "revenue"],
  rows: [
    { region: "Nam", revenue: 5200 },
    { region: "Trung", revenue: 3100 },
    { region: "Bac", revenue: 2800 },
  ],
};

const BAR = {
  chart: "BarChart",
  labels: ["Nam", "Trung", "Bac"],
  series: [{ category: "revenue", values: [5200, 3100, 2800] }],
  variant: "grouped",
};

describe("UC-03 render_chart validator", () => {
  it("accepts a grounded bar spec", () => {
    const out = validateChart("bar", BAR, BUFFER);
    expect(out.ok).toBe(true);
  });

  it("rejects chartType/spec mismatches", () => {
    const out = validateChartSpec("pie", BAR);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issue.code).toBe("chart_mismatch");
      expect(out.issue.field).toBe("chartSpec.chart");
    }
  });

  it("rejects ragged series and pie drift", () => {
    expect(
      validateChartSpec("line", {
        chart: "LineChart",
        labels: ["a", "b"],
        series: [{ category: "s", values: [1] }],
      }).ok,
    ).toBe(false);
    expect(
      validateChartSpec("pie", {
        chart: "PieChart",
        labels: ["A", "B"],
        values: [1],
      }).ok,
    ).toBe(false);
  });

  it("rejects unknown components without executing anything", () => {
    const out = validateChartSpec("bar", { mark: "bar", encoding: {} });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe("chart_shape");
  });

  it("rejects labels absent from the buffer", () => {
    const out = validateChart(
      "bar",
      { ...BAR, labels: ["Nam", "Trung", "Tay"] },
      BUFFER,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.issue.code).toBe("chart_grounding");
      expect(out.issue.field).toBe("labels");
    }
  });

  it("rejects numbers that match no cell", () => {
    const out = validateChart(
      "bar",
      { ...BAR, series: [{ category: "revenue", values: [5200, 3100, 9999] }] },
      BUFFER,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe("chart_grounding");
  });

  it("tolerates rounding within 1% but not a 2% fabrication", () => {
    const close = validateChart(
      "bar",
      { ...BAR, series: [{ category: "revenue", values: [5226, 3100, 2800] }] },
      BUFFER,
    );
    expect(close.ok).toBe(true); // 26/5200 = 0.5%
    const far = validateChart(
      "bar",
      { ...BAR, series: [{ category: "revenue", values: [5304, 3100, 2800] }] },
      BUFFER,
    );
    expect(far.ok).toBe(false); // 104/5200 = 2%
  });

  it("grounds Table strings and numbers cell by cell", () => {
    const table = {
      chart: "Table",
      columns: [
        { label: "region", data: ["Nam", "Bac"] },
        { label: "revenue", data: [5200, 2800] },
      ],
    };
    expect(validateChart("table", table, BUFFER).ok).toBe(true);
    const bad = {
      chart: "Table",
      columns: [
        { label: "region", data: ["Nam", "Tay"] },
        { label: "revenue", data: [5200, 2800] },
      ],
    };
    expect(validateChart("table", bad, BUFFER).ok).toBe(false);
  });

  it("grounds scatter points against numeric cells", () => {
    const buffer: SelectorBuffer = {
      columns: ["price", "quantity"],
      rows: [
        { price: 100, quantity: 50 },
        { price: 120, quantity: 40 },
      ],
    };
    const scatter = {
      chart: "ScatterChart",
      datasets: [{ name: "orders", points: [{ x: 100, y: 50 }, { x: 120, y: 40 }] }],
    };
    expect(validateChart("scatter", scatter, buffer).ok).toBe(true);
    const bad = {
      chart: "ScatterChart",
      datasets: [{ name: "orders", points: [{ x: 100, y: 999 }] }],
    };
    expect(validateChart("scatter", bad, buffer).ok).toBe(false);
  });

  it("accepts the None sentinel without a buffer", () => {
    expect(validateChart("none", { chart: "None" }, BUFFER).ok).toBe(true);
  });

  it("builds a Table fallback that always grounds", () => {
    const spec = buildTableSpec(BUFFER);
    expect(spec.chart).toBe("Table");
    const out = validateChartGrounding(spec, BUFFER);
    expect(out.ok).toBe(true);
  });

  it("builds None when the buffer has no columns", () => {
    expect(buildTableSpec({ columns: [], rows: [] }).chart).toBe("None");
  });
});
