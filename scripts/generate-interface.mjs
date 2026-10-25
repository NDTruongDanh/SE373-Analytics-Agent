// Generates docs/mcp_interface.md from the frozen zod schemas.
// Run: pnpm docs:interface  (tsx resolves the .ts imports below)
// Uses node builtins plus the zod import only — never zod-to-json-schema
// (that package is v3-only and throws on v4 schemas).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Resolve zod through the contracts package so this script never depends on
// root hoisting layout (pnpm links zod only under packages/contracts).
const contractsRequire = createRequire(join(root, "packages/contracts/package.json"));
const z = contractsRequire("zod");

const schemas = await import("../packages/contracts/src/index.ts");

const TOOLS = [
  {
    name: "list_tables",
    scope: "schema:read",
    input: schemas.ListTablesInputSchema,
    output: schemas.ListTablesOutputSchema,
  },
  {
    name: "describe_table",
    scope: "schema:read",
    input: schemas.DescribeTableInputSchema,
    output: schemas.DescribeTableOutputSchema,
  },
  {
    name: "explain_query",
    scope: "schema:read",
    input: schemas.ExplainQueryInputSchema,
    output: schemas.ExplainQueryOutputSchema,
  },
  {
    name: "run_query",
    scope: "data:read",
    input: schemas.RunQueryInputSchema,
    output: schemas.RunQueryOutputSchema,
  },
  {
    name: "sample_rows",
    scope: "data:read",
    input: schemas.SampleRowsInputSchema,
    output: schemas.SampleRowsOutputSchema,
  },
];

const ERRORS = [
  ["E1", "UNAUTHORIZED", "Missing or invalid token (HTTP 401)"],
  ["E2", "SCOPE_DENIED", "Caller lacks the scope the tool requires"],
  ["E3", "INVALID_PARAMS", "zod rejects the input shape"],
  ["E4", "INVALID_SQL", "SQL does not parse; cursor position returned"],
  ["E5", "FORBIDDEN_STATEMENT", "DDL/DML, multi-statement, SELECT INTO, FOR UPDATE, DML in CTE"],
  ["E6", "FORBIDDEN_FUNCTION", "Banned function call (pg_sleep, pg_read_file, dblink, set_config, …)"],
  ["E7", "UNKNOWN_TABLE", "Table/column missing, outside whitelist, or system schema"],
  ["E8", "SENSITIVE_COLUMN_DENIED", "Sensitive column outside projection without data:sensitive (fail-closed)"],
  ["E9", "TIMEOUT", "statement_timeout exceeded (PG 57014)"],
  ["E10", "— (truncated flag)", "Over maxRows: cut off, truncated = true (not an error)"],
  ["E11", "INTERNAL_ERROR", "DB or connection failure; details stay in the internal log"],
  ["F17", "RATE_LIMITED (reserved)", "Per-client rate limit exceeded"],
];

function jsonBlock(value) {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

const lines = [];
lines.push("# MCP Interface (generated)");
lines.push("");
lines.push(
  "> Generated from `@se373/contracts` via `z.toJSONSchema()`. Do not hand-edit — run `pnpm docs:interface`.",
);
lines.push("");

for (const tool of TOOLS) {
  lines.push(`## ${tool.name}`);
  lines.push("");
  lines.push(`Required scope: \`${tool.scope}\`.`);
  lines.push("");
  lines.push("### Input");
  lines.push("");
  lines.push(jsonBlock(z.toJSONSchema(tool.input)));
  lines.push("");
  lines.push("### Output");
  lines.push("");
  lines.push(jsonBlock(z.toJSONSchema(tool.output)));
  lines.push("");
}

lines.push("## Error codes");
lines.push("");
lines.push("| Code | Name | Meaning |");
lines.push("|------|------|---------|");
for (const [code, name, meaning] of ERRORS) {
  lines.push(`| ${code} | ${name} | ${meaning} |`);
}
lines.push("");

lines.push("## Worked example: run_query");
lines.push("");
lines.push("Request (`run_query`, scope `data:read`):");
lines.push("");
lines.push(
  jsonBlock({
    sql: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
    maxRows: 200,
  }),
);
lines.push("");
lines.push("Response (`RunQueryOutput`):");
lines.push("");
lines.push(
  jsonBlock({
    columns: ["status", "n"],
    rows: [
      { status: "delivered", n: 42 },
      { status: "shipped", n: 7 },
    ],
    rowCount: 2,
    truncated: false,
    maskedColumns: [],
    durationMs: 18,
  }),
);
lines.push("");

const outPath = join(root, "docs/mcp_interface.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath}`);
