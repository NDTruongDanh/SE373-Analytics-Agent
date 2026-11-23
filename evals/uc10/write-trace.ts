// UC-10 sample trace writer: drives anomaly-alert skill loading +
// ValidatedQueryExecutor + statistical anomaly detection (A1 return-rate spike
// in Da Nang on 2026-09-14) + 1-2 dim drill-down + send_alert dispatch +
// same-day 24h dedup verification, recording redacted spans through
// createSpanEmitter into traces/uc10/. Run via:
//   pnpm exec tsx evals/uc10/write-trace.ts

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Subscription } from "../../packages/contracts/src/alert.js";
import { DEFAULT_ANOMALY_CATALOG } from "../../packages/agent/src/alerts/catalog.js";
import {
  InMemoryAlertHistoryStore,
  InMemoryDigestQueue,
} from "../../packages/agent/src/alerts/dispatcher.js";
import {
  runAnomalyRunner,
  subtractDays,
} from "../../packages/agent/src/alerts/runner.js";
import {
  ValidatedQueryExecutor,
  type McpToolCaller,
} from "../../packages/agent/src/queryExecutor/executor.js";
import { loadSkill } from "../../packages/agent/src/skills/loader.js";
import { createSpanEmitter } from "../../packages/agent/src/telemetry/spans.js";

const RUN_ID = "a10a5f1e-7b2d-4c8e-9f0a-1b2c3d4e5f60";
const TARGET_DATE = "2026-09-14";
const THREAD_ID = `alert:ops_lead:${RUN_ID}`;
const TRACES_DIR = path.join("traces", "uc10");

async function main(): Promise<void> {
  mkdirSync(TRACES_DIR, { recursive: true });
  const traceFile = path.join(TRACES_DIR, `${RUN_ID}.jsonl`);
  if (existsSync(traceFile)) {
    rmSync(traceFile);
  }

  const emit = createSpanEmitter({
    runId: RUN_ID,
    threadId: THREAD_ID,
    userId: "ops_lead",
    role: "operations",
    tracesDir: TRACES_DIR,
  });

  // 1. Load anomaly-alert skill (emits skill_call span)
  loadSkill("anomaly-alert", {
    skillsDir: path.join(process.cwd(), "skills"),
    emit,
  });

  const subscription: Subscription = {
    id: "return-rate-daily",
    metricId: "metric:return_rate",
    primaryDimension: "orders.purchase_date",
    suggestedSecondaryDimensions: ["regions.province", "categories.name_vi"],
    recipientId: "ops_lead",
    recipientRole: "operations",
    channel: "webhook",
    digestPreference: "realtime",
    absoluteThreshold: { operator: "above", value: 0.1, unit: "ratio" },
    minSupport: 15,
  };

  const seriesRows = Array.from({ length: 36 }, (_, idx) => {
    const date = subtractDays(TARGET_DATE, 35 - idx);
    if (date === TARGET_DATE) {
      return { date, support_count: 52, value: 0.185 };
    }
    return {
      date,
      support_count: 45 + (idx % 10),
      value: Number((0.042 + (idx % 4) * 0.0015).toFixed(4)),
    };
  });

  const drillDownRows = [
    {
      province: "Đà Nẵng",
      name_vi: "Thực phẩm tươi sống",
      total_orders: 52,
      return_rate: 0.185,
    },
  ];

  const mcp: McpToolCaller = {
    call: async (tool, args) => {
      if (tool === "describe_table") {
        const tableName = String(args["table"] ?? "");
        const table = DEFAULT_ANOMALY_CATALOG.tables.find(
          (t) => t.name.toLowerCase() === tableName.toLowerCase(),
        );
        if (!table) throw new Error(`Unknown table: ${tableName}`);
        return {
          table: table.name,
          columns: table.columns.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            sensitive: c.sensitive,
          })),
          primaryKey: [],
          foreignKeys: [],
        };
      }
      if (tool === "explain_query") {
        return { estimatedCost: 42.5, estimatedRows: 36 };
      }
      if (tool === "run_query") {
        const sql = String(args["sql"] ?? "");
        if (/GROUP\s+BY\s+orders\.purchase_date/i.test(sql)) {
          return {
            columns: ["date", "support_count", "value"],
            rows: seriesRows,
            rowCount: seriesRows.length,
            truncated: false,
            maskedColumns: [],
            rowScopeApplied: [],
            durationMs: 2,
          };
        }
        return {
          columns: ["province", "name_vi", "total_orders", "return_rate"],
          rows: drillDownRows,
          rowCount: drillDownRows.length,
          truncated: false,
          maskedColumns: [],
          rowScopeApplied: [],
          durationMs: 2,
        };
      }
      throw new Error(`Unexpected tool ${tool}`);
    },
  };

  const queryExecutor = new ValidatedQueryExecutor({
    model: {
      invoke: async () => {
        throw new Error("Unexpected LLM invocation");
      },
      async *stream() {
        throw new Error("Unexpected LLM invocation");
      },
      withStructuredOutput: () => ({
        invoke: async () => {
          throw new Error("Unexpected LLM invocation");
        },
      }),
    },
    mcp,
    emitSpan: (event) =>
      emit({
        node: event.node,
        type: event.type,
        durationMs: event.durationMs ?? 0,
        payload: event.payload,
        attempt: event.attempt,
      }),
  });

  const historyStore = new InMemoryAlertHistoryStore();
  const digestQueue = new InMemoryDigestQueue();

  // 2. Run #1: Detect A1, drill down, dispatch critical alert, record in historyStore
  const t0 = Date.now();
  const run1 = await runAnomalyRunner({
    subscriptions: [subscription],
    targetDate: TARGET_DATE,
    manual: true,
    queryExecutor,
    queryPrincipal: {
      runId: RUN_ID,
      userId: "ops_lead",
      roleScope: "operations",
    },
    historyStore,
    digestQueue,
    dispatcherOptions: {
      transport: async () => ({ ok: true, status: 200 }),
    },
  });

  const slice1 = run1.sliceResults[0];
  emit({
    node: "anomaly_detector",
    type: "node_done",
    durationMs: Date.now() - t0,
    payload: {
      subscriptionId: subscription.id,
      metric: subscription.metricId,
      isAnomaly: slice1?.isAnomaly ?? false,
      severity: slice1?.severity ?? "none",
      zScore: slice1?.anomaly?.zScore ?? 0,
      wowPercent: slice1?.anomaly?.wowPercent ?? null,
    },
  });

  emit({
    node: "send_alert",
    type: "node_done",
    durationMs: 1,
    payload: {
      sent: slice1?.dispatchResult?.sent ?? false,
      fingerprint: slice1?.dispatchResult?.fingerprint ?? "",
      drilldownSegment: slice1?.alert?.drilldownSegment ?? "",
      sixFieldComplete: Boolean(slice1?.alert?.evidenceSql),
    },
  });

  // 3. Run #2 (same day): Verify 24h deduplication skips duplicate send
  const run2 = await runAnomalyRunner({
    subscriptions: [subscription],
    targetDate: TARGET_DATE,
    manual: true,
    queryExecutor,
    queryPrincipal: {
      runId: RUN_ID,
      userId: "ops_lead",
      roleScope: "operations",
    },
    historyStore,
    digestQueue,
    dispatcherOptions: {
      transport: async () => ({ ok: true, status: 200 }),
    },
  });

  emit({
    node: "dedup_check",
    type: "node_done",
    durationMs: 1,
    payload: {
      alertsSent: run2.alertsSent,
      alertsSkippedDuplicate: run2.alertsSkippedDuplicate,
      fingerprint: run2.sliceResults[0]?.dispatchResult?.fingerprint ?? "",
    },
  });

  // 4. Terminal run_done span
  const ok =
    run1.alertsSent === 1 &&
    run2.alertsSent === 0 &&
    run2.alertsSkippedDuplicate === 1;
  emit.emitRunDone(ok ? "ok" : "error");

  console.log(
    `trace ${traceFile} status=${ok ? "ok" : "error"} run1Sent=${run1.alertsSent} run2SkippedDup=${run2.alertsSkippedDuplicate}`,
  );
}

await main();
