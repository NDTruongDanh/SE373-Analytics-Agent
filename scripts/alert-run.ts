import { existsSync } from "node:fs";
import {
  InMemoryAlertHistoryStore,
  runAnomalyRunner,
  loadSubscriptionsConfigFile,
  type AlertHistoryStore,
} from "@shared/agent";
import {
  ValidatedQueryExecutor,
  type McpToolCaller,
} from "@shared/agent/queryExecutor";
import { callMcpTool, type TracerRunConfig } from "../packages/agent/src/mcpClient.js";
import { AppStateStore } from "../apps/api/src/store/alertStore.js";

// Try loading local .env if available
try {
  if (existsSync(".env")) {
    process.loadEnvFile?.();
  }
} catch {
  // Ignored if .env cannot be loaded
}

function parseArgs(): {
  manual: boolean;
  date?: string;
  flushDigest: boolean;
  subscriptionId?: string;
} {
  const args = process.argv.slice(2);
  let manual = true;
  let date: string | undefined;
  let flushDigest = false;
  let subscriptionId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--manual") {
      manual = true;
    } else if (arg === "--date" && i + 1 < args.length) {
      date = args[++i];
    } else if (arg === "--flush-digest") {
      flushDigest = true;
    } else if (arg === "--subscription" && i + 1 < args.length) {
      subscriptionId = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: pnpm alert:run [options]

Options:
  --manual              Run the anomaly detection workflow manually (default)
  --date <YYYY-MM-DD>   Target evaluation date (defaults to today)
  --flush-digest        Flush queued warning/info digests immediately
  --subscription <id>   Filter by specific subscription ID
  --help, -h            Show this help message
`);
      process.exit(0);
    }
  }

  return { manual, date, flushDigest, subscriptionId };
}

function createMcpToolCaller(transport: TracerRunConfig): McpToolCaller {
  return {
    call: async (tool, args) => {
      const toolArgs = { ...args };
      delete toolArgs["runId"];
      delete toolArgs["userId"];
      delete toolArgs["roleScope"];
      const result = await callMcpTool(transport, tool, toolArgs);
      if (result.isError) {
        throw new Error(`MCP tool ${tool} error: ${result.text}`);
      }
      return JSON.parse(result.text) as unknown;
    },
  };
}

async function main(): Promise<void> {
  const { manual, date, flushDigest, subscriptionId } = parseArgs();
  const targetDate = date ?? new Date().toISOString().slice(0, 10);

  console.log("=================================================");
  console.log("  SE373 Analytics Agent - Anomaly & Alert Runner ");
  console.log("=================================================");
  console.log(`Target Date: ${targetDate}`);
  console.log(`Manual Mode: ${manual}`);
  console.log(`Flush Digest: ${flushDigest}`);
  if (subscriptionId) {
    console.log(`Subscription Filter: ${subscriptionId}`);
  }
  console.log("-------------------------------------------------");

  // Load subscriptions to preview
  try {
    const config = loadSubscriptionsConfigFile();
    console.log(`Loaded ${config.subscriptions.length} subscription(s) from config/subscriptions.yaml`);
  } catch (err) {
    console.warn(`Could not load subscriptions file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mcpPort = process.env.MCP_PORT ?? "8081";
  const mcpUrl = process.env.MCP_URL ?? `http://127.0.0.1:${mcpPort}/mcp`;
  const mcpToken = process.env.MCP_TOKEN_ADMIN ?? process.env.MCP_TRACER_TOKEN ?? "dev-admin-token";

  const runId = `alert-run-${Date.now()}`;
  const userId = "alert-runner-cron";
  const roleScope = "admin";

  const transport: TracerRunConfig = {
    mcpUrl,
    token: mcpToken,
    runId,
    userId,
    roleScope,
  };

  const mcpCaller = createMcpToolCaller(transport);

  // ValidatedQueryExecutor: uses fake deterministic model for alert queries since
  // alert time-series and drill-down queries provide deterministic initialSql
  const queryExecutor = new ValidatedQueryExecutor({
    model: {
      withStructuredOutput: () => ({
        invoke: async () => {
          throw new Error("Unexpected LLM invocation in deterministic alert query execution");
        },
      }),
    },
    mcp: mcpCaller,
  });

  // History Store: use durable AppStateStore when HARNESS_STATE_DATABASE_URL is set,
  // falling back to InMemoryAlertHistoryStore in DB-less/demo environments.
  const harnessConn = process.env.HARNESS_STATE_DATABASE_URL;
  let durableStore: AppStateStore | undefined;
  let historyStore: AlertHistoryStore;

  if (harnessConn) {
    try {
      durableStore = new AppStateStore(harnessConn);
      historyStore = durableStore;
      console.log("Using durable AppStateStore (app_state.alert_history)");
    } catch (e) {
      console.warn("Could not instantiate AppStateStore, falling back to InMemoryAlertHistoryStore:", e);
      historyStore = new InMemoryAlertHistoryStore();
    }
  } else {
    console.log("HARNESS_STATE_DATABASE_URL not set; using InMemoryAlertHistoryStore");
    historyStore = new InMemoryAlertHistoryStore();
  }

  try {
    const result = await runAnomalyRunner({
      targetDate,
      manual,
      flushDigest,
      subscriptionId,
      queryExecutor,
      queryPrincipal: {
        runId,
        userId,
        roleScope,
      },
      historyStore,
      logger: (msg, meta) => console.log(`[ALERT] ${msg}`, meta ?? ""),
    });

    console.log("\n================ Run Summary ================");
    console.log(`Total Subscriptions:    ${result.totalSubscriptions}`);
    console.log(`Evaluated:              ${result.evaluatedSubscriptions}`);
    console.log(`Anomalies Detected:     ${result.anomaliesDetected}`);
    console.log(`Alerts Sent:            ${result.alertsSent}`);
    console.log(`Alerts Queued:          ${result.alertsQueued}`);
    console.log(`Alerts Deduplicated:    ${result.alertsSkippedDuplicate}`);
    console.log(`Alerts Blocked (PII):   ${result.alertsBlocked}`);
    console.log(`Failures:               ${result.failures.length}`);

    if (result.sliceResults.length > 0) {
      console.log("\n---------------- Slices ----------------");
      for (const slice of result.sliceResults) {
        const icon = slice.isAnomaly ? "⚠️" : "✓";
        console.log(
          `${icon} [${slice.subscriptionId}] ${slice.metricId} -> ${slice.status} (Severity: ${slice.severity})`,
        );
        if (slice.drillDown) {
          console.log(`   Segment: ${slice.drillDown.drilldownSegment}`);
          console.log(`   SQL:     ${slice.drillDown.evidenceSql}`);
        }
      }
    }

    console.log("=============================================\n");
  } finally {
    if (durableStore) {
      await durableStore.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error("Fatal runner error:", err);
  process.exit(1);
});
