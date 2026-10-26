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
} from "@se373/contracts";

export const TOOL_SCOPES = {
  list_tables: "schema:read",
  describe_table: "schema:read",
  explain_query: "data:read",
  run_query: "data:read",
  sample_rows: "data:read",
  search_semantic_layer: "data:read",
} as const;

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

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "list_tables",
    description: "List public tables with column names and sensitivity flags",
    inputSchema: ListTablesInputSchema,
    needsSql: false,
  },
  {
    name: "describe_table",
    description:
      "Describe one public table: columns with types, sensitivity and large flags, primary key, foreign keys",
    inputSchema: DescribeTableInputSchema,
    needsSql: false,
  },
  {
    name: "explain_query",
    description:
      "Return the planner cost and row estimate for a SELECT without running it (never ANALYZE)",
    inputSchema: ExplainQueryInputSchema,
    needsSql: true,
  },
  {
    name: "run_query",
    description: "Run a read-only SELECT with bounded rows and masked PII",
    inputSchema: RunQueryInputSchema,
    needsSql: true,
  },
  {
    name: "sample_rows",
    description: "Return up to 5 sample rows from one public table",
    inputSchema: SampleRowsInputSchema,
    needsSql: true,
  },
  {
    name: "search_semantic_layer",
    description:
      "Hybrid vector plus full-text search over the versioned semantic corpus",
    inputSchema: SearchSemanticLayerInputSchema,
    needsSql: false,
  },
];
