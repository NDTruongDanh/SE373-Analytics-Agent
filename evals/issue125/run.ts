import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SchemaCatalog } from "@shared/contracts";
import { sqlGuard } from "@shared/access-policy";
import { loadSemanticJoinEdges, loadSqlIdentifierAliases } from "../../packages/agent/src/semantic/catalog.js";
import { escapedIlikePattern, isHighCardinalityDiagnosticColumn, likeDiagnosticTerms } from "../../packages/agent/src/queryExecutor/diagnosticCardinality.js";
import { entityCoverage, resolveCandidateTables } from "../../packages/agent/src/subgraphs/tableResolver.js";
import { createSpanEmitter } from "../../packages/agent/src/telemetry/spans.js";

const catalog: SchemaCatalog = {
  tables: [
    { name: "orders", schema: "public", columns: [
      { name: "id", type: "integer", nullable: false, sensitive: false, large: false },
      { name: "purchase_date", type: "timestamp", nullable: false, sensitive: false, large: false },
    ] },
    { name: "products", schema: "public", columns: [
      { name: "name", type: "text", nullable: false, sensitive: false, large: false },
    ] },
    { name: "customers", schema: "public", columns: [
      { name: "name", type: "text", nullable: false, sensitive: true, large: false },
    ] },
  ],
};

const repoRoot = path.resolve(import.meta.dirname, "../..");
const cases = readFileSync(path.join(import.meta.dirname, "cases.jsonl"), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const runId = "125a5f1e-7b2d-4c8e-9f0a-1b2c3d4e5f60";
const tracesDir = path.join(repoRoot, "traces", "issue125");
mkdirSync(tracesDir, { recursive: true });
writeFileSync(path.join(tracesDir, `${runId}.jsonl`), "", "utf8");
const emit = createSpanEmitter({ runId, threadId: `eval:${runId}`, userId: "eval", role: "sales_south", tracesDir });

async function grade(item: Record<string, unknown>): Promise<boolean> {
  const kind = String(item["kind"]);
  if (kind === "identifier_table" || kind === "identifier_alias" || kind === "sensitive_column") {
    const result = await sqlGuard(String(item["sql"]), catalog, { aliases: loadSqlIdentifierAliases() });
    if (result.ok) return false;
    const message = result.error.message;
    return kind === "sensitive_column"
      ? !message.includes(`did you mean: ${String(item["forbidden"])}`)
      : message.includes(`did you mean: ${String(item["expected"])}`);
  }
  if (kind === "fk_bridge" || kind === "date_link" || kind === "disconnected") {
    const tables = item["tables"] as string[];
    const result = resolveCandidateTables({
      question: tables.join(" "), schemaEntities: tables,
      catalogTables: ["orders", "order_items", "products", "categories", "promotions", "inventory"]
        .map((name) => ({ name, schema: "public" })),
      catalogLoaded: true, semanticChunks: [], joinEdges: loadSemanticJoinEdges(),
    });
    if (kind === "disconnected") return !result.ok && result.reason === "disconnected_required_tables";
    return result.ok && (kind === "fk_bridge"
      ? result.requiredTables.includes(String(item["expected"]))
      : result.requiredTables.length === 2);
  }
  if (kind === "high_cardinality") {
    const table = String(item["table"]);
    const column = String(item["column"]);
    const terms = likeDiagnosticTerms(String(item["literal"]));
    return isHighCardinalityDiagnosticColumn(table, column) &&
      terms.includes("Nam") && escapedIlikePattern(terms[0] as string).startsWith("E'");
  }
  if (kind === "low_cardinality") {
    return !isHighCardinalityDiagnosticColumn(String(item["table"]), String(item["column"]));
  }
  if (kind === "outside_domain") {
    const entity = String(item["entity"]);
    const result = resolveCandidateTables({
      question: entity, schemaEntities: [entity],
      catalogTables: [{ name: "orders", schema: "public" }],
      catalogLoaded: true, semanticChunks: [],
    });
    return !result.ok && entityCoverage(result.entities).matchedCount === 0;
  }
  if (kind === "adversarial_probe") {
    const pattern = escapedIlikePattern(String(item["literal"]));
    const sql = `SELECT name FROM products WHERE name ILIKE ${pattern} ESCAPE E'\\\\' LIMIT 10`;
    return (await sqlGuard(sql, catalog)).ok && sql.includes("'' OR TRUE");
  }
  return false;
}

let passed = 0;
for (const item of cases) {
  const ok = await grade(item);
  if (ok) passed += 1;
  emit({ node: "issue125_eval", type: "node_done", durationMs: 0,
    payload: { caseId: item["id"], uc: item["uc"], ok, mode: "deterministic_no_db" } });
}
emit.emitRunDone(passed === cases.length ? "ok" : "error");
process.stdout.write(`issue125 deterministic eval: ${passed}/${cases.length} passed\n`);
if (passed !== cases.length) process.exitCode = 1;
