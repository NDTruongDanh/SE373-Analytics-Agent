// Shared magic values (single source of truth). Original modules keep a
// compat re-export so external importers keep working.
import {
  DescribeTableInputSchema,
  ExplainQueryInputSchema,
  ListTablesInputSchema,
  RunQueryInputSchema,
  SampleRowsInputSchema,
  SearchSemanticLayerInputSchema,
} from "@shared/contracts";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export const RRF_K = 60;

export const W_DENSE = 1.0;
export const W_BM25 = 1.0;
export const W_ALIAS = 1.5;
export const DEFAULT_RRF_WEIGHTS = [W_DENSE, W_BM25, W_ALIAS] as const;

// Row counts from data/seed_manifest.json: order_items 1,138,526; orders 997,665.
export const LARGE_TABLES: readonly string[] = ["order_items", "orders"];

export const TOOL_SCOPES = {
  list_tables: "schema:read",
  describe_table: "schema:read",
  explain_query: "data:read",
  run_query: "data:read",
  sample_rows: "data:read",
  search_semantic_layer: "data:read",
} as const;

export const TOOL_SPECS = [
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
