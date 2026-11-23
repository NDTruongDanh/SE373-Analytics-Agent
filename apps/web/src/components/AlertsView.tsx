import {
  AnomalyAlertSchema,
  type AlertSeverity,
  type AnomalyAlert,
} from "@shared/contracts";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";

export interface ManualAlertRunSummary {
  date?: string;
  totalSubscriptions?: number;
  evaluatedSubscriptions?: number;
  anomaliesDetected: number;
  alertsSent: number;
  alertsQueued: number;
  alertsSkippedDuplicate: number;
  alertsBlocked?: number;
  flushedDigestCount?: number;
  alerts?: AnomalyAlert[];
}

export interface AlertsViewProps {
  alerts?: AnomalyAlert[];
  onTriggerManualRun?: (options: {
    targetDate?: string;
    flushDigest: boolean;
  }) => Promise<ManualAlertRunSummary | void> | ManualAlertRunSummary | void;
  triggerEndpoint?: string;
  defaultTargetDate?: string;
}

const DEFAULT_SEEDED_ALERTS: AnomalyAlert[] = [
  {
    subscriptionId: "return-rate-daily",
    metric: "metric:return_rate",
    currentValue: 0.185,
    expectedValue: 0.042,
    deviation: "z=+63.74, WoW=+340.5%",
    drilldownSegment: "regions.province = 'Đà Nẵng' AND categories.name_vi = 'Thực phẩm tươi sống'",
    evidenceSql:
      "SELECT regions.province, categories.name_vi, COUNT(*) AS total_orders, AVG(CASE WHEN orders.status = 'returned' THEN 1.0 ELSE 0.0 END) AS return_rate FROM orders JOIN regions ON orders.province = regions.province JOIN order_items ON orders.order_id = order_items.order_id JOIN products ON order_items.product_id = products.product_id JOIN categories ON products.category_id = categories.category_id WHERE orders.purchase_date = '2026-09-14' GROUP BY regions.province, categories.name_vi HAVING COUNT(*) >= 5 ORDER BY return_rate DESC, total_orders DESC LIMIT 10",
    recipientId: "ops_lead",
    recipientRole: "operations",
    severity: "critical",
    direction: "spike",
    date: "2026-09-14",
    fingerprint: "24ecdc0049150ed6be8cc921dd642d36b56b433f94e8bb2c27c98a00a0979352",
    message:
      "Phát hiện metric:return_rate tăng đột biến vào ngày 2026-09-14 (z=+63.74, WoW=+340.5%). Vùng ảnh hưởng chính: regions.province = 'Đà Nẵng' AND categories.name_vi = 'Thực phẩm tươi sống'.",
  },
  {
    subscriptionId: "net-revenue-daily",
    metric: "metric:net_revenue",
    currentValue: 89_000_000,
    expectedValue: 180_000_000,
    deviation: "z=-10.00, WoW=-51.1%",
    drilldownSegment: "customers.region_group = 'Nam' AND orders.channel_id = 'shopee'",
    evidenceSql:
      "SELECT customers.region_group, orders.channel_id, COUNT(*) AS total_orders, SUM(orders.total_amount) AS revenue FROM orders JOIN customers ON orders.customer_id = customers.customer_id WHERE orders.purchase_date = '2026-09-21' GROUP BY customers.region_group, orders.channel_id ORDER BY revenue DESC LIMIT 10",
    recipientId: "finance_lead",
    recipientRole: "finance",
    severity: "critical",
    direction: "drop",
    date: "2026-09-21",
    fingerprint: "9d81a4f7c2e13b0589c2e8a4f617093bc42d5a7f8e1c6b03d94a2e71f8c3a509",
    message:
      "Phát hiện metric:net_revenue giảm đột biến vào ngày 2026-09-21 (z=-10.00, WoW=-51.1%). Vùng ảnh hưởng chính: customers.region_group = 'Nam' AND orders.channel_id = 'shopee'.",
  },
  {
    subscriptionId: "review-score-daily",
    metric: "metric:review_score_avg",
    currentValue: 3.45,
    expectedValue: 4.62,
    deviation: "z=-2.54, WoW=-25.3%",
    drilldownSegment: "categories.name_vi = 'Mỹ phẩm' AND products.product_id = 'P_1089'",
    evidenceSql:
      "SELECT categories.name_vi, products.product_id, COUNT(*) AS total_reviews, AVG(reviews.score) AS avg_score FROM reviews JOIN orders ON reviews.order_id = orders.order_id JOIN order_items ON orders.order_id = order_items.order_id JOIN products ON order_items.product_id = products.product_id JOIN categories ON products.category_id = categories.category_id WHERE reviews.created_at::date = '2026-09-25' GROUP BY categories.name_vi, products.product_id ORDER BY avg_score ASC LIMIT 10",
    recipientId: "customer_experience",
    recipientRole: "support_lead",
    severity: "warning",
    direction: "drop",
    date: "2026-09-25",
    fingerprint: "7b34c210f9d84b1a63e21c0748f5a9e1b3c7d2e4f8a9012b34c56d78e9f01a23",
    message:
      "Phát hiện metric:review_score_avg giảm đột biến vào ngày 2026-09-25 (z=-2.54, WoW=-25.3%). Vùng ảnh hưởng chính: categories.name_vi = 'Mỹ phẩm' AND products.product_id = 'P_1089'.",
  },
];

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: "Nghiêm trọng (critical)",
  warning: "Cảnh báo (warning)",
  info: "Thông tin (info)",
};

function formatMetricValue(metric: string, value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (metric.includes("rate")) {
    return `${(value * 100).toFixed(2)}%`;
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function alertCardKey(alert: AnomalyAlert, index: number): string {
  if (alert.fingerprint) return alert.fingerprint;
  return `${alert.recipientId}:${alert.metric}:${alert.date ?? ""}:${alert.drilldownSegment}:${index}`;
}

export function AlertsView({
  alerts,
  onTriggerManualRun,
  triggerEndpoint = "/api/alerts/run",
  defaultTargetDate = "2026-09-14",
}: AlertsViewProps) {
  const [items, setItems] = useState<AnomalyAlert[]>(() =>
    alerts ? [...alerts] : [...DEFAULT_SEEDED_ALERTS],
  );
  const [severityFilter, setSeverityFilter] = useState<"all" | AlertSeverity>("all");
  const [recipientFilter, setRecipientFilter] = useState<string>("all");
  const [metricQuery, setMetricQuery] = useState<string>("");
  const [targetDate, setTargetDate] = useState<string>(defaultTargetDate);
  const [flushDigest, setFlushDigest] = useState<boolean>(false);
  const [expandedSqlKeys, setExpandedSqlKeys] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRunSummary, setLastRunSummary] = useState<ManualAlertRunSummary | null>(null);

  const severityId = useId();
  const recipientId = useId();
  const metricId = useId();
  const dateId = useId();
  const flushId = useId();

  useEffect(() => {
    if (alerts) {
      setItems([...alerts]);
    }
  }, [alerts]);

  const recipients = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) {
      seen.add(item.recipientId);
    }
    return [...seen].sort();
  }, [items]);

  const filteredAlerts = useMemo(() => {
    const query = metricQuery.trim().toLowerCase();
    return items.filter((item) => {
      if (severityFilter !== "all" && item.severity !== severityFilter) {
        return false;
      }
      if (recipientFilter !== "all" && item.recipientId !== recipientFilter) {
        return false;
      }
      if (query.length > 0) {
        const haystack = `${item.metric} ${item.drilldownSegment} ${item.recipientId}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [items, severityFilter, recipientFilter, metricQuery]);

  const counts = useMemo(() => {
    let critical = 0;
    let digest = 0;
    for (const item of items) {
      if (item.severity === "critical") critical += 1;
      else digest += 1;
    }
    return {
      total: items.length,
      critical,
      digest,
      deduplicated: lastRunSummary?.alertsSkippedDuplicate ?? 0,
    };
  }, [items, lastRunSummary]);

  function toggleEvidenceSql(key: string) {
    setExpandedSqlKeys((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }

  async function handleManualTrigger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running) return;
    setRunning(true);
    setRunError(null);

    try {
      let summary: ManualAlertRunSummary | void;
      if (onTriggerManualRun) {
        summary = await onTriggerManualRun({
          ...(targetDate.trim() ? { targetDate: targetDate.trim() } : {}),
          flushDigest,
        });
      } else {
        const response = await fetch(triggerEndpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            manual: true,
            ...(targetDate.trim() ? { targetDate: targetDate.trim() } : {}),
            flushDigest,
          }),
        });
        if (!response.ok) {
          throw new Error(`Không thể chạy kiểm tra bất thường (HTTP ${response.status}).`);
        }
        summary = (await response.json()) as ManualAlertRunSummary;
      }

      if (summary) {
        setLastRunSummary(summary);
        if (Array.isArray(summary.alerts) && summary.alerts.length > 0) {
          const validIncoming = summary.alerts
            .map((raw) => AnomalyAlertSchema.safeParse(raw))
            .filter((parsed): parsed is { success: true; data: AnomalyAlert } => parsed.success)
            .map((parsed) => parsed.data);
          if (validIncoming.length > 0) {
            setItems((prev) => {
              const seenFp = new Set(prev.map((a) => a.fingerprint).filter(Boolean));
              const merged = [...prev];
              for (const next of validIncoming) {
                if (next.fingerprint && seenFp.has(next.fingerprint)) continue;
                if (next.fingerprint) seenFp.add(next.fingerprint);
                merged.unshift(next);
              }
              return merged;
            });
          }
        }
      }
    } catch (err) {
      setRunError(
        err instanceof Error ? err.message : "Đã xảy ra lỗi khi kích hoạt kiểm tra bất thường.",
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="alerts-view" aria-label="Bảng cảnh báo bất thường UC-10">
      <header className="alerts-header">
        <div>
          <p className="eyebrow accent">UC-10 · ANOMALY DETECTION &amp; ALERTS</p>
          <h2>Cảnh báo bất thường định kỳ</h2>
          <p>
            Theo dõi bất thường theo z-score (trimmed 28 ngày), WoW% và điều kiện min_support, kèm
            khử trùng lặp 24 giờ theo từng người nhận.
          </p>
        </div>

        <dl className="alerts-stats" aria-label="Tổng quan cảnh báo">
          <div className="stat-item">
            <dt>Tổng cảnh báo</dt>
            <dd>{counts.total}</dd>
          </div>
          <div className="stat-item">
            <dt>Nghiêm trọng</dt>
            <dd>{counts.critical}</dd>
          </div>
          <div className="stat-item">
            <dt>Gom digest</dt>
            <dd>{counts.digest}</dd>
          </div>
          <div className="stat-item">
            <dt>Khử trùng 24h</dt>
            <dd>{counts.deduplicated}</dd>
          </div>
        </dl>
      </header>

      <form
        className="alerts-manual-run"
        onSubmit={handleManualTrigger}
        aria-label="Chạy kiểm tra bất thường thủ công"
      >
        <div className="manual-controls">
          <label htmlFor={dateId}>
            Ngày kiểm tra
            <input
              id={dateId}
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              disabled={running}
            />
          </label>

          <label htmlFor={flushId} className="checkbox-label">
            <input
              id={flushId}
              type="checkbox"
              checked={flushDigest}
              onChange={(e) => setFlushDigest(e.target.checked)}
              disabled={running}
            />
            Gửi ngay hàng đợi digest (--flush-digest)
          </label>
        </div>

        <button type="submit" className="btn-primary" disabled={running}>
          {running ? "Đang quét bất thường..." : "Chạy kiểm tra bất thường"}
        </button>
      </form>

      {runError && (
        <div className="error" role="alert">
          {runError}
        </div>
      )}

      {lastRunSummary && (
        <div className="alerts-run-summary" role="status" aria-live="polite">
          <strong>Kết quả quét thủ công{lastRunSummary.date ? ` (${lastRunSummary.date})` : ""}:</strong>{" "}
          <span>Phát hiện {lastRunSummary.anomaliesDetected} bất thường</span>
          {" · "}
          <span>Đã gửi {lastRunSummary.alertsSent}</span>
          {" · "}
          <span>Hàng đợi {lastRunSummary.alertsQueued}</span>
          {" · "}
          <span>Bỏ qua trùng lặp 24h: {lastRunSummary.alertsSkippedDuplicate}</span>
        </div>
      )}

      <div className="alerts-filters" role="region" aria-label="Bộ lọc cảnh báo">
        <label htmlFor={severityId}>
          Mức độ
          <select
            id={severityId}
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as "all" | AlertSeverity)}
          >
            <option value="all">Tất cả mức độ</option>
            <option value="critical">critical</option>
            <option value="warning">warning</option>
            <option value="info">info</option>
          </select>
        </label>

        <label htmlFor={recipientId}>
          Người nhận
          <select
            id={recipientId}
            value={recipientFilter}
            onChange={(e) => setRecipientFilter(e.target.value)}
          >
            <option value="all">Tất cả người nhận</option>
            {recipients.map((rec) => (
              <option key={rec} value={rec}>
                {rec}
              </option>
            ))}
          </select>
        </label>

        <label htmlFor={metricId}>
          Tìm chỉ số / phân đoạn
          <input
            id={metricId}
            type="search"
            placeholder="Ví dụ: return_rate, Đà Nẵng..."
            value={metricQuery}
            onChange={(e) => setMetricQuery(e.target.value)}
          />
        </label>
      </div>

      {filteredAlerts.length === 0 ? (
        <div className="alerts-empty">
          Không có cảnh báo nào khớp bộ lọc hiện tại.
        </div>
      ) : (
        <div className="alerts-list">
          {filteredAlerts.map((alert, idx) => {
            const key = alertCardKey(alert, idx);
            const sqlExpanded = Boolean(expandedSqlKeys[key]);
            const sqlRegionId = `evidence-sql-${idx}`;

            return (
              <article
                key={key}
                className={`alert-card alert-severity-${alert.severity}`}
                aria-label={`Cảnh báo ${alert.metric}`}
              >
                <div className="alert-card-header">
                  <div className="alert-badges">
                    <span className={`severity-badge severity-${alert.severity}`}>
                      {alert.severity}
                    </span>
                    <span className="severity-label">{SEVERITY_LABELS[alert.severity]}</span>
                    {alert.direction && (
                      <span className="direction-badge">{alert.direction}</span>
                    )}
                    {alert.date && <span className="alert-date">{alert.date}</span>}
                  </div>
                  <div className="alert-recipient">
                    <span>Người nhận: </span>
                    <strong>{alert.recipientId}</strong>
                    {alert.recipientRole && <span> ({alert.recipientRole})</span>}
                  </div>
                </div>

                <h3 className="alert-metric">{alert.metric}</h3>

                {alert.message && <p className="alert-message">{alert.message}</p>}

                <dl className="alert-fields">
                  <div className="alert-field">
                    <dt>Giá trị hiện tại</dt>
                    <dd>{formatMetricValue(alert.metric, alert.currentValue)}</dd>
                  </div>
                  <div className="alert-field">
                    <dt>Giá trị kỳ vọng</dt>
                    <dd>{formatMetricValue(alert.metric, alert.expectedValue)}</dd>
                  </div>
                  <div className="alert-field">
                    <dt>Mức lệch (deviation)</dt>
                    <dd>{alert.deviation}</dd>
                  </div>
                  <div className="alert-field">
                    <dt>Vùng khoanh được (drilldownSegment)</dt>
                    <dd>{alert.drilldownSegment}</dd>
                  </div>
                </dl>

                <div className="alert-dedup">
                  <span>Dedup fingerprint (24h): </span>
                  <code>{alert.fingerprint ?? "chưa cấp"}</code>
                </div>

                <div className="alert-sql-section">
                  <button
                    type="button"
                    className="details-toggle"
                    aria-expanded={sqlExpanded}
                    aria-controls={sqlRegionId}
                    onClick={() => toggleEvidenceSql(key)}
                  >
                    <span>
                      {sqlExpanded ? "Ẩn SQL dẫn chứng" : "Xem SQL dẫn chứng"}
                    </span>
                    <span aria-hidden="true">{sqlExpanded ? "−" : "+"}</span>
                  </button>
                  {sqlExpanded && (
                    <div id={sqlRegionId} className="details-body">
                      <pre>{alert.evidenceSql}</pre>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
