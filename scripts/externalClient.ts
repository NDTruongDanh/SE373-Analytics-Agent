import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DEMO_SQL =
  "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status";

function fail(leg: string, detail: string): never {
  console.log(`[external-client] FAIL ${leg}: ${detail}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: MCP_PORT=8081 MCP_TOKEN=$MCP_TOKEN_SALES_SOUTH pnpm external-client");
    console.log("Manual Inspector steps are in the header comment of scripts/externalClient.ts.");
    return;
  }
  const port = Number(process.env.MCP_PORT ?? 8081);
  const token = process.env.MCP_TOKEN ?? "";
  if (!token) {
    fail("config", "MCP_TOKEN is not set (use a token env from policies/mcp_clients.yaml)");
  }
  const url = `http://127.0.0.1:${port}/mcp`;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: `Bearer ${token}` },
    },
  });
  const client = new Client({ name: "se373-external-client", version: "1.0.0" });
  try {
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    if (
      JSON.stringify(names) !==
      JSON.stringify([
        "list_tables",
        "describe_table",
        "explain_query",
        "run_query",
        "sample_rows",
        "search_semantic_layer",
      ])
    ) {
      fail("list", `unexpected tool list: ${JSON.stringify(names)}`);
    }

    const tables = await client.callTool({ name: "list_tables", arguments: {} });
    if (tables.isError === true) {
      fail("scoped-ok", `list_tables errored: ${JSON.stringify(tables.content)}`);
    }
    const run = await client.callTool({
      name: "run_query",
      arguments: { sql: DEMO_SQL, maxRows: 200 },
    });
    if (run.isError === true) {
      fail("scoped-ok", `run_query errored: ${JSON.stringify(run.content)}`);
    }
    const text = (run.content as { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("");
    const payload = JSON.parse(text) as { rows?: unknown[] };
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
      fail("scoped-ok", "run_query returned no rows");
    }
    console.log("[external-client] scoped-ok PASS (list_tables + run_query)");

    const smoking = await client.callTool({
      name: "run_query",
      arguments: { sql: "DELETE FROM public.orders", maxRows: 10 },
    });
    const smokingText = JSON.stringify(smoking.content);
    if (smoking.isError !== true || !smokingText.includes("FORBIDDEN_STATEMENT")) {
      fail("delete-blocked", `expected FORBIDDEN_STATEMENT, got: ${smokingText.slice(0, 200)}`);
    }
    console.log("[external-client] delete-blocked PASS (FORBIDDEN_STATEMENT)");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[external-client]")) throw error;
    fail("connect", error instanceof Error ? error.message : String(error));
  } finally {
    await client.close();
  }
}

await main().catch((error: unknown) => {
  if (error instanceof Error && error.message.startsWith("[external-client]")) {
    process.exit(1);
  }
  fail("connect", error instanceof Error ? error.message : String(error));
});
