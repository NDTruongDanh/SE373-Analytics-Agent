// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnomalyAlert } from "@shared/contracts";
import { AlertsView } from "../src/components/AlertsView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAMPLE_ALERTS: AnomalyAlert[] = [
  {
    subscriptionId: "sub-return-rate",
    metric: "metric:return_rate",
    currentValue: 0.185,
    expectedValue: 0.042,
    deviation: "z=+63.74, WoW=+340.5%",
    drilldownSegment: "regions.province = 'Đà Nẵng' AND categories.name_vi = 'Thực phẩm tươi sống'",
    evidenceSql: "SELECT regions.province, COUNT(*) AS total_orders FROM orders WHERE orders.purchase_date = '2026-09-14'",
    recipientId: "ops_lead",
    recipientRole: "operations",
    severity: "critical",
    direction: "spike",
    date: "2026-09-14",
    fingerprint: "fp-critical-a1",
    message: "Return rate spike in Da Nang",
  },
  {
    subscriptionId: "sub-review-score",
    metric: "metric:review_score_avg",
    currentValue: 3.45,
    expectedValue: 4.62,
    deviation: "z=-2.54, WoW=-25.3%",
    drilldownSegment: "categories.name_vi = 'Mỹ phẩm'",
    evidenceSql: "SELECT categories.name_vi, AVG(score) FROM reviews",
    recipientId: "customer_experience",
    recipientRole: "support_lead",
    severity: "warning",
    direction: "drop",
    date: "2026-09-25",
    fingerprint: "fp-warning-a5",
    message: "Review score dropped",
  },
];

describe("AlertsView (UC-10)", () => {
  it("renders anomaly cards with severity, metric, deviation, drilldownSegment, expandable evidenceSql, and dedup fingerprint", () => {
    render(<AlertsView alerts={SAMPLE_ALERTS} />);

    expect(screen.getByText("metric:return_rate")).toBeTruthy();
    expect(screen.getByText("metric:review_score_avg")).toBeTruthy();
    expect(screen.getByText("z=+63.74, WoW=+340.5%")).toBeTruthy();
    expect(
      screen.getByText("regions.province = 'Đà Nẵng' AND categories.name_vi = 'Thực phẩm tươi sống'"),
    ).toBeTruthy();
    expect(screen.getByText("fp-critical-a1")).toBeTruthy();
    expect(screen.getByText("18.50%")).toBeTruthy();
    expect(screen.getByText("4.20%")).toBeTruthy();

    // evidenceSql starts collapsed and expands on toggle click
    expect(screen.queryByText(SAMPLE_ALERTS[0]!.evidenceSql)).toBeNull();
    const toggleButtons = screen.getAllByRole("button", { name: /Xem SQL dẫn chứng/ });
    fireEvent.click(toggleButtons[0]!);
    expect(screen.getByText(SAMPLE_ALERTS[0]!.evidenceSql)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ẩn SQL dẫn chứng/ }));
    expect(screen.queryByText(SAMPLE_ALERTS[0]!.evidenceSql)).toBeNull();
  });

  it("filters anomaly cards by severity, recipient, and metric/segment search", () => {
    render(<AlertsView alerts={SAMPLE_ALERTS} />);

    fireEvent.change(screen.getByLabelText("Mức độ"), {
      target: { value: "warning" },
    });
    expect(screen.queryByText("metric:return_rate")).toBeNull();
    expect(screen.getByText("metric:review_score_avg")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Mức độ"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Người nhận"), {
      target: { value: "ops_lead" },
    });
    expect(screen.getByText("metric:return_rate")).toBeTruthy();
    expect(screen.queryByText("metric:review_score_avg")).toBeNull();

    fireEvent.change(screen.getByLabelText("Tìm chỉ số / phân đoạn"), {
      target: { value: "nonexistent" },
    });
    expect(screen.getByText("Không có cảnh báo nào khớp bộ lọc hiện tại.")).toBeTruthy();
  });

  it("renders untrusted SQL and drilldownSegment values as plain text (XSS safe)", () => {
    const xssAlert: AnomalyAlert = {
      ...SAMPLE_ALERTS[0]!,
      fingerprint: "fp-xss",
      drilldownSegment: "<img src=x onerror=alert(1)>",
      evidenceSql: "SELECT '<img src=x onerror=alert(2)>' AS payload",
    };

    const { container } = render(<AlertsView alerts={[xssAlert]} />);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Xem SQL dẫn chứng/ }));
    expect(screen.getByText("SELECT '<img src=x onerror=alert(2)>' AS payload")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("triggers manual run via callback and shows 24h deduplication counts", async () => {
    const onTriggerManualRun = vi.fn().mockResolvedValueOnce({
      date: "2026-09-14",
      anomaliesDetected: 1,
      alertsSent: 0,
      alertsQueued: 0,
      alertsSkippedDuplicate: 1,
    });

    render(
      <AlertsView
        alerts={SAMPLE_ALERTS}
        defaultTargetDate="2026-09-14"
        onTriggerManualRun={onTriggerManualRun}
      />,
    );

    fireEvent.click(screen.getByLabelText(/Gửi ngay hàng đợi digest/));
    fireEvent.click(screen.getByRole("button", { name: "Chạy kiểm tra bất thường" }));

    await waitFor(() => {
      expect(onTriggerManualRun).toHaveBeenCalledWith({
        targetDate: "2026-09-14",
        flushDigest: true,
      });
    });
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Bỏ qua trùng lặp 24h: 1")).toBeTruthy();
  });

  it("calls /api/alerts/run on manual trigger and handles API errors safely", async () => {
    const newAlert: AnomalyAlert = {
      metric: "metric:order_count",
      currentValue: 248,
      expectedValue: 120,
      deviation: "z=+21.33, WoW=+101.6%",
      drilldownSegment: "sellers.province = 'Hà Nội'",
      evidenceSql: "SELECT sellers.province, COUNT(*) FROM orders",
      recipientId: "sales_director",
      recipientRole: "sales_lead",
      severity: "critical",
      direction: "spike",
      date: "2026-09-16",
      fingerprint: "fp-new-a4",
    };

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            date: "2026-09-16",
            anomaliesDetected: 1,
            alertsSent: 1,
            alertsQueued: 0,
            alertsSkippedDuplicate: 0,
            alerts: [newAlert],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

    render(<AlertsView alerts={SAMPLE_ALERTS} defaultTargetDate="2026-09-16" />);

    fireEvent.click(screen.getByRole("button", { name: "Chạy kiểm tra bất thường" }));
    expect(await screen.findByText("metric:order_count")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/alerts/run",
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Chạy kiểm tra bất thường" }));
    const alertBox = await screen.findByRole("alert");
    expect(alertBox.textContent).toContain("503");
  });
});
