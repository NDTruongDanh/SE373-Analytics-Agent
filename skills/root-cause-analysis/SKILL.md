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
- The user asks an open-ended diagnostic question in Vietnamese about why a metric changed,
  such as "Vì sao doanh thu thuần tháng 9/2026 giảm so với tháng 8/2026?" or "Nguyên nhân do đâu
  mà giá trị đơn hàng trung bình (AOV) miền Nam tuần 39 giảm?".
- The router identifies an intent requiring root-cause decomposition (UC-05).
- A proactive anomaly alert from UC-10 triggers a drill-down investigation.

Do not use this skill for simple factual lookups, single-value scalar checks,
or questions where no baseline comparison period is involved.

## Inputs and Outputs

### Inputs
- `question`: The natural language diagnostic question in Vietnamese.
- `metric_name`: The business KPI being investigated (e.g., net_revenue, aov).
- `metric_type`: Metric classification ("additive" or "ratio").
- `current_period`: Time window of analysis (start and end dates).
- `baseline_period`: Baseline comparison time window (start and end dates).
- `catalog_subset`: Governed schema definitions for available tables and columns.

### Outputs
- `analysis_plan`: Initial tree decomposition proposed for Human-In-The-Loop review.
- `root_cause_answer`: Final structured report containing:
  - Baseline verification status and calculated deltas (or false_premise halt).
  - Primary root-cause findings with dimension paths and percentage contributions.
  - Mathematical conservation check results (variance within 1% to 5%).
  - Grouped residual fluctuations from pruned branches (`residualOtherAbs`).
  - Catalog of unexplored branches reached due to quotas or depth limits.
  - Executed SQL evidence for every investigated node.

## Execution Steps

1. **Baseline Verification (Premise Check)**:
   - Compute baseline value (V_base) and current value (V_curr) via read-only SQL.
   - Calculate absolute delta (Delta_total = V_curr - V_base) and percentage delta.
   - Verify premise: if the user asks about a drop but Delta_total >= 0 (or vice versa),
     halt immediately with status "false_premise", report actual figures in Vietnamese, and stop.

2. **Two-Axis Decomposition Planning**:
   - For additive metrics (e.g., Net Revenue, Total Orders): build initial hierarchy
     along horizontal business dimensions (e.g., territory -> sales_channel -> category -> product).
   - For ratio metrics (e.g., AOV, Conversion Rate): decompose along vertical formula
     factors (Revenue = Orders * AOV) or convert to absolute numerator delta / Shift-Share.
   - Initialize task list with depth 0 steps marked as "todo".

3. **Human-In-The-Loop Review Gate**:
   - Suspend graph execution via interrupt() carrying the proposed plan.
   - Await human decision: accept as-is or modify dimensions/factors.
   - Resume execution with the approved plan.

4. **Iterative Drill-Down and Pruning Loop**:
   - Pick the next "todo" plan step within quotas (query count <= 20, depth <= 4).
   - Inherit parent filters (e.g., WHERE territory = 'Tier-1' AND channel = 'Direct').
   - Generate and execute GROUP BY query against the read-only database.
   - Fault isolation: retry failed SQL up to 2 times with database error context.
     If still failing, mark step as "failed" and continue without crashing the agent.
   - Calculate contribution percentage: (|Delta_branch| / |Delta_total|) * 100.
   - Branching decision:
     - If contribution >= 30% and depth < 4: expand next-level child steps into "todo".
     - If contribution < 30%: prune branch, mark as "skipped", and accumulate delta
       into residualOtherAbs.
     - If query quota (20) or max depth (4) reached: record to unexploredBranches.

5. **Attribution Math Verification**:
   - Filter disjoint leaf nodes (excluding intermediate parents to prevent double-counting).
   - Sum leaf deltas plus residualOtherAbs and compare with Delta_total.
   - Validate that attribution deviation is within the allowable tolerance (<= 5%).

6. **Synthesize Report**:
   - Construct executive Markdown summary with phenomenon description.
   - Present primary root causes with absolute values, percentages, and SQL evidence.
   - Disclose residual fluctuations and transparently list unexplored branches.

## Constraints and Guardrails

- Read-only execution: all generated queries must be SELECT or WITH statements.
- Strict quota limits: maximum 20 SQL executions per diagnostic session.
- Maximum tree depth: maximum 4 levels of hierarchical drill-down.
- Local fault isolation: maximum 2 retries per step; step failure must never abort
  the entire multi-step workflow.
- No hallucinated attribution: all causal claims must be directly backed by SQL
  result rows captured in execution evidence.
- PII protection: never extract or display unmasked personal customer data.

## Examples

Example 1: Additive Metric Breakdown (Generic Synthetic Pattern)
- Question: "Vì sao doanh thu thuần khu vực Miền Bắc quý 3/2026 giảm 15% so với quý 2/2026?"
- Metric: `net_sales` (additive)
- Baseline check: Q2 ($10.0M), Q3 ($8.5M) -> Total Delta = -$1.5M (-15.0%).
- Plan: `market_segment` -> `distribution_channel` -> `product_line`.
- Exploration findings:
  - Market segment: Segment Enterprise accounts for -$1.2M (80% contribution -> branch).
  - Channel: Partner Retail in Segment Enterprise accounts for -$1.2M (branch).
  - Product line: Line Omega accounts for -$1.2M (primary root cause).
- Pruned: Segments Consumer and SMB pruned into residual (-$0.3M, 20%).
- Math verification: (-$1.2M + (-$0.3M)) / (-$1.5M) = 100% -> PASSED.

Example 2: Ratio Metric Decomposition (Generic Formula Pattern)
- Question: "Vì sao giá trị trung bình mỗi đơn hàng (AOV) của cổng doanh nghiệp giảm 18% trong tháng vừa qua?"
- Formula breakdown: Gross Revenue = Total Baskets * Average Basket Value.
- Observation: Basket count rose by 2%, but average basket value fell from $120 to $98.
- Analysis: Product price tier mix shifted toward entry-level maintenance subscriptions.
- Conclusion: Volume expansion masked average order value decline.

## Final Check

Before returning the diagnostic response, verify:
1. Baseline premise was validated against actual database metrics.
2. If premise was contradictory, execution halted immediately with status false_premise.
3. The user had an opportunity to review the decomposition plan at the HITL gate.
4. Every causal statement references an executed, logged SQL query.
5. Attribution sum of leaf nodes and residual matches total delta within tolerance.
6. All pruned or unvisited branches are documented in unexploredBranches.
