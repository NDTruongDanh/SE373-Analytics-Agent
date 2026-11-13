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
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { dbToolError } from "@shared/contracts";
import {
  ColumnScopePolicy,
  DEFAULT_SENSITIVE_COLUMNS_PATH,
} from "@shared/access-policy";
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
import { sanitizeError } from "./errors.js";
import { TOOL_SPECS } from "./tools.js";
import { warmupSqlGuard } from "@shared/access-policy";
import { hybridSearch, resetSemanticCache } from "./semantic/retriever.js";
import { selectEmbedderFromEnv } from "./semantic/embedder.js";
import {
  discoverDefaultFiles,
  indexCorpus,
  type IndexCounts,
} from "./semantic/index.js";

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
  reindex?: () => Promise<IndexCounts>;
}

const DEFAULT_CLIENTS_PATH = path.resolve("policies/mcp_clients.yaml");

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
    {
      uri: "semantic://metrics",
      text: read(path.resolve("semantic/metrics.md")),
    },
  ];
}

function mcpErrorPayload(
  message: string,
  code: string,
): {
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

// The SDK validates tool arguments against the registered inputSchema before
// the handler runs, so a strict schema there would reject malformed params
// outside the pipeline: no audit line, and zod ahead of the scope check.
// Register a pass-through schema so every call reaches executeToolCall,
// where auth -> scope -> zod -> ... -> audit runs in order (UC09.md B.1).
const PASS_THROUGH_INPUT = z.looseObject({});

// tools/list still advertises the strict contract schemas: the pass-through
// above is a dispatch detail, not the public tool interface.
function listToolsResult(): {
  tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
} {
  return {
    tools: TOOL_SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: z.toJSONSchema(spec.inputSchema, {
        target: "draft-7",
        io: "input",
      }) as Record<string, unknown>,
    })),
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
  const pool = options.catalogOverride === undefined ? getAgentRoPool() : null;
  if (catalog === undefined) {
    const source = await fetchCatalogSource(async (text) => {
      const result = await (pool as NonNullable<typeof pool>).query(text);
      return { rows: result.rows as Record<string, unknown>[] };
    });
    catalog = buildCatalog(source, sensitive);
  }
  const builtCatalog: BuiltCatalog = catalog;

  await warmupSqlGuard();

  const selection = selectEmbedderFromEnv();
  if (selection.model === "fake") {
    console.warn(
      `[mcp-gateway] no embedding endpoint configured — serving deterministic fake embeddings model=${selection.model} dim=${selection.embedder.dimensions}`,
    );
  } else {
    console.log(
      `[mcp-gateway] model=${selection.model} dim=${selection.embedder.dimensions}`,
    );
  }
  const searchPool = pool ?? getAgentRoPool();

  const deps: GatewayDeps = {
    clients,
    catalog: builtCatalog,
    policy: new ColumnScopePolicy(
      sensitive.columns.map((entry) => ({ ...entry })),
    ),
    sessionFactory: options.sessionFactory ?? defaultSessionFactory,
    search:
      options.search ??
      (async (query, topK, allowRestricted) =>
        hybridSearch(
          async (text, params) => {
            const result = await searchPool.query(text, params as unknown[]);
            return { rows: result.rows as Record<string, unknown>[] };
          },
          selection.embedder,
          query,
          topK,
          allowRestricted,
        )),
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
          inputSchema: PASS_THROUGH_INPUT,
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
            content: [
              { type: "text" as const, text: JSON.stringify(result.data) },
            ],
          };
        },
      );
    }
    // Replace the SDK's tools/list handler (which would describe the
    // pass-through schema) with the strict contract schemas.
    server.server.setRequestHandler(ListToolsRequestSchema, listToolsResult);

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

  app.post("/reindex", async (req: Request, res: Response) => {
    const auth = authenticateRequest(
      req.headers as Record<string, string | string[] | undefined>,
      clients,
    );
    if ("error" in auth) {
      res.status(401).json(auth.error);
      return;
    }
    if (auth.auth.principal.role !== "admin") {
      res
        .status(403)
        .json(
          dbToolError(
            "SCOPE_DENIED",
            "only admin may trigger semantic re-indexing",
          ),
        );
      return;
    }
    try {
      const counts = options.reindex
        ? await options.reindex()
        : await indexCorpus({
            dbUrl:
              process.env["INDEXER_DATABASE_URL"] ??
              process.env["DATABASE_URL"] ??
              "",
            embedder: selectEmbedderFromEnv().embedder,
            files: discoverDefaultFiles(),
          });
      resetSemanticCache();
      res.status(200).json(counts);
    } catch (error) {
      res
        .status(500)
        .json(
          dbToolError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "semantic re-index failed",
          ),
        );
    }
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
  try {
    await startGatewayServer(port);
  } catch (error) {
    // Boot failures (wrong-password DSN, unreachable DB) must not echo raw
    // driver output: sanitize through the same choke point as tool errors so
    // role names, paths, and stack frames never reach stderr (B.1 error-leak
    // row asserts sanitized output). Fail-closed: non-zero exit, no healthz.
    const clean = sanitizeError(error);
    console.error(
      `[mcp-gateway] failed to start: ${clean.code}: ${clean.message}`,
    );
    process.exit(1);
  }
}
