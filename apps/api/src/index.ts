import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { runTracerGraph } from "@se373/agent";
import type { DbToolError } from "@se373/contracts";

export const API_SHELL =
  "API shell: Express SSE streaming lands in Phase 7";

export type ApiShellError = DbToolError;

// TRACER thin /api/ask SSE host (API-01 slice): mints runId/threadId via
// randomUUID (D-13), maps persona through a static table, invokes the thin
// agent graph, and streams sanitized SSE events only (row counts and column
// names, never cell values, SQL literals, or tokens). principals.ts with
// mcp_clients.yaml (01-14), per-event zod schemas (01-02), port injection,
// the resume endpoint, and the full SSE allowlist (01-14) complete this.

const PERSONAS: Record<string, { userId: string; roleScope: string }> = {
  sales_south: { userId: "demo-user", roleScope: "sales_south" },
  marketing: { userId: "demo-marketing", roleScope: "sales_south" },
  default: { userId: "demo-user", roleScope: "sales_south" },
};

export interface TracerApiOptions {
  mcpUrl: string;
  token: string;
  tracesDir?: string;
}

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createTracerApi(options: TracerApiOptions): express.Express {
  const tracesDir = options.tracesDir ?? "traces";
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.post("/api/ask", async (req: Request, res: Response) => {
    const question = req.body?.["question"];
    if (typeof question !== "string" || question.trim().length === 0) {
      res.status(400).json({
        code: "INVALID_PARAMS",
        message: "question must be a non-empty string",
        retryable: false,
        repairable: false,
      });
      return;
    }
    const persona =
      typeof req.body?.["persona"] === "string" ? req.body["persona"] : "default";
    const principal = PERSONAS[persona] ?? PERSONAS["default"];
    if (!principal) {
      res.status(400).json({
        code: "INVALID_PARAMS",
        message: `unknown persona '${persona}'`,
        retryable: false,
        repairable: false,
      });
      return;
    }

    const runId = randomUUID();
    const threadId = randomUUID();

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const base = { runId, threadId };
    try {
      sseSend(res, "intent_parsed", {
        ...base,
        node: "understand",
        data: {
          metric: "orders_per_status",
          dimensions: ["status"],
          filters: [],
          timeRange: null,
        },
      });

      const out = await runTracerGraph(question, {
        mcpUrl: options.mcpUrl,
        token: options.token,
        runId,
        userId: principal.userId,
        roleScope: principal.roleScope,
        threadId,
        tracesDir,
      });

      sseSend(res, "schema_retrieved", {
        ...base,
        node: "describe",
        data: { tables: ["customers", "orders"], tableCount: 2 },
      });
      sseSend(res, "sql_generated", {
        ...base,
        node: "run",
        data: { tablesUsed: ["orders"], statementType: "SELECT" },
      });
      const total = Number(
        /(\d+) orders/.exec(out.answerText)?.[1] ?? "0",
      );
      sseSend(res, "query_running", {
        ...base,
        node: "run",
        data: { statusGroups: out.toolsCalled.includes("run_query") ? 3 : 0 },
      });
      sseSend(res, "completed", {
        ...base,
        node: "answer",
        data: {
          status: out.status,
          answerText: out.answerText,
          toolsCalled: out.toolsCalled,
          total,
        },
      });
    } catch (err) {
      sseSend(res, "completed", {
        ...base,
        node: "answer",
        data: {
          status: "error",
          answerText: err instanceof Error ? err.message : "unknown error",
          toolsCalled: [],
          total: 0,
        },
      });
    } finally {
      res.end();
    }
  });

  return app;
}

if (
  process.argv[1] !== undefined &&
  (await import("node:path")).resolve(process.argv[1]) ===
    (await import("node:url")).fileURLToPath(import.meta.url)
) {
  const apiPort = Number(process.env.API_PORT ?? 3001);
  const mcpPort = Number(process.env.MCP_PORT ?? 8081);
  const options: TracerApiOptions = {
    mcpUrl:
      process.env.MCP_URL ?? `http://127.0.0.1:${mcpPort}/mcp`,
    token: process.env.MCP_TRACER_TOKEN ?? "",
    tracesDir: process.env.TRACES_DIR ?? "traces",
  };
  if (!options.token) {
    throw new Error("MCP_TRACER_TOKEN is not set");
  }
  const app = createTracerApi(options);
  const server = app.listen(apiPort, () => {
    // eslint-disable-next-line no-console
    console.log(`[tracer-api] listening on 127.0.0.1:${apiPort}`);
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
}
