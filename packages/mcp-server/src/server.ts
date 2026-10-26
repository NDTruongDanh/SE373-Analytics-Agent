import express from "express";
import type { Request, Response } from "express";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListTablesInputSchema,
  RunQueryInputSchema,
  dbToolError,
} from "@se373/contracts";
import { tracerPrecheck } from "@se373/access-policy";
import {
  authenticateRequest,
  readRunContext,
  requireScope,
  type TracerPrincipal,
} from "./auth.js";
import { executeReadOnly } from "./executor.js";

// TRACER MCP server (MCP-01/MCP-03 slice): exactly 2 tools — list_tables and
// run_query — through the fixed stage order auth → scope → zod →
// tracerPrecheck → TRACER-allow → executor → inline PII scan → audit.
// (zod runs inside the SDK transport just before the handler; the handler
// itself runs scope → precheck → allow in the plan order.) The AccessPolicy
// stage (01-06/01-08) is a TRACER-allow pass-through here.

// TRACER inline PII handling (T-01-02): narrow VN mobile + email patterns.
// Timestamps and numeric totals never match. The shared redactor from 01-06
// replaces this.
const PHONE_RE = /\b0(?:3|5|7|8|9)\d{8}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function maskPiiText(value: string): { text: string; hits: number } {
  let hits = 0;
  const text = value
    .replace(PHONE_RE, () => {
      hits += 1;
      return "MASKED_PHONE";
    })
    .replace(EMAIL_RE, () => {
      hits += 1;
      return "MASKED_EMAIL";
    });
  return { text, hits };
}

export function maskPiiRows(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[];
  maskedColumns: string[];
  hits: number;
} {
  const masked = new Set<string>();
  let hits = 0;
  const out = rows.map((row) => {
    const masked_row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string") {
        const masked_value = maskPiiText(value);
        masked_row[key] = masked_value.text;
        if (masked_value.hits > 0) {
          masked.add(key);
          hits += masked_value.hits;
        }
      } else {
        masked_row[key] = value;
      }
    }
    return masked_row;
  });
  return { rows: out, maskedColumns: [...masked], hits };
}

// TRACER static sensitivity, derived from the CONT-08 catalog shape.
// Catalog-driven policy lands in 01-06/01-08.
const SENSITIVE_COLUMNS: Record<string, Set<string>> = {
  customers: new Set(["phone", "email", "address"]),
};

function isSensitive(table: string, column: string): boolean {
  return SENSITIVE_COLUMNS[table]?.has(column) ?? false;
}

interface AuditLine {
  ts: string;
  runId: string;
  userId: string;
  role: string;
  clientId: string;
  scopes: string[];
  tool: string;
  params: unknown;
  rowCount: number;
  durationMs: number;
  piiHits: number;
  decision: "allow" | "deny";
  errorCode?: string;
}

export interface TracerAppOptions {
  auditPath?: string;
}

function errorPayload(message: string, code: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
    _tracerErrorCode: code,
  };
}

export async function createTracerApp(
  options: TracerAppOptions = {},
): Promise<express.Express> {
  const auditPath = options.auditPath ?? path.resolve("logs/mcp_audit.jsonl");
  mkdirSync(path.dirname(auditPath), { recursive: true });

  function audit(line: AuditLine): void {
    // Audit sink is PII-redacted before write (T-01-02): mask the serialized
    // line so SQL text or header values can never leak raw PII.
    const masked = maskPiiText(JSON.stringify(line)).text;
    appendFileSync(auditPath, `${masked}\n`, "utf8");
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // NOTE (SDK 1.32.2): a stateless StreamableHTTPServerTransport instance is
  // single-use ("Stateless transport cannot be reused across requests"), and
  // McpServer.connect() refuses a second transport. So each POST builds a
  // fresh server + transport pair — true stateless semantics, negligible cost
  // at tracer scale. A shared stateful transport lands with sessions in 01-08
  // if the gateway needs it.
  function buildMcpServer(): McpServer {
    const server = new McpServer(
      { name: "se373-tracer-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

  server.registerTool(
    "list_tables",
    {
      description: "List public tables with columns and sensitivity flags",
      inputSchema: ListTablesInputSchema.shape,
    },
    async (_args, extra) => {
      const started = Date.now();
      const headers = extra.requestInfo?.headers ?? {};
      const auth = authenticateRequest(headers);
      if ("error" in auth) {
        return errorPayload(JSON.stringify(auth.error), auth.error.code);
      }
      const principal: TracerPrincipal = auth.principal;
      const scopeError = requireScope(principal, "schema:read");
      if (scopeError) {
        return errorPayload(JSON.stringify(scopeError), scopeError.code);
      }
      const ctx = readRunContext(headers, principal);
      const tablesResult = await executeReadOnly(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        200,
      );
      if ("error" in tablesResult) {
        audit({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          userId: ctx.userId,
          role: principal.role,
          clientId: principal.clientId,
          scopes: principal.scopes,
          tool: "list_tables",
          params: {},
          rowCount: 0,
          durationMs: Date.now() - started,
          piiHits: 0,
          decision: "deny",
          errorCode: tablesResult.error.code,
        });
        return errorPayload(
          JSON.stringify(tablesResult.error),
          tablesResult.error.code,
        );
      }
      const columnsResult = await executeReadOnly(
        "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
        1000,
      );
      if ("error" in columnsResult) {
        return errorPayload(
          JSON.stringify(columnsResult.error),
          columnsResult.error.code,
        );
      }
      const byTable = new Map<string, unknown[]>();
      for (const row of columnsResult.rows) {
        const table = String(row["table_name"]);
        const list = byTable.get(table) ?? [];
        list.push({
          name: String(row["column_name"]),
          type: String(row["data_type"]),
          nullable: row["is_nullable"] === "YES",
          sensitive: isSensitive(table, String(row["column_name"])),
        });
        byTable.set(table, list);
      }
      const tables = tablesResult.rows.map((row) => {
        const name = String(row["table_name"]);
        return { name, schema: "public", columns: byTable.get(name) ?? [] };
      });
      const payload = JSON.stringify({ tables });
      audit({
        ts: new Date().toISOString(),
        runId: ctx.runId,
        userId: ctx.userId,
        role: principal.role,
        clientId: principal.clientId,
        scopes: principal.scopes,
        tool: "list_tables",
        params: {},
        rowCount: tables.length,
        durationMs: Date.now() - started,
        piiHits: 0,
        decision: "allow",
      });
      return { content: [{ type: "text" as const, text: payload }] };
    },
  );

  server.registerTool(
    "run_query",
    {
      description: "Run a read-only SELECT against the tracer dataset",
      inputSchema: RunQueryInputSchema.shape,
    },
    async (args, extra) => {
      const started = Date.now();
      const headers = extra.requestInfo?.headers ?? {};
      const auth = authenticateRequest(headers);
      if ("error" in auth) {
        return errorPayload(JSON.stringify(auth.error), auth.error.code);
      }
      const principal: TracerPrincipal = auth.principal;
      const scopeError = requireScope(principal, "data:read");
      if (scopeError) {
        return errorPayload(JSON.stringify(scopeError), scopeError.code);
      }
      const ctx = readRunContext(headers, principal);
      const params = { sql: args.sql, maxRows: args.maxRows ?? 200 };
      const precheck = tracerPrecheck(params.sql);
      if (!precheck.ok) {
        const err = dbToolError(
          "FORBIDDEN_STATEMENT",
          precheck.error ?? "statement rejected",
        );
        audit({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          userId: ctx.userId,
          role: principal.role,
          clientId: principal.clientId,
          scopes: principal.scopes,
          tool: "run_query",
          params,
          rowCount: 0,
          durationMs: Date.now() - started,
          piiHits: 0,
          decision: "deny",
          errorCode: err.code,
        });
        return errorPayload(JSON.stringify(err), err.code);
      }
      // TRACER-allow: the AccessPolicy stage (01-06/01-08) replaces this.
      const result = await executeReadOnly(params.sql, params.maxRows);
      if ("error" in result) {
        audit({
          ts: new Date().toISOString(),
          runId: ctx.runId,
          userId: ctx.userId,
          role: principal.role,
          clientId: principal.clientId,
          scopes: principal.scopes,
          tool: "run_query",
          params,
          rowCount: 0,
          durationMs: Date.now() - started,
          piiHits: 0,
          decision: "deny",
          errorCode: result.error.code,
        });
        return errorPayload(JSON.stringify(result.error), result.error.code);
      }
      const masked = maskPiiRows(result.rows);
      const payload = JSON.stringify({
        columns: result.columns,
        rows: masked.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        maskedColumns: masked.maskedColumns,
        durationMs: result.durationMs,
      });
      audit({
        ts: new Date().toISOString(),
        runId: ctx.runId,
        userId: ctx.userId,
        role: principal.role,
        clientId: principal.clientId,
        scopes: principal.scopes,
        tool: "run_query",
        params,
        rowCount: result.rowCount,
        durationMs: Date.now() - started,
        piiHits: masked.hits,
        decision: "allow",
      });
      return { content: [{ type: "text" as const, text: payload }] };
    },
  );

    return server;
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    // Stage 1 (auth) at the HTTP layer: no valid Bearer, no MCP dispatch.
    const auth = authenticateRequest(req.headers as Record<string, string>);
    if ("error" in auth) {
      res.status(401).json(auth.error);
      return;
    }
    const requestTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await buildMcpServer().connect(requestTransport);
    try {
      await requestTransport.handleRequest(req, res, req.body);
    } finally {
      await requestTransport.close();
    }
  });
  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json(dbToolError("INVALID_PARAMS", "use POST /mcp"));
  });

  return app;
}

export async function startTracerServer(
  port: number,
  options: TracerAppOptions = {},
) {
  if (!process.env.MCP_TRACER_TOKEN) {
    throw new Error("MCP_TRACER_TOKEN is not set");
  }
  const app = await createTracerApp(options);
  const server = app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[tracer-mcp] listening on 127.0.0.1:${port}`);
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  return server;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.MCP_PORT ?? 8081);
  await startTracerServer(port);
}
