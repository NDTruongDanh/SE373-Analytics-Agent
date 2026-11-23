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
  EVAL_CLIENTS_ENV,
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
