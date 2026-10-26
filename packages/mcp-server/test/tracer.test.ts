import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  authenticateRequest,
  requireScope,
  type TracerPrincipal,
} from "../src/auth.js";
import { createTracerApp, maskPiiText } from "../src/server.js";

// Tracer slice: token rejection, scope denial, zod bounds, non-SELECT
// rejection, truncated flag. DB legs skip without AGENT_RO_DATABASE_URL so
// the suite stays green with Docker stopped (01-03 owns the test-script
// build-first pass; run `pnpm typecheck` before these tests so workspace
// dist exists).

process.env.MCP_TRACER_TOKEN ??= "tracer-test-token";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEMO_SQL =
  "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status";
const HAS_DB = Boolean(process.env.AGENT_RO_DATABASE_URL);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${process.env.MCP_TRACER_TOKEN}`,
    "x-run-id": "test-run-1",
    "x-user-id": "demo-user",
    "x-role-scope": "sales_south",
    ...extra,
  };
}

describe("tracer auth", () => {
  it("rejects a missing Bearer token", () => {
    const result = authenticateRequest({});
    expect("error" in result && result.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a wrong Bearer token", () => {
    const result = authenticateRequest({ authorization: "Bearer nope" });
    expect("error" in result && result.error.code).toBe("UNAUTHORIZED");
  });

  it("accepts the configured token with both demo scopes", () => {
    const result = authenticateRequest(headers());
    expect("principal" in result).toBe(true);
    if ("principal" in result) {
      expect(result.principal.scopes).toEqual(
        expect.arrayContaining(["schema:read", "data:read"]),
      );
    }
  });

  it("denies run_query scope for a metadata-only principal", () => {
    const narrow: TracerPrincipal = {
      clientId: "tracer-demo",
      userId: "demo-user",
      role: "sales_south",
      scopes: ["schema:read"],
    };
    expect(requireScope(narrow, "data:read")?.code).toBe("SCOPE_DENIED");
    expect(requireScope(narrow, "schema:read")).toBeNull();
  });
});

describe("tracer PII mask", () => {
  it("masks seed phones and emails but leaves timestamps alone", () => {
    const masked = maskPiiText("call 0901111111 or an.nguyen@example.vn");
    expect(masked.text).toBe("call MASKED_PHONE or MASKED_EMAIL");
    expect(masked.hits).toBe(2);
    const stamp = maskPiiText("2025-06-01 10:00:00");
    expect(stamp.text).toBe("2025-06-01 10:00:00");
    expect(stamp.hits).toBe(0);
  });
});

describe("tracer PII canary", () => {
  const seedPhones = [
    "0901111111",
    "0902222222",
    "0903333333",
    "0904444444",
    "0905555555",
  ];
  const seedEmails = [
    "an.nguyen@example.vn",
    "bich.tran@example.vn",
    "cuong.le@example.vn",
    "dung.pham@example.vn",
    "em.hoang@example.vn",
  ];

  it("masks seed phones and emails on the audit path", () => {
    const masked = maskPiiText(`contact ${seedPhones[0]} or ${seedEmails[0]}`);
    expect(masked.text).toContain("MASKED_PHONE");
    expect(masked.text).toContain("MASKED_EMAIL");
    expect(masked.text).not.toContain(seedPhones[0]);
    expect(masked.text).not.toContain(seedEmails[0]);
  });

  it("binds loopback only, never 0.0.0.0", () => {
    const compose = readFileSync(
      path.resolve(HERE, "../../../docker/docker-compose.yml"),
      "utf8",
    );
    const effective = compose
      .split("\n")
      .map((line) => line.split("#")[0] ?? "")
      .join("\n");
    expect(effective).toContain("127.0.0.1:5433");
    expect(effective).not.toContain("0.0.0.0");
  });

  // Skip-safe: on a fresh checkout (no demo run yet) there is no trace or
  // audit artifact to scan — the demo script itself greps its own trace.
  const tracesDir = path.resolve(HERE, "../../../traces");
  const auditPath = path.resolve(HERE, "../../../logs/mcp_audit.jsonl");
  const hasArtifacts =
    existsSync(tracesDir) &&
    readdirSync(tracesDir).some((f) => f.endsWith(".jsonl")) &&
    existsSync(auditPath);

  it.skipIf(!hasArtifacts)("finds no raw seed PII in demo trace or audit", () => {
    const traceText = readdirSync(tracesDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(path.join(tracesDir, f), "utf8"))
      .join("\n");
    const auditText = readFileSync(auditPath, "utf8");
    for (const literal of [...seedPhones, ...seedEmails]) {
      expect(traceText).not.toContain(literal);
      expect(auditText).not.toContain(literal);
    }
  });
});

describe("tracer MCP server", () => {
  let baseUrl = "";
  let auditPath = "";
  let server: { close: (cb?: () => void) => void } | null = null;

  beforeAll(async () => {
    auditPath = path.join(mkdtempSync(path.join(tmpdir(), "tracer-")), "audit.jsonl");
    const app = await createTracerApp({ auditPath });
    await new Promise<void>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve());
      server = s;
    });
    const address = (server as unknown as { address: () => AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
  });

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ text: string; isError?: boolean }> {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { ...headers(), ...extraHeaders } },
    });
    const client = new Client({ name: "tracer-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      const block = (result.content as { type: string; text?: string }[])[0];
      return { text: block.text ?? "", isError: result.isError };
    } finally {
      await client.close();
    }
  }

  it("returns 401 without a Bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("rejects non-SELECT statements before touching the DB", async () => {
    const out = await callTool("run_query", { sql: "DROP TABLE orders" });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.text)).toMatchObject({ code: "FORBIDDEN_STATEMENT" });
  });

  it("enforces zod bounds on maxRows", async () => {
    const out = await callTool("run_query", { sql: DEMO_SQL, maxRows: 5000 });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("maxRows");
  });

  it.skipIf(!HAS_DB)("lists tables with sensitivity flags", async () => {
    const out = await callTool("list_tables", {});
    expect(out.isError).toBeFalsy();
    const payload = JSON.parse(out.text) as {
      tables: { name: string; columns: { name: string; sensitive: boolean }[] }[];
    };
    const names = payload.tables.map((t) => t.name);
    expect(names).toContain("customers");
    expect(names).toContain("orders");
    const customers = payload.tables.find((t) => t.name === "customers");
    const flags = Object.fromEntries(
      (customers?.columns ?? []).map((c) => [c.name, c.sensitive]),
    );
    expect(flags["phone"]).toBe(true);
    expect(flags["email"]).toBe(true);
    expect(flags["address"]).toBe(true);
  });

  it.skipIf(!HAS_DB)("runs the demo query with truncated=false", async () => {
    const out = await callTool("run_query", { sql: DEMO_SQL });
    expect(out.isError).toBeFalsy();
    const payload = JSON.parse(out.text) as {
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
    };
    expect(payload.truncated).toBe(false);
    expect(payload.rowCount).toBe(3);
    expect(payload.columns).toEqual(["status", "n"]);
  });

  it.skipIf(!HAS_DB)("sets truncated when rows exceed maxRows", async () => {
    const out = await callTool("run_query", { sql: DEMO_SQL, maxRows: 1 });
    const payload = JSON.parse(out.text) as { rowCount: number; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.rowCount).toBe(1);
  });

  it.skipIf(!HAS_DB)("audits with the per-call runId and no raw PII", async () => {
    await callTool("run_query", { sql: DEMO_SQL }, { "x-run-id": "audit-probe" });
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]) as {
      runId: string;
      tool: string;
      decision: string;
    };
    expect(last.runId).toBe("audit-probe");
    expect(last.tool).toBe("run_query");
    expect(last.decision).toBe("allow");
    const whole = lines.join("\n");
    for (const phone of ["0901111111", "0902222222", "0903333333", "0904444444", "0905555555"]) {
      expect(whole).not.toContain(phone);
    }
  });
});
