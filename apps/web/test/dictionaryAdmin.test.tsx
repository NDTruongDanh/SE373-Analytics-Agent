// @vitest-environment jsdom
import type { SemanticCatalogResponse } from "@shared/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, DictionaryAdmin } from "@/app";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_CATALOG: SemanticCatalogResponse = {
  totalChunks: 6,
  countsByDocType: {
    table: 1,
    column: 1,
    metric: 1,
    join_rule: 1,
    example: 1,
    event: 1,
  },
  lastUpdatedAt: "2026-11-24T08:00:00.000Z",
  items: [
    {
      chunkId: "metric:net_revenue",
      docType: "metric",
      table: "order_items",
      tables: ["orders", "order_items"],
      metricName: "net_revenue",
      aliases: ["doanh thu thuần", "net sales"],
      sensitivity: "public",
      additive: true,
      updatedAt: "2026-11-24T07:30:00.000Z",
      summary: "Tổng doanh thu thuần của các đơn hàng đã giao thành công.",
      formula: "SUM(order_items.price_vnd) over orders with status = 'delivered'",
      sqlTemplate: "SELECT SUM(oi.price_vnd) FROM public.order_items oi",
      caveats: ["Không tính đơn đã hủy hoặc hoàn trả."],
    },
    {
      chunkId: "table:orders",
      docType: "table",
      table: "orders",
      tables: ["orders"],
      metricName: null,
      aliases: ["đơn hàng"],
      sensitivity: "public",
      updatedAt: "2026-11-24T07:15:00.000Z",
      summary: "Bảng sự kiện đơn hàng chính theo từng đơn.",
      primaryKey: "order_id",
      grain: "1 row per order",
      rowCountScale: "100k rows",
      caveats: [],
    },
    {
      chunkId: "column:customers.phone",
      docType: "column",
      table: "customers",
      tables: ["customers"],
      metricName: null,
      aliases: ["số điện thoại"],
      sensitivity: "restricted_pii",
      updatedAt: "2026-11-24T07:20:00.000Z",
      summary: "Số điện thoại liên hệ của khách hàng.",
      column: "customers.phone",
      dataType: "TEXT",
      caveats: ["restricted_pii: requires data:sensitive scope."],
    },
    {
      chunkId: "join_rule:orders_items_payments",
      docType: "join_rule",
      table: "orders",
      tables: ["orders", "order_items", "payments"],
      metricName: null,
      aliases: ["anti-fanout"],
      sensitivity: "public",
      updatedAt: "2026-11-24T07:25:00.000Z",
      summary: "Phải tổng hợp trước theo order_id trong CTE để chống nhân dòng.",
      caveats: [],
    },
    {
      chunkId: "example:net_revenue_q2",
      docType: "example",
      table: "orders",
      tables: ["orders", "order_items"],
      metricName: "net_revenue",
      aliases: ["Q2 revenue"],
      sensitivity: "public",
      updatedAt: "2026-11-24T07:45:00.000Z",
      summary: "Ví dụ doanh thu thuần theo khu vực quý 2.",
      question: "Doanh thu thuần theo vùng miền quý 2 là bao nhiêu?",
      sqlTemplate: "SELECT region_group, SUM(price_vnd) FROM orders ...",
      citedMetrics: ["metric:net_revenue"],
      caveats: [],
    },
    {
      chunkId: "event:2025_tet",
      docType: "event",
      table: "orders",
      tables: ["orders", "promotions"],
      metricName: null,
      aliases: ["Tết Nguyên Đán"],
      sensitivity: "internal",
      updatedAt: "2026-11-24T08:00:00.000Z",
      summary: "Lịch nghỉ vận chuyển dịp Tết Nguyên Đán.",
      startDate: "2025-01-25",
      endDate: "2025-02-04",
      affectedRegions: ["Bắc", "Trung", "Nam"],
      affectedChannels: ["shopee", "lazada"],
      caveats: [],
    },
  ],
};

function renderAdmin(persona: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <DictionaryAdmin persona={persona} />
    </QueryClientProvider>,
  );
}

function sseResponse(event: string, data: unknown): Response {
  const envelope = { event, runId: "run-nav-1", threadId: "chat:sales_south:t-1", data };
  return new Response(`event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("DictionaryAdmin (UC-02)", () => {
  it("renders summary counts, formulas, aliases, sensitivity flags, join rules, and filters by tab and search", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(SAMPLE_CATALOG), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    renderAdmin("sales_south");

    expect(await screen.findByText("Tổng chunks: 6")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-last-updated")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-item-metric:net_revenue")).toBeInTheDocument();
    expect(
      screen.getByText("SUM(order_items.price_vnd) over orders with status = 'delivered'"),
    ).toBeInTheDocument();
    expect(screen.getByText("doanh thu thuần")).toBeInTheDocument();
    expect(screen.getByText("Restricted PII")).toBeInTheDocument();
    expect(screen.getByTestId("catalog-item-join_rule:orders_items_payments")).toBeInTheDocument();

    // Filter by docType tab
    await user.click(screen.getByRole("tab", { name: /Quy tắc nối/i }));
    expect(screen.getByTestId("catalog-item-join_rule:orders_items_payments")).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-item-metric:net_revenue")).not.toBeInTheDocument();

    // Switch back to all and search by alias/column
    await user.click(screen.getByRole("tab", { name: /Tất cả/i }));
    const searchInput = screen.getByLabelText("Tìm kiếm từ điển dữ liệu");
    await user.type(searchInput, "số điện thoại");
    expect(screen.getByTestId("catalog-item-column:customers.phone")).toBeInTheDocument();
    expect(screen.queryByTestId("catalog-item-table:orders")).not.toBeInTheDocument();
  });

  it("triggers incremental re-index for data_admin, displays counts, and refreshes catalog counts", async () => {
    const user = userEvent.setup();
    let catalogFetches = 0;
    const updatedCatalog: SemanticCatalogResponse = {
      ...SAMPLE_CATALOG,
      totalChunks: 7,
      countsByDocType: { ...SAMPLE_CATALOG.countsByDocType, metric: 2 },
      lastUpdatedAt: "2026-11-24T09:00:00.000Z",
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/semantic/catalog")) {
        catalogFetches += 1;
        const payload = catalogFetches === 1 ? SAMPLE_CATALOG : updatedCatalog;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ added: 1, updated: 0, skipped: 6, deleted: 0 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    renderAdmin("data_admin");
    expect(await screen.findByText("Tổng chunks: 6")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Re-index Changed Chunks/i }));
    expect(await screen.findByText("Added: 1")).toBeInTheDocument();
    expect(screen.getByText("Skipped: 6")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("catalog-total-chunks")).toHaveTextContent("Tổng chunks: 7");
    });
    expect(catalogFetches).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a clear error message when POST /api/semantic/reindex returns 403 SCOPE_DENIED", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/semantic/catalog")) {
        return new Response(JSON.stringify(SAMPLE_CATALOG), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          code: "SCOPE_DENIED",
          message: "only data_admin may trigger semantic re-indexing",
          retryable: false,
          repairable: false,
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    });

    renderAdmin("data_admin");
    await screen.findByTestId("catalog-total-chunks");
    await user.click(screen.getByRole("button", { name: /Re-index Changed Chunks/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("SCOPE_DENIED");
    expect(alert.textContent).toContain("data_admin");
  });
});

describe("Workspace navigation & chat state preservation", () => {
  it("switches between Chat, Dictionary, Alerts, Audit Log, and Evals without losing active chat history or draft question", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/ask") {
        return sseResponse("completed", {
          status: "ok",
          answerText: "Tổng số đơn hàng là 42.",
        });
      }
      if (url.startsWith("/api/semantic/catalog")) {
        return new Response(JSON.stringify(SAMPLE_CATALOG), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });

    render(<App initialEntries={["/"]} />);

    const textarea = screen.getByLabelText("Câu hỏi");
    await user.type(textarea, "Doanh thu tháng này?");
    await user.click(screen.getByRole("button", { name: "Gửi câu hỏi" }));
    expect(await screen.findByText("Tổng số đơn hàng là 42.")).toBeInTheDocument();

    // Type an unsent draft question before navigating away
    await user.type(screen.getByLabelText("Câu hỏi"), "Nháp chưa gửi");

    await user.click(screen.getByRole("link", { name: /Từ điển dữ liệu/i }));
    expect(await screen.findByRole("heading", { name: /Từ điển dữ liệu/i })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Cảnh báo/i }));
    expect(
      screen.getByRole("heading", { level: 1, name: /Cảnh báo bất thường/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Nhật ký kiểm toán/i }));
    expect(screen.getByRole("heading", { name: /Nhật ký kiểm toán/i })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Đánh giá/i }));
    expect(screen.getByRole("heading", { name: /Trace & Đánh giá/i })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Trợ lý phân tích/i }));
    expect(screen.getByText("Doanh thu tháng này?")).toBeInTheDocument();
    expect(screen.getByText("Tổng số đơn hàng là 42.")).toBeInTheDocument();
    expect(screen.getByLabelText("Câu hỏi")).toHaveValue("Nháp chưa gửi");
  });
});
