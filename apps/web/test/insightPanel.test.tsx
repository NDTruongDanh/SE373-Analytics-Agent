// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { InsightReport } from "@shared/contracts";
import { InsightChart } from "../src/charts.js";
import { InsightPanel } from "../src/components/InsightPanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BAR_REPORT: InsightReport = {
  chartType: "bar",
  chartSpec: {
    chart: "BarChart",
    labels: ["Nam", "Trung", "Bac"],
    series: [{ category: "revenue", values: [5200, 3100, 2800] }],
    variant: "grouped",
  },
  chartReason: "Three regions compared, so a bar chart fits.",
  insights: [
    {
      claim: "Miền Nam dẫn đầu với 5,200M VND.",
      derivation: "cell",
      evidence: [{ column: "revenue", rowKey: "Nam", value: 5200 }],
    },
    {
      claim: "Miền Bắc đạt 2,800M VND.",
      evidence: [{ column: "revenue", rowKey: "Bac", value: 2800 }],
    },
  ],
  caveats: [],
};

const BAR_LANG = [
  "root = Card([title, chart, notes])",
  'title = TextContent("Revenue by region", "large-heavy")',
  'chart = BarChart(labels, [s1], "grouped")',
  'labels = ["Nam","Trung","Bac"]',
  's1 = Series("revenue", [5200,3100,2800])',
  'notes = TextContent("Miền Nam dẫn đầu với 5,200M VND.", "default")',
].join("\n");

const LINE_REPORT: InsightReport = {
  chartType: "line",
  chartSpec: {
    chart: "LineChart",
    labels: ["2026-08", "2026-09"],
    series: [{ category: "revenue", values: [4815, 5200] }],
    variant: "natural",
    xLabel: "month",
    yLabel: "revenue",
  },
  chartReason: "Monthly time series uses a line chart.",
  insights: [
    {
      claim: "Tháng 9 đạt 5,200M VND.",
      evidence: [{ column: "revenue", rowKey: "2026-09", value: 5200 }],
    },
  ],
  caveats: [],
};

const LINE_LANG = [
  "root = Card([title, chart])",
  'title = TextContent("Revenue trend", "large-heavy")',
  'chart = LineChart(labels, [s1], "natural", "month", "revenue")',
  'labels = ["2026-08","2026-09"]',
  's1 = Series("revenue", [4815,5200])',
].join("\n");

const PIE_REPORT: InsightReport = {
  chartType: "pie",
  chartSpec: {
    chart: "PieChart",
    labels: ["Nam", "Bac"],
    values: [65, 35],
    variant: "donut",
  },
  chartReason: "Two-region share breakdown uses a pie chart.",
  insights: [],
  caveats: [],
};

const PIE_LANG = [
  "root = Card([title, chart])",
  'title = TextContent("Share", "large-heavy")',
  'chart = PieChart(labels, values, "donut")',
  'labels = ["Nam","Bac"]',
  "values = [65,35]",
].join("\n");

const SCATTER_REPORT: InsightReport = {
  chartType: "scatter",
  chartSpec: {
    chart: "ScatterChart",
    datasets: [{ name: "orders", points: [{ x: 100, y: 50 }, { x: 200, y: 80 }] }],
    xLabel: "price",
    yLabel: "qty",
  },
  chartReason: "Two numeric variables use a scatter plot.",
  insights: [],
  caveats: [],
};

const SCATTER_LANG = [
  "root = Card([title, chart])",
  'title = TextContent("Price vs qty", "large-heavy")',
  'chart = ScatterChart([d1], "price", "qty")',
  'd1 = ScatterSeries("orders", [p1_1, p1_2])',
  "p1_1 = Point(100, 50)",
  "p1_2 = Point(200, 80)",
].join("\n");

const TABLE_REPORT: InsightReport = {
  chartType: "table",
  chartSpec: {
    chart: "Table",
    columns: [
      { label: "region", data: ["Nam", "Bac"], type: "string" },
      { label: "revenue", data: [5200, 2800], type: "number" },
    ],
  },
  chartReason: "Detailed breakdown rendered as a table.",
  insights: [],
  caveats: [],
};

const TABLE_LANG = [
  "root = Card([title, chart])",
  'title = TextContent("Detail table", "large-heavy")',
  "chart = Table([c1, c2])",
  'c1 = Col("region", ["Nam","Bac"], "string")',
  'c2 = Col("revenue", [5200,2800], "number")',
].join("\n");

describe("InsightChart (OpenUI Lang <Renderer /> integration)", () => {
  it.each([
    ["LineChart", LINE_REPORT, LINE_LANG, "Revenue trend"],
    ["BarChart", BAR_REPORT, BAR_LANG, "Revenue by region"],
    ["PieChart", PIE_REPORT, PIE_LANG, "Share"],
    ["ScatterChart", SCATTER_REPORT, SCATTER_LANG, "Price vs qty"],
    ["Table", TABLE_REPORT, TABLE_LANG, "Detail table"],
  ])("renders %s through OpenUI <Renderer />", async (label, report, lang, expectedTitle) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <InsightChart
        title={expectedTitle}
        report={report}
        lang={lang}
        streaming={false}
      />,
    );
    const chartContainer = screen.getByTestId("insight-chart");
    expect(chartContainer.getAttribute("data-chart-type")).toBe(report.chartType);
    expect(chartContainer.getAttribute("data-streaming")).toBe("false");
    expect(await screen.findByText(expectedTitle)).toBeInTheDocument();
    if (label === "Table") {
      expect(chartContainer.querySelector("table")).not.toBeNull();
      expect(screen.getByText("5200")).toBeInTheDocument();
    } else {
      // Every chart container mounts more than just the title child inside the Card.
      const card = chartContainer.firstElementChild;
      expect(card).not.toBeNull();
      expect(chartContainer.innerHTML).toContain("openui");
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("passes streaming state during viz SSE updates", async () => {
    render(
      <InsightChart
        title="Streaming trend"
        report={LINE_REPORT}
        lang={LINE_LANG}
        streaming={true}
      />,
    );
    const chartContainer = screen.getByTestId("insight-chart");
    expect(chartContainer.getAttribute("data-streaming")).toBe("true");
    expect(await screen.findByText("Revenue trend")).toBeInTheDocument();
  });

  it("degrades cleanly to fallbackText for none, empty, and untrusted Lang", () => {
    const noneReport: InsightReport = {
      chartType: "none",
      chartSpec: { chart: "None" },
      chartReason: "Single scalar result needs no chart.",
      insights: [
        {
          claim: "Tổng đơn hàng là 1,240.",
          evidence: [{ column: "total_orders", rowKey: "0", value: 1240 }],
        },
      ],
      caveats: ["Chỉ có 1 chỉ số tổng hợp."],
    };

    const { rerender } = render(
      <InsightChart
        title="Tổng đơn hàng"
        report={noneReport}
        lang='root = Card([title])\ntitle = TextContent("Tổng đơn hàng", "large-heavy")'
      />,
    );
    expect(screen.queryByTestId("insight-chart")).toBeNull();
    const fallback = screen.getByTestId("insight-chart-fallback");
    expect(fallback.textContent).toContain("Tổng đơn hàng");
    expect(fallback.textContent).toContain("Tổng đơn hàng là 1,240.");
    expect(fallback.textContent).toContain("Chỉ có 1 chỉ số tổng hợp.");

    rerender(
      <InsightChart
        title="Hostile Stack"
        report={BAR_REPORT}
        lang={'root = Stack([evil])\nevil = Query("DROP TABLE orders")'}
      />,
    );
    expect(screen.queryByTestId("insight-chart")).toBeNull();
    expect(screen.getByTestId("insight-chart-fallback").textContent).toContain("Hostile Stack");

    rerender(
      <InsightChart
        title="Hostile Card Query"
        report={BAR_REPORT}
        lang={'root = Card([evil])\nevil = Query("DROP TABLE orders")'}
      />,
    );
    expect(screen.queryByTestId("insight-chart")).toBeNull();
    expect(screen.getByTestId("insight-chart-fallback").textContent).toContain("Hostile Card Query");

    rerender(<InsightChart title="Empty Lang" report={BAR_REPORT} lang="" />);
    expect(screen.queryByTestId("insight-chart")).toBeNull();
    expect(screen.getByTestId("insight-chart-fallback").textContent).toContain("Empty Lang");
  });
});

describe("InsightPanel (verified claims, evidence badges & caveats)", () => {
  const preview = [
    { region: "Nam", revenue: 5200 },
    { region: "Trung", revenue: 3100 },
    { region: "Bac", revenue: 2800 },
  ];

  it("displays chartReason, verified claims, and highlights matching preview row/cell on evidence badge click", () => {
    render(<InsightPanel report={BAR_REPORT} resultPreview={preview} />);

    expect(screen.getByTestId("insight-chart-reason").textContent).toContain(
      "Three regions compared",
    );
    expect(screen.getByText("Miền Nam dẫn đầu với 5,200M VND.")).toBeInTheDocument();
    expect(screen.getByText("Miền Bắc đạt 2,800M VND.")).toBeInTheDocument();

    const badges = screen.getAllByTestId("evidence-badge");
    expect(badges).toHaveLength(2);

    fireEvent.click(badges[0]!);
    expect(badges[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("active-evidence-status").textContent).toContain("revenue");
    expect(screen.getByTestId("active-evidence-status").textContent).toContain("Nam");

    const table = screen.getByTestId("insight-preview-table");
    const highlightedRows = table.querySelectorAll('tr[data-highlighted-row="true"]');
    expect(highlightedRows).toHaveLength(1);
    expect(highlightedRows[0]).toHaveTextContent("Nam");

    const highlightedCells = table.querySelectorAll('td[data-highlighted-cell="true"]');
    expect(highlightedCells).toHaveLength(1);
    expect(highlightedCells[0]).toHaveTextContent("5200");

    // Clicking the same badge again clears the highlight.
    fireEvent.click(badges[0]!);
    expect(badges[0]).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("active-evidence-status")).toBeNull();
    expect(table.querySelectorAll('tr[data-highlighted-row="true"]')).toHaveLength(0);
  });

  it("renders prominent caveats for partial-period data, truncation, and stripped/downgraded narratives even when insights are empty", () => {
    const downgradedReport: InsightReport = {
      chartType: "bar",
      chartSpec: BAR_REPORT.chartSpec,
      chartReason: "Three regions compared.",
      insights: [],
      caveats: [
        "Tháng 10 chỉ có dữ liệu 6 ngày đầu tháng.",
        "1 nhận định đã bị loại vì không khớp dữ liệu.",
        "Toàn bộ nhận định đã bị ẩn để tránh báo cáo một chiều sau khi loại nhận định tiêu cực hoặc cảnh báo duy nhất.",
      ],
    };

    render(
      <InsightPanel
        report={downgradedReport}
        resultPreview={preview}
        truncated={true}
      />,
    );

    expect(screen.queryByTestId("insight-claims")).toBeNull();
    const caveatsBox = screen.getByTestId("insight-caveats");
    expect(within(caveatsBox).getByText(/6 ngày đầu tháng/)).toBeInTheDocument();
    expect(within(caveatsBox).getByText(/1 nhận định đã bị loại/)).toBeInTheDocument();
    expect(within(caveatsBox).getByText(/Toàn bộ nhận định đã bị ẩn/)).toBeInTheDocument();
    expect(within(caveatsBox).getByText(/truncated/i)).toBeInTheDocument();
  });
});
