// @shared/mcp-server public barrel: the gateway entrypoints plus the pure
// building blocks (catalog, tool registry, config loaders, error mapping).
// Importing this barrel never starts a server; server.ts only listens when
// run directly.
export {
  createGatewayApp,
  startGatewayServer,
  type GatewayAppOptions,
} from "./server.js";
export {
  executeToolCall,
  executeResourceRead,
  filterResourceSections,
  type GatewayDeps,
  type PipelineRequest,
  type PipelineResult,
  type ResourceDocument,
  type SearchFn,
} from "./pipeline.js";
export {
  LARGE_TABLES,
  buildCatalog,
  fetchCatalogSource,
  findTable,
  type BuiltCatalog,
  type CatalogRow,
  type CatalogSource,
  type ConstraintRow,
  type ForeignKeyRef,
} from "./catalog.js";
export { TOOL_SCOPES, TOOL_SPECS, type ToolName, type ToolSpec } from "./tools.js";
export {
  McpClientsSchema,
  loadMcpClients,
  loadSensitiveColumns,
  resolveClientTokens,
  type McpClient,
  type McpClients,
  type McpRowScope,
  type McpScope,
  type ResolvedClient,
} from "./config.js";
export { sanitizeError } from "./errors.js";
