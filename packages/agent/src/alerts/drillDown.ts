import { sqlGuard } from "@shared/access-policy";
import {
  AnomalyAlertSchema,
  type AnomalyAlert,
  type SchemaCatalog,
  type Subscription,
} from "@shared/contracts";
import type { AnomalyDetectorOutput } from "./anomalyDetector.js";
import { DEFAULT_ANOMALY_CATALOG } from "./catalog.js";
import { calculateAlertFingerprint } from "./fingerprint.js";

export interface McpQueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number;
  error?: string;
}

export type McpQueryExecutor = (sql: string) => Promise<McpQueryResult>;

export interface DrillDownInput {
  subscription: Subscription;
  dimensionKey: string;
  date: string;
  anomaly: AnomalyDetectorOutput;
  mcpExecutor: McpQueryExecutor;
  recipientRole?: string;
  catalog?: SchemaCatalog;
  model?: unknown;
}

export interface DrillDownResult {
  selectedDimensions: string[];
  drilldownSegment: string;
  evidenceSql: string;
  alert: AnomalyAlert;
  topSegmentRow?: Record<string, unknown>;
  explanation: string;
}

/**
 * Builds candidate breakdown SQL query based on metric, target date,
 * selected secondary dimensions, and recipient RBAC filter.
 */
export function buildDrillDownSql(options: {
  metricId: string;
  secondaryDimensions: string[];
  date: string;
  dimensionKey?: string;
  recipientRole?: string;
}): string {
  const { metricId, secondaryDimensions, date, recipientRole } = options;

  // Selected 1 or 2 dimensions
  const dims = secondaryDimensions.slice(0, 2);
  const primaryDim = dims[0] || "regions.province";
  const secondaryDim = dims[1];

  // RBAC WHERE filter injection (UC-10 §6: Policy applied at query generation)
  const rbacClauses: string[] = [];
  if (recipientRole) {
    const roleLower = recipientRole.toLowerCase();
    if (roleLower.includes("south") || roleLower.includes("nam")) {
      rbacClauses.push("regions.region = 'Nam'");
    } else if (roleLower.includes("north") || roleLower.includes("bac")) {
      rbacClauses.push("regions.region = 'Bắc'");
    } else if (roleLower.includes("central") || roleLower.includes("trung")) {
      rbacClauses.push("regions.region = 'Trung'");
    }
  }

  const whereConditions = [`orders.purchase_date = '${date}'`, ...rbacClauses];
  const whereSql = whereConditions.join(" AND ");

  const selectCols = secondaryDim
    ? `${primaryDim}, ${secondaryDim}`
    : primaryDim;
  const groupByCols = secondaryDim
    ? `${primaryDim}, ${secondaryDim}`
    : primaryDim;

  // Determine needed JOINs based on referenced tables
  const queryRefText = `${metricId} ${selectCols} ${whereSql}`;
  const joins: string[] = [];
  if (queryRefText.includes("regions.") || rbacClauses.length > 0) {
    joins.push("JOIN regions ON orders.province = regions.province");
  }
  if (queryRefText.includes("customers.")) {
    joins.push("JOIN customers ON orders.customer_id = customers.customer_id");
  }
  if (queryRefText.includes("channels.")) {
    joins.push("JOIN channels ON orders.channel_id = channels.channel_id");
  }
  if (
    queryRefText.includes("order_items.") ||
    queryRefText.includes("products.") ||
    queryRefText.includes("categories.") ||
    queryRefText.includes("sellers.") ||
    metricId === "metric:return_rate" ||
    metricId === "metric:cancellation_rate"
  ) {
    joins.push("JOIN order_items ON orders.order_id = order_items.order_id");
  }
  if (
    queryRefText.includes("products.") ||
    queryRefText.includes("categories.") ||
    metricId === "metric:return_rate" ||
    metricId === "metric:cancellation_rate"
  ) {
    joins.push("JOIN products ON order_items.product_id = products.product_id");
  }
  if (
    queryRefText.includes("categories.") ||
    metricId === "metric:return_rate" ||
    metricId === "metric:cancellation_rate"
  ) {
    joins.push("JOIN categories ON products.category_id = categories.category_id");
  }
  if (queryRefText.includes("sellers.")) {
    joins.push("JOIN sellers ON order_items.seller_id = sellers.seller_id");
  }

  const joinSql = joins.length > 0 ? ` ${joins.join(" ")}` : "";

  if (metricId === "metric:return_rate") {
    return (
      `SELECT ${selectCols}, COUNT(*) AS total_orders, ` +
      `AVG(CASE WHEN orders.status = 'returned' THEN 1.0 ELSE 0.0 END) AS return_rate ` +
      `FROM orders${joinSql} ` +
      `WHERE ${whereSql} ` +
      `GROUP BY ${groupByCols} ` +
      `HAVING COUNT(*) >= 5 ` +
      `ORDER BY return_rate DESC, total_orders DESC ` +
      `LIMIT 10`
    );
  }

  if (metricId === "metric:cancellation_rate") {
    return (
      `SELECT ${selectCols}, COUNT(*) AS total_orders, ` +
      `AVG(CASE WHEN orders.status = 'canceled' THEN 1.0 ELSE 0.0 END) AS cancel_rate ` +
      `FROM orders${joinSql} ` +
      `WHERE ${whereSql} ` +
      `GROUP BY ${groupByCols} ` +
      `ORDER BY cancel_rate DESC ` +
      `LIMIT 10`
    );
  }

  if (metricId === "metric:review_score_avg") {
    return (
      `SELECT ${selectCols}, COUNT(*) AS total_reviews, ` +
      `AVG(reviews.score) AS avg_score ` +
      `FROM reviews ` +
      `JOIN orders ON reviews.order_id = orders.order_id ` +
      `JOIN order_items ON orders.order_id = order_items.order_id ` +
      `JOIN products ON order_items.product_id = products.product_id ` +
      `JOIN categories ON products.category_id = categories.category_id ` +
      `WHERE reviews.created_at::date = '${date}' ` +
      `GROUP BY ${groupByCols} ` +
      `ORDER BY avg_score ASC ` +
      `LIMIT 10`
    );
  }

  // Default metric: revenue / order count
  return (
    `SELECT ${selectCols}, COUNT(*) AS total_orders, ` +
    `SUM(orders.total_amount) AS revenue ` +
    `FROM orders${joinSql} ` +
    `WHERE ${whereSql} ` +
    `GROUP BY ${groupByCols} ` +
    `ORDER BY revenue DESC ` +
    `LIMIT 10`
  );
}

/**
 * Formats a key-value row into a drilldown segment string (e.g. `regions.province = 'Đà Nẵng'`).
 */
export function formatDrilldownSegment(
  row: Record<string, unknown>,
  dimensions: string[],
): string {
  const parts: string[] = [];
  for (const dim of dimensions) {
    const colName = dim.includes(".") ? dim.split(".")[1] : dim;
    const value = row[colName] ?? row[dim];
    if (value !== undefined && value !== null) {
      const valStr = typeof value === "string" ? `'${value}'` : String(value);
      parts.push(`${dim} = ${valStr}`);
    }
  }
  return parts.length > 0 ? parts.join(" AND ") : "all_segments";
}

/**
 * 1–2 Dimension Drill-Down Analyzer (UC-10 §5, F10.3)
 *
 * - Inputs anomalous slice + candidate dimensions from subscriptions.yaml
 * - Formulates SQL breakdown query with RBAC injected
 * - Validates query via sqlGuard (@shared/access-policy)
 * - Executes query via MCP
 * - Identifies highest-impact segment
 * - Composes strict 6-field AnomalyAlert (PRD UC-10 acceptance criterion #2)
 */
export async function runDrillDownAnalysis(
  input: DrillDownInput,
): Promise<DrillDownResult> {
  const { subscription, dimensionKey, date, anomaly, mcpExecutor } = input;
  const recipientRole = input.recipientRole ?? subscription.recipientRole;

  // 1. Select 1-2 secondary dimensions
  const candidateDims = subscription.suggestedSecondaryDimensions ?? [];
  const selectedDimensions =
    candidateDims.length > 0
      ? candidateDims.slice(0, 2)
      : ["regions.province"];

  // 2. Build candidate breakdown SQL
  const evidenceSql = buildDrillDownSql({
    metricId: subscription.metricId,
    secondaryDimensions: selectedDimensions,
    date,
    dimensionKey,
    recipientRole,
  });

  // 3. Validate SQL with sqlGuard (TypeScript pgsql-parser)
  const catalog = input.catalog ?? DEFAULT_ANOMALY_CATALOG;
  const guardResult = await sqlGuard(evidenceSql, catalog);
  if (!guardResult.ok) {
    throw new Error(
      `Drill-down SQL validation failed: ${guardResult.error.code} - ${guardResult.error.message}`,
    );
  }

  // 4. Execute query via MCP client/executor
  const queryResult = await mcpExecutor(evidenceSql);
  if (queryResult.error) {
    throw new Error(`Drill-down execution failed: ${queryResult.error}`);
  }

  const rows = queryResult.rows || [];
  const topSegmentRow = rows.length > 0 ? rows[0] : undefined;

  // 5. Extract drilldown segment string
  let drilldownSegment: string;
  if (topSegmentRow) {
    drilldownSegment = formatDrilldownSegment(topSegmentRow, selectedDimensions);
  } else {
    drilldownSegment = dimensionKey.length > 0 ? dimensionKey : "overall";
  }

  // 6. Build explanation & message
  const dirText = anomaly.direction === "spike" ? "tăng đột biến" : "giảm đột biến";
  const explanation =
    `Phát hiện ${subscription.metricId} ${dirText} vào ngày ${date} ` +
    `(${anomaly.deviationSummary}). Vùng ảnh hưởng chính: ${drilldownSegment}.`;

  // 7. Compose strict 6-field AnomalyAlert (PRD UC-10 Criterion #2)
  const fingerprint = calculateAlertFingerprint({
    recipientId: subscription.recipientId,
    metric: subscription.metricId,
    dimensionKey: drilldownSegment,
    date,
    direction: anomaly.direction,
  });

  const alertCandidate: AnomalyAlert = {
    // 6 Mandatory fields:
    metric: subscription.metricId,
    currentValue: anomaly.currentValue,
    expectedValue: anomaly.expectedValue,
    deviation: anomaly.deviationSummary,
    drilldownSegment,
    evidenceSql,

    // Metadata & routing fields:
    subscriptionId: subscription.id,
    recipientId: subscription.recipientId,
    recipientRole: subscription.recipientRole,
    severity: anomaly.severity === "none" ? "info" : anomaly.severity,
    direction: anomaly.direction === "none" ? "spike" : anomaly.direction,
    date,
    fingerprint,
    message: explanation,
  };

  // Strict validation against AnomalyAlertSchema
  const alert = AnomalyAlertSchema.parse(alertCandidate);

  return {
    selectedDimensions,
    drilldownSegment,
    evidenceSql,
    alert,
    topSegmentRow,
    explanation,
  };
}
