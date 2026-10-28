# Metrics (v1)

Canonical business metric definitions. Each section names the metric, the
tables it derives from, and the aliases users employ in Vietnamese and
English. No formulas, no thresholds, no query fragments. Sections whose
header ends with `[restricted_pii]` are withheld from principals lacking
the `data:sensitive` scope by the gateway resource filter.

## revenue_vnd
Metric: revenue_vnd
Tables: orders, order_items
Aliases: doanh thu, revenue, GMV
Definition: total merchandise revenue in VND for the filtered order set,
summed over order line prices. Fan-out guard: aggregate after joining
order_items, never by multiplying product prices with order counts.

## order_count
Metric: order_count
Tables: orders
Aliases: số đơn hàng, order count, number of orders
Definition: count of distinct orders in the filtered set. Status splits use
the order lifecycle state dimension; shares divide by the same filtered
total.

## average_order_value
Metric: average_order_value
Tables: orders, order_items
Aliases: giá trị đơn trung bình, AOV, average basket
Definition: merchandise revenue divided by distinct order count over the
same filtered set. Both numerator and denominator must share the filter.

## freight_share
Metric: freight_share
Tables: order_items
Aliases: tỉ trọng phí vận chuyển, freight share
Definition: freight spend relative to merchandise revenue over the same
filtered order lines.

## review_score_avg
Metric: review_score_avg
Tables: reviews
Aliases: điểm đánh giá trung bình, average rating
Definition: mean review score over reviews in the filtered set. Reviews are
optional per order, so the denominator is reviewed orders only.

## compensation_cost [restricted_pii]
Metric: compensation_cost
Tables: employees
Aliases: chi phí nhân sự, payroll
Definition: aggregate staff compensation. Restricted: individual compensation
is sensitive, so this whole section is withheld without the
`data:sensitive` scope.
