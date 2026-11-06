---
name: root-cause-analysis
description: Multi-step hierarchical root cause analysis diagnosing business metric movements across dimension breakdowns and formula decompositions.
---

# root-cause-analysis

## Skill Name

root-cause-analysis — multi-step hierarchical diagnostic workflow for business KPI shifts.

## Description

This skill defines the multi-step diagnostic workflow used to identify the root
causes of significant movements in business metrics (such as revenue drops, AOV
shifts, or return rate spikes). Rather than executing a single ad-hoc SQL query,
the agent conducts a hypothesis-driven decomposition across business dimensions
and formula trees, verifies mathematical conservation of delta attribution,
interacts with human reviewers via checkpoints, and bounds query budgets.

## When to Use and Triggers

Use this skill when:
- The user asks an open-ended diagnostic question in Vietnamese investigating why a metric changed,
  matching intent trigger patterns:
  - Explicit diagnostic regex: `/(?:vì sao|tại sao|nguyên nhân(?:\s+do đâu)?|do đâu mà|lý do gì)/i`
  - Comparative period indicator: comparison between two time periods (e.g., tháng này so với tháng trước, tuần 39 so với tuần 38)
  - Vietnamese query examples:
    - `"Vì sao doanh thu thuần tháng 9/2026 giảm so với tháng 8/2026?"`
    - `"Nguyên nhân do đâu mà giá trị đơn hàng trung bình (AOV) miền Nam tuần 39 giảm?"`
    - `"Tại sao tỷ lệ hoàn đơn tháng 10/2026 tăng ở miền Trung?"`
    - `"Do đâu mà doanh thu tháng 8/2026 tại Miền Bắc tăng đột biến so với tháng 7?"`
- The router identifies an intent requiring root-cause decomposition (UC-05 / `root-cause-analysis`).
- A proactive anomaly alert from UC-10 triggers a drill-down root cause investigation.

Do not use this skill for:
- Simple factual lookups or scalar checks (e.g., "Doanh thu tháng 9 là bao nhiêu?").
- Single-point queries where no baseline comparison period is involved.
- Exploratory schema definition lookups (handled by UC-01/UC-02).

## Inputs and Outputs

### Inputs
- `question`: The natural language diagnostic question in Vietnamese.
- `metric_name`: The business KPI being investigated (e.g., net_revenue, aov).
- `metric_type`: Metric classification ("additive" or "ratio").
- `direction`: Expected change direction ("decrease" or "increase") extracted from question intent.
- `current_period`: Time window of analysis (start and end dates, e.g., 2026-09-01 to 2026-09-30).
- `baseline_period`: Baseline comparison time window (start and end dates, e.g., 2026-08-01 to 2026-08-31).
- `formula_components`: Optional formula decomposition specification for ratio metrics (numerator, denominator, formula).
- `catalog_subset`: Governed schema definitions for available tables and columns.

### Outputs
- `analysis_plan`: Initial tree decomposition proposed for Human-In-The-Loop review.
- `root_cause_answer`: Final structured report containing:
  - Baseline verification status and calculated deltas (or false_premise halt).
  - Primary root-cause findings with dimension paths and percentage contributions.
  - Mathematical conservation check results (`mathDiffRatio <= 0.05`).
  - Grouped residual fluctuations from pruned branches (`residualOtherAbs`).
  - Catalog of unexplored branches reached due to quotas or depth limits.
  - Executed SQL evidence for every investigated node.

## Execution Steps

1. **validate_baseline (Baseline Verification & Premise Check)**:
   - Compute baseline value (V_base) and current value (V_curr) via read-only SQL queries.
   - Calculate absolute delta: Delta_total = V_curr - V_base, and percentage delta: Pct_delta = (Delta_total / |V_base|) * 100%.
   - Premise check: If the user asks about a drop but Delta_total >= 0, or asks about an increase but Delta_total <= 0,
     halt immediately with status "false_premise", report actual numbers in Vietnamese, and early stop (<= 2 SQL queries).
   - If change direction matches expectation, set isValidBaseline = true and advance to create_plan.

2. **create_plan (Two-Axis Decomposition Planning)**:
   - For additive metrics (e.g., Net Revenue): construct hierarchical breakdown along business dimensions
     (Region -> Channel -> Category -> Product).
   - For ratio metrics (e.g., AOV): decompose along vertical formula factors (Revenue = Orders * AOV) or
     convert to absolute numerator delta / Shift-Share.
   - Initialize tree with depth 0 steps marked with status "todo".

3. **human_review (Human-In-The-Loop Review Gate)**:
   - Suspend graph execution via interrupt() carrying the proposed AnalysisPlan payload.
   - Await user decision: APPROVE (keep proposed plan) or MODIFY (override with adjusted dimensions/factors).
   - Resume execution with the approved plan on the same thread_id.

4. **execute_step & evaluate_branch (Iterative Drill-Down & Pruning Loop)**:
   - Pick the next "todo" plan step within quotas (total_queries_count < 20, depth < 4).
   - Inherit parent filters (e.g., WHERE region = 'Miền Trung' AND channel = 'Shopee').
   - Execute GROUP BY query via ValidatedQueryExecutor against read-only database.
   - Fault isolation: retry failed SQL up to 2 times with database error context.
     If still failing, mark step as "failed" and continue without crashing the agent.
   - Calculate attribution: contribution_pct = (|Delta_branch| / |Delta_total|) * 100.
   - Branching decision:
     - If contribution_pct >= 30% and depth < 4: expand child steps into "todo" (depth + 1).
     - If contribution_pct < 30%: prune branch, mark as "skipped", and accumulate delta into residualOtherAbs.
     - If query quota (20) or max depth (4) reached: record to unexploredBranches.

5. **synthesize_report (Waterfall Attribution Math Verification & Synthesis)**:
   - Filter disjoint leaf nodes (excluding intermediate parents to prevent double-counting).
   - Compute total explained delta: Delta_explained = sum(Delta_leaves) + residualOtherAbs.
   - Calculate attribution deviation ratio: mathDiffRatio = |Delta_explained - Delta_total| / |Delta_total|.
   - Verify math: set mathVerified = true if mathDiffRatio <= 0.05 (K7 Gate: <= 5% tolerance).
   - Identify primary causes (contribution_pct >= 50% or Top 3 influential leaves).
   - Synthesize Vietnamese Markdown report containing phenomenon, root causes with SQL evidence,
     math verification status, residual other fluctuations, and unexplored branches.

## Constraints and Guardrails

- Read-only execution: all generated queries must be SELECT or WITH statements.
- Strict quota limits: maximum 20 SQL executions per diagnostic session.
- Maximum tree depth: maximum 4 levels of hierarchical drill-down.
- Local fault isolation: maximum 2 retries per step; step failure must never abort the entire workflow.
- Attribution conservation: absolute difference ratio between explained delta (disjoint leaves + residual)
  and total delta must satisfy mathDiffRatio <= 0.05 (tolerance <= 5%).
- Zero-tools synthesis: final report generation node runs with no database tools bound.
- No hallucinated attribution: all causal claims must be directly backed by SQL result rows captured in execution evidence.
- PII protection: never extract or display unmasked personal customer data.

## Examples

Example 1: Additive Metric Net Revenue Drop (Seeded Scenario 1 - KB1)
- Question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?"
- Metric: `net_revenue` (additive, direction: decrease)
- Baseline check: V_base (T8) = 2.50 tỷ VNĐ, V_curr (T9) = 2.04 tỷ VNĐ -> Delta_total = -460 triệu VNĐ (-18.4%).
- Decomposition path: `region` -> `channel` -> `category`.
- Exploration findings:
  - Region: Miền Trung accounts for -460M VNĐ (100% contribution -> branch).
  - Channel: Shopee in Miền Trung accounts for -460M VNĐ (100% contribution -> branch).
  - Category: Đồ gia dụng on Shopee in Miền Trung accounts for -460M VNĐ (primary root cause).
- Pruned: Miền Bắc and Miền Nam pruned into residual (Delta = 0 VNĐ, 0%).
- Root Cause Event: Tạm khóa gian hàng ngành Đồ gia dụng trên kênh Shopee tại kho Đà Nẵng từ 05/09/2026.
- Math verification: mathDiffRatio = |-460M - (-460M)| / 460M = 0.0% <= 5% -> PASSED.

Example 2: Ratio Metric AOV Drop (Seeded Scenario 2 - KB2)
- Question: "Vì sao doanh thu Miền Nam trong Tuần 39/2026 giảm 22.0% so với Tuần 38/2026?"
- Metric: `net_revenue` decomposed into `order_count` * `aov` (ratio, direction: decrease)
- Formula breakdown: Delivered order count increased by +5%, but AOV plummeted by -25.7%.
- Exploration findings:
  - Channel: TikTok Shop in Miền Nam accounts for primary AOV drop.
  - Category: Thời trang nữ on TikTok Shop Miền Nam accounts for -128,500 VNĐ drop in AOV.
- Root Cause Event: Chiến dịch livestream gặp sự cố cấu hình nhầm voucher FLASH99_ERR giảm 60%.
- Math verification: Shift-Share / ratio attribution deviation <= 5% -> PASSED.

Example 3: Additive Metric Surge (Seeded Scenario 3 - KB3)
- Question: "Vì sao doanh thu thuần tháng 08/2026 tại Miền Bắc tăng vọt 31.5% so với tháng 07/2026?"
- Metric: `net_revenue` (additive, direction: increase)
- Baseline check: V_base (T7) = 2.00 tỷ VNĐ, V_curr (T8) = 2.63 tỷ VNĐ -> Delta_total = +630 triệu VNĐ (+31.5%).
- Decomposition path: `region` (Miền Bắc) -> `channel` (Website) -> `category` (Laptop & Thiết bị IT).
- Root Cause Event: Chương trình Back-to-School trợ giá độc quyền trên Website chính thức cho sinh viên khu vực Miền Bắc.
- Math verification: mathDiffRatio = |630M - 630M| / 630M = 0.0% <= 5% -> PASSED.

## Final Check

Before returning the diagnostic response, verify:
1. Baseline premise was validated against actual database metrics.
2. If premise was contradictory, execution halted immediately with status false_premise (<= 2 SQL queries).
3. The user had an opportunity to review the decomposition plan at the human_review HITL gate.
4. Every causal statement references an executed, logged SQL query.
5. Attribution math verification confirms mathDiffRatio = |sum(Delta_leaves) + residualOtherAbs - Delta_total| / |Delta_total| <= 0.05.
6. All pruned or unvisited branches are documented in unexploredBranches.
