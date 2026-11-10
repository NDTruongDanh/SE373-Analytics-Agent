process.loadEnvFile();

const required = [
  "AGENT_RO_DATABASE_URL",
  "MCP_TOKEN_ADMIN",
  "MCP_TOKEN_SALES_SOUTH",
  "MCP_TOKEN_MARKETING",
  "MCP_TOKEN_HR",
] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(`UC-05 live test requires .env values: ${missing.join(", ")}`);
}

const [{ startGatewayServer }, { createChatModel }, rca, { RCA_UC_ID }] =
  await Promise.all([
    import("../packages/mcp-server/src/server.js"),
    import("../packages/agent/src/models/factory.js"),
    import("../packages/agent/src/subgraphs/rootCauseAnalysis.js"),
    import("../packages/agent/src/constants.js"),
  ]);
const { buildBaselineQuery, createRcaRuntime, parseRcaIntent } = rca;

const question =
  process.argv.slice(2).join(" ") ||
  "Vì sao doanh thu thuần tháng 09/2026 giảm so với tháng 08/2026?";
const intent = parseRcaIntent(question);
const sqlResponses = [intent.baselinePeriod, intent.currentPeriod].map((period) =>
  JSON.stringify({
    sql: buildBaselineQuery(intent.metricName, intent.metricType, period),
    tablesUsed: ["orders", "order_items"],
  }),
);
const sqlModel = createChatModel("sql", { fake: { responses: sqlResponses } });
const runtime = createRcaRuntime({
  sqlModel: sqlModel as never,
});

const gateway = await startGatewayServer(0);
try {
  const address = gateway.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine the live MCP gateway port.");
  }
  const output = await runtime.entry(
    {
      question,
      ucId: RCA_UC_ID,
      toolsCalled: [],
    } as never,
    {
      emit: () => "",
      config: {
        configurable: {
          mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
          token: process.env["MCP_TOKEN_ADMIN"],
          runId: `uc05-live-${Date.now()}`,
          userId: "uc05-live-test",
          roleScope: "admin",
        },
      },
    },
  );

  if (output.status !== "ok" || !output.analysisPlan) {
    throw new Error(
      `UC-05 live baseline/planner failed: ${output.answerText || output.status}`,
    );
  }
  if (!output.toolsCalled?.includes("run_query")) {
    throw new Error("UC-05 live run did not execute SQL through the MCP gateway.");
  }
  if (output.analysisPlan.steps.some((step) => step.status !== "todo")) {
    throw new Error("UC-05 live plan contains a step that is not initialized as todo.");
  }

  console.log("UC-05 live baseline/planner: PASS");
  console.log(`Metric: ${output.analysisPlan.metricName}`);
  console.log(`Baseline: ${output.analysisPlan.baselineVal}`);
  console.log(`Current: ${output.analysisPlan.currentVal}`);
  console.log(`Delta: ${output.analysisPlan.absDelta}`);
  console.log(`Steps initialized: ${output.analysisPlan.steps.length}`);
  console.log(`Tools called: ${output.toolsCalled.join(", ")}`);
} finally {
  await new Promise<void>((resolve, reject) => {
    gateway.close((error) => (error ? reject(error) : resolve()));
  });
}
