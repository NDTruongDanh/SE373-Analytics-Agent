import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLockPool } from "../apps/api/src/ports.js";

interface CheckResult {
  name: string;
  severity: "required" | "recommended";
  ok: boolean;
  detail: string;
}

interface PreflightArgs {
  apiUrl: string;
  mcpUrl: string;
  skipHttp: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): PreflightArgs {
  const apiPort = process.env["API_PORT"] ?? "3001";
  const mcpPort = process.env["MCP_PORT"] ?? "8081";
  const out: PreflightArgs = {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    mcpUrl: `http://127.0.0.1:${mcpPort}`,
    skipHttp: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--skip-http") {
      out.skipHttp = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--api-url" && argv[i + 1]) {
      out.apiUrl = argv[++i] as string;
    } else if (arg === "--mcp-url" && argv[i + 1]) {
      out.mcpUrl = argv[++i] as string;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: pnpm verify:preflight [--api-url <url>] [--mcp-url <url>] [--skip-http] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function checkEnvVar(
  name: string,
  severity: "required" | "recommended",
  hint: string,
): CheckResult {
  const val = process.env[name];
  const ok = typeof val === "string" && val.trim().length > 0;
  return {
    name: `env:${name}`,
    severity,
    ok,
    detail: ok ? "set" : `missing (${hint})`,
  };
}

async function checkHttpHealth(
  name: string,
  url: string,
): Promise<CheckResult> {
  const target = new URL("/healthz", url).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(target, { signal: controller.signal });
    const body = await res.text();
    const ok = res.ok;
    return {
      name,
      severity: "required",
      ok,
      detail: ok
        ? `HTTP ${res.status} (${target})`
        : `HTTP ${res.status}: ${body.slice(0, 120)}`,
    };
  } catch (error) {
    return {
      name,
      severity: "required",
      ok: false,
      detail: `unreachable at ${target} (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkDatabase(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const agentRoUrl = process.env["AGENT_RO_DATABASE_URL"] ?? "";
  const harnessStateUrl = process.env["HARNESS_STATE_DATABASE_URL"] ?? "";

  if (agentRoUrl) {
    const pool = createLockPool(agentRoUrl);
    try {
      const tablesRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const tableCount = Number(tablesRes.rows[0]?.["n"] ?? 0);
      results.push({
        name: "db:public_tables",
        severity: "required",
        ok: tableCount >= 8,
        detail: `${tableCount} public tables (PRD requires >= 8)`,
      });

      const itemsRes = await pool.query(
        `SELECT COUNT(*)::bigint AS n FROM public.order_items`,
      );
      const itemCount = Number(itemsRes.rows[0]?.["n"] ?? 0);
      results.push({
        name: "db:order_items_scale",
        severity: "recommended",
        ok: itemCount >= 1_000_000,
        detail:
          itemCount >= 1_000_000
            ? `${itemCount.toLocaleString("en-US")} rows (full PRD scale)`
            : `${itemCount.toLocaleString("en-US")} rows (< 1,000,000; reload full scale with pnpm data:load before final verification)`,
      });

      const chunksRes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM semantic.semantic_chunks`,
      );
      const chunkCount = Number(chunksRes.rows[0]?.["n"] ?? 0);
      results.push({
        name: "db:semantic_chunks",
        severity: "required",
        ok: chunkCount > 0,
        detail:
          chunkCount > 0
            ? `${chunkCount} indexed semantic chunks`
            : "0 chunks; run pnpm semantic:index",
      });
    } catch (error) {
      results.push({
        name: "db:agent_ro_connection",
        severity: "required",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  if (harnessStateUrl) {
    const pool = createLockPool(harnessStateUrl);
    try {
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM app_state.mcp_audit_log`,
      );
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM app_state.alert_history`,
      );
      results.push({
        name: "db:harness_state_tables",
        severity: "required",
        ok: true,
        detail:
          "app_state.mcp_audit_log and app_state.alert_history accessible as harness_state",
      });
    } catch (error) {
      results.push({
        name: "db:harness_state_tables",
        severity: "required",
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)} (run pnpm db:migrate)`,
      });
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  return results;
}

async function main(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile?.();
  }
  const args = parseArgs(process.argv.slice(2));
  const checks: CheckResult[] = [
    checkEnvVar(
      "AGENT_MODEL_API_KEY",
      "required",
      "needed to run against a real LLM instead of FakeListChatModel",
    ),
    checkEnvVar(
      "AGENT_MODEL_BASE_URL",
      "recommended",
      "set if using an OpenAI-compatible provider",
    ),
    checkEnvVar(
      "EMBEDDING_API_KEY",
      "recommended",
      "unset falls back to deterministic fake embeddings",
    ),
    checkEnvVar(
      "EMBEDDING_MODEL_ID",
      "recommended",
      "required with EMBEDDING_API_KEY for real dense retrieval",
    ),
    checkEnvVar(
      "AGENT_RO_DATABASE_URL",
      "required",
      "read-only DB URL for MCP gateway",
    ),
    checkEnvVar(
      "HARNESS_STATE_DATABASE_URL",
      "required",
      "checkpoint + audit state DB URL",
    ),
    checkEnvVar(
      "INDEXER_DATABASE_URL",
      "recommended",
      "required for semantic re-indexing",
    ),
    checkEnvVar(
      "MCP_TOKEN_SALES_SOUTH",
      "required",
      "role token from policies/mcp_clients.yaml",
    ),
    checkEnvVar(
      "MCP_TOKEN_MARKETING",
      "required",
      "role token from policies/mcp_clients.yaml",
    ),
    checkEnvVar(
      "MCP_TOKEN_HR",
      "required",
      "role token from policies/mcp_clients.yaml",
    ),
    checkEnvVar(
      "MCP_TOKEN_ADMIN",
      "required",
      "role token from policies/mcp_clients.yaml",
    ),
    checkEnvVar(
      "MCP_TOKEN_EVAL_SCOPE",
      "recommended",
      "required for pnpm eval --uc uc09 scope denial test",
    ),
  ];

  checks.push(...(await checkDatabase()));

  if (!args.skipHttp) {
    checks.push(await checkHttpHealth("http:mcp_gateway", args.mcpUrl));
    checks.push(await checkHttpHealth("http:api_host", args.apiUrl));
  }

  const requiredFailed = checks.filter(
    (c) => c.severity === "required" && !c.ok,
  );
  const warnings = checks.filter((c) => c.severity === "recommended" && !c.ok);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: requiredFailed.length === 0,
          requiredFailed: requiredFailed.length,
          warnings: warnings.length,
          checks,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("SE373 Analytics Agent — Live Verification Preflight");
    for (const c of checks) {
      const badge = c.ok ? "PASS" : c.severity === "required" ? "FAIL" : "WARN";
      console.log(`  [${badge}] ${c.name}: ${c.detail}`);
    }
    console.log(
      `\nSummary: ${checks.length - requiredFailed.length - warnings.length} passed, ${warnings.length} warnings, ${requiredFailed.length} required failures.`,
    );
  }

  process.exit(requiredFailed.length === 0 ? 0 : 1);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
