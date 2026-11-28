import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { dbToolError } from "@shared/contracts";
import {
  ColumnScopePolicy,
  DEFAULT_ROW_SCOPE_LINEAGE_PATH,
  DEFAULT_SENSITIVE_COLUMNS_PATH,
  loadRowScopeLineage,
  type SqlIdentifierAliases,
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
import {
  initAudit,
  initPgAudit,
  setPgAuditPoolForTests,
  type AuditPoolLike,
} from "./audit.js";
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
  rowScopeYaml?: string;
  rowScopePath?: string;
  auditPath?: string;
  auditPool?: AuditPoolLike;
  harnessStateDatabaseUrl?: string;
  allowJsonlOnlyAuditForTests?: boolean;
  sessionFactory?: SessionFactory;
  catalogOverride?: BuiltCatalog;
  search?: SearchFn;
  documents?: ResourceDocument[];
  reindex?: () => Promise<IndexCounts>;
}

const DEFAULT_CLIENTS_PATH = path.resolve("policies/mcp_clients.yaml");
const SEMANTIC_DIR = fileURLToPath(new URL("../../../semantic", import.meta.url));

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
      text: read(path.join(SEMANTIC_DIR, "data_dictionary.md")),
    },
    {
      uri: "semantic://metrics",
      text: read(path.join(SEMANTIC_DIR, "metrics.md")),
    },
  ];
}

function loadTableGrains(): Record<string, string> {
  const grains: Record<string, string> = {};
  const file = path.join(SEMANTIC_DIR, "tables.yaml");
  if (!existsSync(file)) return grains;
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) as { chunks?: unknown[] };
    for (const raw of parsed?.chunks ?? []) {
      const entry = raw as Record<string, unknown>;
      if (typeof entry["table"] === "string" && typeof entry["grain"] === "string") {
        grains[entry["table"]] = entry["grain"];
      }
    }
  } catch {}
  return grains;
}

function semanticIdentifierAliases(): SqlIdentifierAliases {
  const tables: Record<string, string[]> = {};
  const columns: Record<string, Record<string, string[]>> = {};
  for (const file of ["tables.yaml", "columns.yaml"] as const) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(path.join(SEMANTIC_DIR, file), "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entries = (parsed as { chunks?: unknown }).chunks;
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (entry["sensitivity"] === "restricted_pii") continue;
      const names = Array.isArray(entry["aliases"])
        ? entry["aliases"].filter((value): value is string => typeof value === "string")
        : [];
      if (names.length === 0) continue;
      if (file === "tables.yaml") {
        if (typeof entry["table"] === "string") tables[entry["table"]] = names;
      } else if (typeof entry["column"] === "string") {
        const parts = entry["column"].split(".");
        if (parts.length !== 2) continue;
        const table = parts[0] as string;
        if (!columns[table]) columns[table] = {};
        columns[table][parts[1] as string] = names;
      }
    }
  }
  return { tables, columns };
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

// Register a pass-through schema so the SDK doesn't reject malformed params before
// executeToolCall runs auth -> scope -> zod -> ... -> audit in order.
const PASS_THROUGH_INPUT = z.looseObject({});

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
  const rowScopeLineage = loadRowScopeLineage(
    options.rowScopeYaml ??
      readFileSync(options.rowScopePath ?? DEFAULT_ROW_SCOPE_LINEAGE_PATH, "utf8"),
  );

  initAudit(options.auditPath ?? path.resolve("logs/mcp_audit.jsonl"));
  const auditPgConn =
    options.harnessStateDatabaseUrl ??
    process.env["HARNESS_STATE_DATABASE_URL"];
  if (options.auditPool) {
    await initPgAudit({ pool: options.auditPool });
  } else if (auditPgConn && auditPgConn.length > 0) {
    await initPgAudit({ connString: auditPgConn });
  } else if (options.allowJsonlOnlyAuditForTests === true) {
    setPgAuditPoolForTests(null);
  } else {
    throw new Error(
      "createGatewayApp: HARNESS_STATE_DATABASE_URL or auditPool is required for durable fail-closed PostgreSQL audit (pass allowJsonlOnlyAuditForTests: true only in DB-free tests).",
    );
  }

  let catalog = options.catalogOverride;
  const pool = options.catalogOverride === undefined ? getAgentRoPool() : null;
  if (catalog === undefined) {
    const source = await fetchCatalogSource(async (text) => {
      const result = await (pool as NonNullable<typeof pool>).query(text);
      return { rows: result.rows as Record<string, unknown>[] };
    });
    catalog = buildCatalog(source, sensitive, { tableGrains: loadTableGrains() });
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
    identifierAliases: semanticIdentifierAliases(),
    policy: new ColumnScopePolicy(
      sensitive.columns.map((entry) => ({ ...entry })),
      rowScopeLineage,
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
          builtCatalog.foreignKeys,
          new Set(builtCatalog.catalog.tables.filter((table) => table.schema === "public").map((table) => table.name)),
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
    // Override tools/list with strict contract schemas instead of the pass-through above.
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
    const auth = authenticateRequest(
      req.headers as Record<string, string | string[] | undefined>,
      clients,
    );
    if ("error" in auth) {
      res.status(401).json(auth.error);
      return;
    }
    // SDK 1.32.2: stateless StreamableHTTPServerTransport is single-use and McpServer
    // refuses a second transport, so each POST builds a fresh server + transport pair.
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
    // Sanitize boot failures so driver secrets, paths, and stack frames never reach stderr.
    const clean = sanitizeError(error);
    console.error(
      `[mcp-gateway] failed to start: ${clean.code}: ${clean.message}`,
    );
    process.exit(1);
  }
}
