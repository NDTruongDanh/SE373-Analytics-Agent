// UC-03 selector tests: deterministic shape rules + boundary cases.
// These mirror the evals/uc03/chart-labels.jsonl fixtures (same oracle).
import { describe, expect, it } from "vitest";
import {
  analyzeColumns,
  isNumericCell,
  selectChartType,
} from "../src/validators/chartSelector.js";

const MONTHS = [
  "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
  "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
];

describe("UC-03 chart selector", () => {
  it("picks line for a 12-month time series", () => {
    const out = selectChartType(
      {
        columns: ["month", "revenue"],
        rows: MONTHS.map((month, i) => ({ month, revenue: 4000 + i * 100 })),
      },
      "ok",
    );
    expect(out.chartType).toBe("line");
  });

  it("picks bar for a 3-region comparison", () => {
    const out = selectChartType(
      {
        columns: ["region", "revenue"],
        rows: [
          { region: "Nam", revenue: 5200 },
          { region: "Trung", revenue: 3100 },
          { region: "Bac", revenue: 2800 },
        ],
      },
      "ok",
    );
    expect(out.chartType).toBe("bar");
  });

  it("picks pie for a <= 6-group share breakdown", () => {
    const out = selectChartType(
      {
        columns: ["category", "share"],
        rows: [
          { category: "Điện tử", share: 30 },
          { category: "Gia dụng", share: 25 },
          { category: "Thời trang", share: 20 },
          { category: "Mỹ phẩm", share: 12 },
          { category: "Thực phẩm", share: 8 },
          { category: "Khác", share: 5 },
        ],
      },
      "ok",
    );
    expect(out.chartType).toBe("pie");
  });

  it("picks bar — not pie — for 7 groups", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      category: `cat-${i}`,
      share: 10,
    }));
    const out = selectChartType({ columns: ["category", "share"], rows }, "ok");
    expect(out.chartType).toBe("bar");
  });

  it("picks scatter for two numeric variables", () => {
    const out = selectChartType(
      {
        columns: ["price", "quantity"],
        rows: Array.from({ length: 8 }, (_, i) => ({
          price: 100 + i * 10,
          quantity: 50 - i * 2,
        })),
      },
      "ok",
    );
    expect(out.chartType).toBe("scatter");
  });

  it("picks table for mixed multi-metric detail", () => {
    const out = selectChartType(
      {
        columns: ["region", "revenue", "orders", "top_product"],
        rows: [
          { region: "Nam", revenue: 5200, orders: 100, top_product: "Nồi cơm" },
          { region: "Bac", revenue: 2800, orders: 60, top_product: "Áo thun" },
        ],
      },
      "ok",
    );
    expect(out.chartType).toBe("table");
  });

  it("picks none for a single scalar", () => {
    const out = selectChartType({ columns: ["n"], rows: [{ n: 42 }] }, "ok");
    expect(out.chartType).toBe("none");
  });

  it("picks table for a single multi-metric row", () => {
    const out = selectChartType(
      { columns: ["revenue", "orders"], rows: [{ revenue: 5200, orders: 100 }] },
      "ok",
    );
    expect(out.chartType).toBe("table");
  });

  it("picks none for no_data and for empty rows", () => {
    expect(selectChartType({ columns: ["a"], rows: [{ a: 1 }] }, "no_data").chartType).toBe("none");
    expect(selectChartType({ columns: ["a"], rows: [] }, "ok").chartType).toBe("none");
  });

  it("prefers line when a time column joins a categorical split", () => {
    const out = selectChartType(
      {
        columns: ["month", "region", "revenue"],
        rows: MONTHS.slice(0, 3).flatMap((month) => [
          { month, region: "Nam", revenue: 100 },
          { month, region: "Bac", revenue: 80 },
        ]),
      },
      "ok",
    );
    expect(out.chartType).toBe("line");
  });

  it("picks table when pie values go negative", () => {
    const out = selectChartType(
      {
        columns: ["category", "share"],
        rows: [
          { category: "A", share: 120 },
          { category: "B", share: -20 },
        ],
      },
      "ok",
    );
    expect(out.chartType).toBe("table");
  });

  it("classifies columns by role", () => {
    const roles = analyzeColumns({
      columns: ["month", "revenue", "region"],
      rows: [
        { month: "2026-01", revenue: 100, region: "Nam" },
        { month: "2026-02", revenue: 120, region: "Bac" },
      ],
    });
    expect(roles.timeColumns).toEqual(["month"]);
    expect(roles.numericColumns).toEqual(["revenue"]);
    expect(roles.categoricalColumns).toEqual(["region"]);
  });

  it("treats numeric strings as numeric cells", () => {
    expect(isNumericCell("5,200")).toBe(true);
    expect(isNumericCell(5200)).toBe(true);
    expect(isNumericCell("Nam")).toBe(false);
    expect(isNumericCell("")).toBe(false);
    expect(isNumericCell(null)).toBe(false);
  });
});
