import {
  InMemoryAlertHistoryStore,
  runAnomalyRunner,
  loadSubscriptionsConfigFile,
  type AlertQueryExecutor,
} from "@shared/agent";

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

  // This standalone demo has no MCP connection; production callers inject
  // their configured ValidatedQueryExecutor and durable AppStateStore.
  const mockQueryExecutor: AlertQueryExecutor = {
    run: async (input) => {
      if (!input.initialSql) {
        throw new Error("alert demo expected a deterministic SQL proposal");
      }
      return {
        status: "no_data",
        sql: input.initialSql,
        tablesUsed: input.candidateTables,
        columns: [],
        rows: [],
        maskedColumns: [],
        attempts: 1,
      };
    },
  };

  const result = await runAnomalyRunner({
    targetDate,
    manual,
    flushDigest,
    subscriptionId,
    queryExecutor: mockQueryExecutor,
    queryPrincipal: {
      runId: "alert-demo",
      userId: "demo-user",
      roleScope: "demo",
    },
    historyStore: new InMemoryAlertHistoryStore(),
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
}

main().catch((err) => {
  console.error("Fatal runner error:", err);
  process.exit(1);
});
