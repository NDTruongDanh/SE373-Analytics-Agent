// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AnalysisPlan, PlanStep, RootCauseAnswer } from "@shared/contracts";
import { App } from "../src/app.js";
import { PlanReviewPanel } from "../src/components/PlanReviewPanel.js";
import { RootCauseView } from "../src/components/RootCauseView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function sse(event: string, data: unknown): Response {
  const envelope = { event, runId: "run-uc05", threadId: "chat:sales_south:thread-uc05", data };
  return new Response(`event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function makeSamplePlan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
  const steps: PlanStep[] = [
    {
      stepId: "step_region_north",
      axis: "dimension",
      dimensionOrFactor: "region",
      dimensionValue: "Miền Bắc",
      dimensionPath: ["Miền Bắc"],
      parentId: null,
      depth: 0,
      status: "todo",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
      hypothesis: "Phân rã biến động doanh thu tại khu vực Miền Bắc",
    },
    {
      stepId: "step_region_central",
      axis: "dimension",
      dimensionOrFactor: "region",
      dimensionValue: "Miền Trung",
      dimensionPath: ["Miền Trung"],
      parentId: null,
      depth: 0,
      status: "todo",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
      hypothesis: "Phân rã biến động doanh thu tại khu vực Miền Trung",
    },
    {
      stepId: "step_factor_aov",
      axis: "formula",
      dimensionOrFactor: "aov",
      dimensionValue: null,
      dimensionPath: ["formula", "aov"],
      parentId: null,
      depth: 0,
      status: "todo",
      delta: 0,
      contributionPct: 0,
      sql: null,
      retryCount: 0,
      hypothesis: "Phân rã tác động theo công thức Orders × AOV",
    },
  ];
  return {
    question: "Vì sao doanh thu thuần tháng 9/2026 giảm so với tháng 8/2026?",
    metricName: "net_revenue",
    metricType: "additive",
    direction: "decrease",
    formulaComponents: {
      numerator: "net_revenue",
      denominator: "delivered_orders",
      formula: "Orders × AOV",
    },
    currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
    baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
    baselineVal: 2_500_000_000,
    currentVal: 2_040_000_000,
    absDelta: -460_000_000,
    pctDelta: -18.4,
    isValidBaseline: true,
    steps,
    totalQueriesCount: 2,
    maxQueriesLimit: 20,
    maxDepthLimit: 4,
    drilldownThreshold: 30,
    unexploredBranches: [],
    residualOtherAbs: 0,
    ...overrides,
  };
}

function makeSampleRootCause(overrides: Partial<RootCauseAnswer> = {}): RootCauseAnswer {
  return {
    question: "Vì sao doanh thu thuần tháng 9/2026 giảm so với tháng 8/2026?",
    metricName: "net_revenue",
    metricType: "additive",
    currentPeriod: { start: "2026-09-01", end: "2026-09-30" },
    baselinePeriod: { start: "2026-08-01", end: "2026-08-31" },
    baselineVal: 2_500_000_000,
    currentVal: 2_040_000_000,
    absDelta: -460_000_000,
    pctDelta: -18.4,
    mathVerified: true,
    mathDiffRatio: 0.015,
    primaryCauses: [
      {
        stepId: "step_cat_gia_dung",
        axis: "dimension",
        dimensionOrFactor: "category",
        dimensionValue: "Đồ gia dụng",
        dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
        delta: -395_000_000,
        contributionPct: 85.87,
        sql: "SELECT COALESCE(SUM(i.price_vnd), 0) AS val FROM public.order_items i JOIN public.orders o USING (order_id) WHERE o.purchase_date >= '2026-09-01'",
        summaryVi: "Tổ hợp [Miền Trung > Shopee > Đồ gia dụng]: giảm 395 triệu VNĐ (85.9% tổng biến động).",
      },
      {
        stepId: "step_region_south",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Nam",
        dimensionPath: ["Miền Nam"],
        delta: -60_000_000,
        contributionPct: 13.04,
        sql: "SELECT COALESCE(SUM(i.price_vnd), 0) AS val FROM public.orders o WHERE region = 'Nam'",
        summaryVi: "Tổ hợp [Miền Nam]: giảm 60 triệu VNĐ (13.0% tổng biến động).",
      },
    ],
    residualOtherAbs: 5_000_000,
    unexploredBranches: [
      {
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Bắc",
        parentId: null,
        reason: "PRUNED_BELOW_THRESHOLD",
      },
    ],
    totalQueriesCount: 10,
    finalReportMarkdown: "## 1. Hiện tượng & Mức biến động\nDoanh thu giảm 18.4% (-460 triệu VNĐ).",
    ...overrides,
  };
}

describe("PlanReviewPanel (UC-05 HITL plan review & editor)", () => {
  it("renders confirmed baseline delta, asOf snapshot, two-axis hierarchy, and approves as-is with checkpointId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sse("completed", { status: "ok", answerText: "Xong" }));

    render(
      <PlanReviewPanel
        plan={makeSamplePlan()}
        runId="run-uc05"
        threadId="chat:sales_south:thread-uc05"
        checkpointId="ckpt-901"
        asOf="2026-10-01T07:00:00Z"
      />,
    );

    const baseline = screen.getByTestId("plan-review-baseline");
    expect(within(baseline).getByText("2.50 tỷ VNĐ")).toBeInTheDocument();
    expect(within(baseline).getByText("2.04 tỷ VNĐ")).toBeInTheDocument();
    expect(within(baseline).getByText(/-460 triệu VNĐ \(-18\.4%\)/)).toBeInTheDocument();
    expect(screen.getByTestId("plan-review-asof").textContent).toContain("2026-10-01T07:00:00Z");
    expect(screen.getByTestId("plan-review-checkpoint").textContent).toContain("ckpt-901");
    expect(screen.getByText(/Region → Channel → Category → Product/)).toBeInTheDocument();
    expect(screen.getAllByText(/Orders × AOV/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("plan-approve-btn"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs/run-uc05/resume");
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(sentBody.checkpointId).toBe("ckpt-901");
    expect(sentBody.value.action).toBe("approve");
    expect(sentBody.value.steps).toHaveLength(3);
  });

  it("supports toggling/skipping steps, reordering dimensions, removing and adding custom dimensions before submitting", async () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    render(
      <PlanReviewPanel
        plan={makeSamplePlan()}
        runId="run-uc05"
        checkpointId="ckpt-edit"
        onResume={onResume}
      />,
    );

    // Toggle/skip step_region_north
    fireEvent.click(screen.getByTestId("plan-step-toggle-step_region_north"));
    expect(screen.getByTestId("plan-step-row-step_region_north").getAttribute("data-step-status")).toBe("skipped");

    // Move step_region_central up to position 0
    fireEvent.click(screen.getByTestId("plan-step-up-step_region_central"));
    const rowsAfterReorder = within(screen.getByTestId("plan-steps-list")).getAllByRole("listitem");
    expect(rowsAfterReorder[0]?.getAttribute("data-testid")).toBe("plan-step-row-step_region_central");

    // Remove step_factor_aov
    fireEvent.click(screen.getByTestId("plan-step-remove-step_factor_aov"));
    expect(screen.queryByTestId("plan-step-row-step_factor_aov")).toBeNull();

    // Add a new custom dimension via the form
    fireEvent.change(screen.getByLabelText("Chiều / Nhân tử"), {
      target: { value: "payment_type" },
    });
    fireEvent.change(screen.getByLabelText("Giá trị phân khúc (tuỳ chọn)"), {
      target: { value: "COD" },
    });
    fireEvent.click(screen.getByTestId("plan-add-step-btn"));
    expect(screen.getByText("payment_type: COD")).toBeInTheDocument();

    // Submit modified plan
    fireEvent.click(screen.getByTestId("plan-approve-btn"));

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    const submission = onResume.mock.calls[0]?.[0];
    expect(submission.action).toBe("modify");
    expect(submission.checkpointId).toBe("ckpt-edit");
    expect(submission.steps.map((s: PlanStep) => s.dimensionOrFactor)).toEqual([
      "region",
      "region",
      "payment_type",
    ]);
    expect(submission.steps[1]?.status).toBe("skipped");
    expect(submission.value.updated_plan.steps).toHaveLength(3);
  });

  it("handles 409 Conflict / stale-checkpoint responses cleanly without losing edited plan state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: "CONFLICT", message: "checkpointId ckpt-old is stale" }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    render(
      <PlanReviewPanel
        plan={makeSamplePlan()}
        runId="run-uc05"
        checkpointId="ckpt-old"
      />,
    );

    fireEvent.click(screen.getByTestId("plan-step-toggle-step_region_north"));
    fireEvent.click(screen.getByTestId("plan-approve-btn"));

    const conflictAlert = await screen.findByTestId("plan-review-conflict");
    expect(conflictAlert).toHaveAttribute("role", "alert");
    expect(conflictAlert.textContent).toContain("409");
    expect(conflictAlert.textContent).toContain("ckpt-old is stale");
    // Plan steps remain intact after 409 so analyst does not lose edits.
    expect(screen.getByTestId("plan-step-row-step_region_north").getAttribute("data-step-status")).toBe("skipped");
  });
});

describe("RootCauseView (UC-05 attribution, OpenUI chart, false_premise & SQL drawers)", () => {
  it("renders completed RootCauseAnswer with OpenUI BarChart/Table toggle, Contribution% bars, step statuses, and evidence SQL drawers", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = makeSampleRootCause();
    const steps: PlanStep[] = [
      {
        stepId: "step_cat_gia_dung",
        axis: "dimension",
        dimensionOrFactor: "category",
        dimensionValue: "Đồ gia dụng",
        dimensionPath: ["Miền Trung", "Shopee", "Đồ gia dụng"],
        parentId: "step_channel_shopee",
        depth: 2,
        status: "done",
        delta: -395_000_000,
        contributionPct: 85.87,
        sql: answer.primaryCauses[0]!.sql,
        retryCount: 0,
      },
      {
        stepId: "step_region_north",
        axis: "dimension",
        dimensionOrFactor: "region",
        dimensionValue: "Miền Bắc",
        dimensionPath: ["Miền Bắc"],
        parentId: null,
        depth: 0,
        status: "skipped",
        delta: -5_000_000,
        contributionPct: 1.09,
        sql: "SELECT 1",
        retryCount: 0,
        hypothesis: "Dưới ngưỡng 30%",
      },
      {
        stepId: "step_channel_lazada",
        axis: "dimension",
        dimensionOrFactor: "channel",
        dimensionValue: "Lazada",
        dimensionPath: ["Miền Trung", "Lazada"],
        parentId: "step_region_central",
        depth: 1,
        status: "failed",
        delta: 0,
        contributionPct: 0,
        sql: "SELECT broken_col FROM orders",
        errorMessage: "Timeout after 30s",
        retryCount: 2,
      },
    ];

    render(<RootCauseView answer={answer} steps={steps} />);

    // OpenUI BarChart renders via <InsightChart />
    const chartEl = await screen.findByTestId("insight-chart");
    expect(chartEl.getAttribute("data-chart-type")).toBe("bar");
    expect(screen.getByTestId("rca-math-badge").textContent).toContain("Đạt");

    // Toggle to OpenUI Table mode
    fireEvent.click(screen.getByTestId("rca-chart-mode-table"));
    await waitFor(() =>
      expect(screen.getByTestId("insight-chart").getAttribute("data-chart-type")).toBe("table"),
    );

    // Contribution% bars
    const bars = screen.getAllByTestId("rca-contribution-bar");
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(bars[0]).toHaveStyle({ width: "85.87%" });

    // Step statuses: done, skipped, failed
    expect(screen.getByTestId("rca-step-status-step_cat_gia_dung").textContent).toContain("done");
    expect(screen.getByTestId("rca-step-status-step_region_north").textContent).toContain("skipped");
    expect(screen.getByTestId("rca-step-status-step_channel_lazada").textContent).toContain("failed");
    expect(screen.getByText(/Timeout after 30s/)).toBeInTheDocument();

    // Unexplored branches
    expect(screen.getByTestId("rca-unexplored-branches").textContent).toContain("PRUNED_BELOW_THRESHOLD");

    // Per-step SQL drawer toggles open and closed
    expect(screen.queryByTestId("rca-sql-drawer-step_cat_gia_dung")).toBeNull();
    fireEvent.click(screen.getByTestId("rca-sql-toggle-step_cat_gia_dung"));
    const drawer = screen.getByTestId("rca-sql-drawer-step_cat_gia_dung");
    expect(drawer.textContent).toContain("SELECT COALESCE(SUM(i.price_vnd), 0)");
    fireEvent.click(screen.getByTestId("rca-sql-toggle-step_cat_gia_dung"));
    expect(screen.queryByTestId("rca-sql-drawer-step_cat_gia_dung")).toBeNull();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("renders rate + mix effects, LMDI-I factors, and offsetting-segment warnings", () => {
    const answer = makeSampleRootCause({
      metricName: "aov",
      metricType: "ratio",
      absDelta: -15_000,
      pctDelta: -4.2,
      primaryCauses: [
        {
          stepId: "step_south",
          axis: "dimension",
          dimensionOrFactor: "region",
          dimensionValue: "Miền Nam",
          dimensionPath: ["Miền Nam", "TikTok Shop"],
          delta: -45_000,
          contributionPct: 300,
          sql: "SELECT 1",
        },
        {
          stepId: "step_north",
          axis: "dimension",
          dimensionOrFactor: "region",
          dimensionValue: "Miền Bắc",
          dimensionPath: ["Miền Bắc", "Website"],
          delta: 30_000,
          contributionPct: -200,
          sql: "SELECT 2",
        },
      ],
    });

    render(
      <RootCauseView
        answer={answer}
        decompositionFactors={[
          {
            id: "f_rate",
            label: "Hiệu ứng tỷ suất nội tại (Rate Effect)",
            effectType: "rate",
            delta: -25_000,
            contributionPct: 166.7,
          },
          {
            id: "f_mix",
            label: "Hiệu ứng cơ cấu kênh (Mix Effect)",
            effectType: "mix",
            delta: 10_000,
            contributionPct: -66.7,
          },
          {
            id: "f_lmdi_orders",
            label: "Orders (Số lượng đơn)",
            effectType: "lmdi",
            delta: 12_000,
            contributionPct: -80,
          },
        ]}
      />,
    );

    expect(screen.getByTestId("rca-offsetting-warning")).toBeInTheDocument();
    expect(screen.getByTestId("rca-rate-mix-section").textContent).toContain("Rate Effect");
    expect(screen.getByTestId("rca-rate-mix-section").textContent).toContain("Mix Effect");
    expect(screen.getByTestId("rca-lmdi-section").textContent).toContain("LMDI-I");
  });

  it("renders false_premise callout when actual delta contradicts the user's premise", () => {
    render(
      <RootCauseView
        status="false_premise"
        falsePremise={true}
        metricName="net_revenue"
        baselineVal={2_000_000_000}
        currentVal={2_300_000_000}
        absDelta={300_000_000}
        pctDelta={15.0}
        message="Tiền đề không chính xác: net_revenue thực tế TĂNG 15.0% trong kỳ phân tích."
        sql="SELECT SUM(price_vnd) AS val FROM orders"
      />,
    );

    const callout = screen.getByTestId("rca-false-premise-callout");
    expect(callout).toHaveAttribute("role", "alert");
    expect(callout.textContent).toContain("TĂNG 15.0%");
    expect(screen.getByText("+300 triệu VNĐ (+15.0%)")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rca-sql-toggle-baseline"));
    expect(screen.getByTestId("rca-sql-drawer-baseline").textContent).toContain("SELECT SUM(price_vnd)");
  });
});

describe("App end-to-end UC-05 HITL flow", () => {
  it("pauses at review_analysis_plan, edits and submits plan with checkpointId, handles 409 then completes with RootCauseView", async () => {
    const plan = makeSamplePlan();
    const rcaAnswer = makeSampleRootCause();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        sse("interrupt_waiting", {
          action: "review_analysis_plan",
          currentPlan: plan,
          asOf: "2026-10-01T07:00:00Z",
          checkpointId: "ckpt-e2e-1",
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "CONFLICT", message: "try again" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        sse("completed", {
          status: "ok",
          answerText: "Đã hoàn tất phân tích nguyên nhân gốc rễ.",
          rootCauseAnswer: rcaAnswer,
          analysisPlan: {
            ...plan,
            steps: [
              { ...plan.steps[0]!, status: "skipped" },
              {
                ...plan.steps[1]!,
                status: "done",
                delta: -395_000_000,
                contributionPct: 85.87,
                sql: rcaAnswer.primaryCauses[0]!.sql,
              },
            ],
          },
        }),
      );

    render(<App />);

    fireEvent.change(screen.getByLabelText("Câu hỏi"), {
      target: { value: plan.question },
    });
    fireEvent.click(screen.getByRole("button", { name: "Gửi câu hỏi" }));

    // Interrupt panel appears
    await screen.findByTestId("plan-review-panel");
    expect(screen.getByTestId("plan-review-asof").textContent).toContain("2026-10-01T07:00:00Z");

    // Edit plan: skip north region
    fireEvent.click(screen.getByTestId("plan-step-toggle-step_region_north"));
    fireEvent.click(screen.getByTestId("plan-approve-btn"));

    // First resume triggers 409 Conflict cleanly while preserving the plan review panel
    const conflict = await screen.findByTestId("plan-review-conflict");
    expect(conflict.textContent).toContain("409");
    expect(screen.getByTestId("plan-step-row-step_region_north").getAttribute("data-step-status")).toBe("skipped");

    // Second resume succeeds
    fireEvent.click(screen.getByTestId("plan-approve-btn"));

    await screen.findByTestId("root-cause-view");
    expect(screen.getByTestId("rca-math-badge").textContent).toContain("Đạt");
    expect(screen.getByTestId("rca-step-status-step_region_north").textContent).toContain("skipped");
    expect(screen.getByTestId("rca-step-status-step_region_central").textContent).toContain("done");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const resumeCallBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/runs/run-uc05/resume");
    expect(resumeCallBody.checkpointId).toBe("ckpt-e2e-1");
    expect(resumeCallBody.value.action).toBe("modify");
  });
});
