// MCP tool surface (MCP-01): the five db-tools plus search_semantic_layer.
// Each spec names the server-side scope the pipeline enforces, the strict
// zod input schema applied at stage 3, and whether the call carries client
// SQL through stages 4-6. Descriptions are operator-facing; no PII here.
import {
  DescribeTableInputSchema,
  ExplainQueryInputSchema,
  ListTablesInputSchema,
  RunQueryInputSchema,
  SampleRowsInputSchema,
  SearchSemanticLayerInputSchema,
} from "@shared/contracts";
import { TOOL_SCOPES } from "./constants.js";

export { TOOL_SCOPES, TOOL_SPECS } from "./constants.js";

export type ToolName = keyof typeof TOOL_SCOPES;

export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema:
    | typeof ListTablesInputSchema
    | typeof DescribeTableInputSchema
    | typeof ExplainQueryInputSchema
    | typeof RunQueryInputSchema
    | typeof SampleRowsInputSchema
    | typeof SearchSemanticLayerInputSchema;
  needsSql: boolean;
}
