// pnpm external-client — MCP-09 scoped-token demo plus Inspector manual steps.
// Uses the MCP SDK Client over StreamableHTTPClientTransport with a bearer
// token read from the environment (never hardcoded): it calls list_tables
// then run_query with the scoped token and prints the sanitized result, then
// sends a DELETE through run_query and asserts the FORBIDDEN_STATEMENT
// denial. Exits 0 with PASS lines on both legs, 1 naming the failing leg.
//
// Manual Inspector steps (same coverage, by hand):
//   export MCP_TOKEN="$MCP_TOKEN_SALES_SOUTH"
//   npx -y @modelcontextprotocol/inspector@2.12.0
// Connect to transport type "Streamable HTTP" at
// http://127.0.0.1:8081/mcp with header
// `Authorization: Bearer $MCP_TOKEN`, then:
//   1. tools/list must show the 6 db-tools (list_tables, describe_table,
//      explain_query, run_query, sample_rows, search_semantic_layer).
//   2. Call list_tables with {} as sales_south: ok, tables listed.
//   3. Call run_query with a scoped SELECT: ok, masked rows.
//   4. Call run_query with `DELETE FROM public.orders`: FORBIDDEN_STATEMENT.
//   5. resources/list must show semantic://data-dictionary and
//      semantic://metrics; reading metrics as sales_south withholds the
//      restricted section, as hr it is present.
// Never paste tokens into Inspector URLs on shared machines — pass them as
// headers only.

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
