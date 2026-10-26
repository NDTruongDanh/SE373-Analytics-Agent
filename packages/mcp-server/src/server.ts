// MCP database gateway (MCP-01..09): 5 db-tools plus search_semantic_layer
// plus 2 role-filtered semantic resources over Streamable HTTP. Every tool
// handler funnels through the fixed 7-stage pipeline (auth → scope → zod →
// sqlGuard → AccessPolicy → executor → PII scan + audit); resource reads go
// through the same auth/scope/audit path with section filtering. No stage
// is skippable and no TRACER shortcut remains.
//
// NOTE (SDK 1.32.2, kept from the tracer slice): a stateless
// StreamableHTTPServerTransport instance is single-use, and McpServer
// refuses a second transport — so each POST builds a fresh server +
// transport pair (true stateless semantics).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { dbToolError } from "@se373/contracts";
import {
  ColumnScopePolicy,
  DEFAULT_SENSITIVE_COLUMNS_PATH,
} from "@se373/access-policy";
import {
  loadMcpClients,
  loadSensitiveColumns,
  resolveClientTokens,
  type SensitiveColumns,
} from "./config.js";
import { authenticateRequest } from "./auth.js";
import {
  executeResourceRead,
  executeToolCall,
  type GatewayDeps,
  type ResourceDocument,
  type SearchFn,
} from "./pipeline.js";
import {
  buildCatalog,
  fetchCatalogSource,
  type BuiltCatalog,
} from "./catalog.js";
import {
  defaultSessionFactory,
  getAgentRoPool,
  type SessionFactory,
} from "./executor.js";
import { initAudit } from "./audit.js";
import { TOOL_SPECS } from "./tools.js";
import { warmupSqlGuard } from "@se373/access-policy";

export interface GatewayAppOptions {
  clientsYaml?: string;
  sensitiveYaml?: string;
  clientsPath?: string;
  sensitivePath?: string;
  auditPath?: string;
  sessionFactory?: SessionFactory;
  catalogOverride?: BuiltCatalog;
  search?: SearchFn;
  documents?: ResourceDocument[];
}

const DEFAULT_CLIENTS_PATH = path.resolve("policies/mcp_clients.yaml");

function notWiredSearch(): SearchFn {
  return async () => {
    throw dbToolError("INTERNAL_ERROR", "semantic retriever not wired");
  };
}

function defaultDocuments(): ResourceDocument[] {
  const read = (file: string): string => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  return [
    {
      uri: "semantic://data-dictionary",
      text: read(path.resolve("semantic/data_dictionary.md")),
    },
    { uri: "semantic://metrics", text: read(path.resolve("semantic/metrics.md")) },
  ];
}

function mcpErrorPayload(message: string, code: string): {
  content: { type: "text"; text: string }[];
  isError: true;
  _gatewayErrorCode: string;
} {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
    _gatewayErrorCode: code,
  };
}

export async function createGatewayApp(
  options: GatewayAppOptions = {},
): Promise<express.Express> {
  const clientsYaml =
    options.clientsYaml ??
    readFileSync(options.clientsPath ?? DEFAULT_CLIENTS_PATH, "utf8");
  const sensitiveYaml =
    options.sensitiveYaml ??
    readFileSync(
      options.sensitivePath ?? DEFAULT_SENSITIVE_COLUMNS_PATH,
      "utf8",
    );
  const clients = resolveClientTokens(loadMcpClients(clientsYaml));
  const sensitive: SensitiveColumns = loadSensitiveColumns(sensitiveYaml);

  initAudit(options.auditPath ?? path.resolve("logs/mcp_audit.jsonl"));

  let catalog = options.catalogOverride;
  if (catalog === undefined) {
    const pool = getAgentRoPool();
    const source = await fetchCatalogSource(async (text) => {
      const result = await pool.query(text);
      return { rows: result.rows as Record<string, unknown>[] };
    });
    catalog = buildCatalog(source, sensitive);
  }
  const builtCatalog: BuiltCatalog = catalog;

  await warmupSqlGuard();

  const deps: GatewayDeps = {
    clients,
    catalog: builtCatalog,
    policy: new ColumnScopePolicy(
      sensitive.columns.map((entry) => ({ ...entry })),
    ),
    sessionFactory: options.sessionFactory ?? defaultSessionFactory,
    search: options.search ?? notWiredSearch(),
  };
  const documents = options.documents ?? defaultDocuments();

  function buildMcpServer(): McpServer {
    const server = new McpServer(
      { name: "se373-mcp-gateway", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } },
    );

    for (const spec of TOOL_SPECS) {
      server.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: spec.inputSchema.shape,
        },
        async (
          args: Record<string, unknown>,
          extra: {
            requestInfo?: {
              headers?: Record<string, string | string[] | undefined>;
            };
          },
        ) => {
          const headers = (extra.requestInfo?.headers ?? {}) as Record<
            string,
            string | string[] | undefined
          >;
          const result = await executeToolCall(deps, {
            headers,
            tool: spec.name,
            args,
          });
          if (!result.ok) {
            return mcpErrorPayload(
              JSON.stringify(result.error),
              result.error.code,
            );
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
          };
        },
      );
    }

    const resourceEntries = [
      {
        name: "data-dictionary",
        uri: "semantic://data-dictionary",
        description: "Versioned table and column dictionary (role-filtered)",
      },
      {
        name: "metrics",
        uri: "semantic://metrics",
        description: "Versioned metric definitions (role-filtered)",
      },
    ];
    for (const entry of resourceEntries) {
      server.registerResource(
        entry.uri,
        entry.uri,
        {
          title: entry.name,
          description: entry.description,
          mimeType: "text/markdown",
        },
        async (uri, extra) => {
          const headers = (extra.requestInfo?.headers ?? {}) as Record<
            string,
            string | string[] | undefined
          >;
          const result = await executeResourceRead(
            deps,
            headers,
            uri.href,
            documents,
          );
          if (!result.ok) {
            throw new Error(JSON.stringify(result.error));
          }
          const data = result.data as { text: string; mimeType: string };
          return {
            contents: [
              { uri: uri.href, mimeType: data.mimeType, text: data.text },
            ],
          };
        },
      );
    }

    return server;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    // Stage 1 (auth) at the HTTP layer: no valid Bearer, no MCP dispatch.
    const auth = authenticateRequest(
      req.headers as Record<string, string | string[] | undefined>,
      clients,
    );
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

export async function startGatewayServer(
  port: number,
  options: GatewayAppOptions = {},
) {
  const app = await createGatewayApp(options);
  const server = app.listen(port, () => {
    console.log(`[mcp-gateway] listening on 127.0.0.1:${port}`);
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  return server;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.MCP_PORT ?? 8081);
  await startGatewayServer(port);
}
