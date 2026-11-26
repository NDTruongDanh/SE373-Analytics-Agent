import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { parse as parseYaml } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findSemanticDir(): string {
  const candidates = [
    path.resolve(HERE, "..", "..", "..", "..", "semantic"),
    path.resolve(HERE, "..", "..", "..", "semantic"),
    path.resolve(process.cwd(), "semantic"),
    path.resolve(process.cwd(), "..", "..", "semantic"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd(), "semantic");
}

export const DEFAULT_SEMANTIC_DIR = findSemanticDir();

export interface VerifySemanticClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SemanticVerifyReport {
  failures: string[];
  warnings: string[];
  checkedTables: number;
  checkedColumns: number;
  checkedEnums: number;
  checkedMetrics: number;
  checkedJoins: number;
  fanoutRatios: Record<string, number>;
}

export interface VerifyOptions {
  semanticDir?: string;
}

interface TableChunk {
  chunkId: string;
  table?: string;
  tables?: string[];
  columns?: string[];
}

interface ColumnChunk {
  chunkId: string;
  table?: string;
  tables?: string[];
  column?: string;
  enumValues?: string[] | number[];
  enum_values?: string[] | number[];
}

interface MetricChunk {
  chunkId: string;
  metricName?: string;
  aliases?: string[];
  sql?: string;
}

interface JoinChunk {
  chunkId: string;
  table?: string;
  tables?: string[];
  sql?: string;
  joinSql?: string;
}

function parseYamlFile<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`Semantic file not found: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf8");
  return parseYaml(content) as T;
}

/**
 * 1. Validate that every table and column in tables.yaml and columns.yaml exists in information_schema.
 */
export async function verifyInformationSchema(
  client: VerifySemanticClient,
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): Promise<{ failures: string[]; checkedTables: number; checkedColumns: number }> {
  const failures: string[] = [];
  let checkedTables = 0;
  let checkedColumns = 0;

  const tablesRes = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const existingTables = new Set(tablesRes.rows.map((r) => String(r["table_name"])));

  const columnsRes = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
  );
  const existingColumns = new Set(
    columnsRes.rows.map((r) => `${String(r["table_name"])}.${String(r["column_name"])}`),
  );

  // Validate tables.yaml
  const tablesFile = path.join(semanticDir, "tables.yaml");
  if (existsSync(tablesFile)) {
    const data = parseYamlFile<{ chunks: TableChunk[] }>(tablesFile);
    for (const chunk of data.chunks ?? []) {
      const tableName = chunk.table ?? chunk.tables?.[0];
      if (!tableName) {
        failures.push(`Table chunk ${chunk.chunkId} in tables.yaml is missing a table name.`);
        continue;
      }
      checkedTables += 1;
      if (!existingTables.has(tableName)) {
        failures.push(
          `Table "${tableName}" declared in tables.yaml (${chunk.chunkId}) does not exist in information_schema.tables.`,
        );
      }

      for (const col of chunk.columns ?? []) {
        checkedColumns += 1;
        const colKey = `${tableName}.${col}`;
        if (!existingColumns.has(colKey)) {
          failures.push(
            `Column "${colKey}" declared in tables.yaml (${chunk.chunkId}) does not exist in information_schema.columns.`,
          );
        }
      }
    }
  }

  // Validate columns.yaml
  const columnsFile = path.join(semanticDir, "columns.yaml");
  if (existsSync(columnsFile)) {
    const data = parseYamlFile<{ chunks: ColumnChunk[] }>(columnsFile);
    for (const chunk of data.chunks ?? []) {
      const colDecl = chunk.column ?? chunk.chunkId.replace(/^column:/, "");
      let tableName = chunk.table;
      let colName = colDecl;

      if (colDecl.includes(".")) {
        const parts = colDecl.split(".");
        tableName = parts[0] ?? tableName;
        colName = parts[1] ?? colName;
      }

      if (!tableName) {
        failures.push(`Column chunk ${chunk.chunkId} in columns.yaml is missing table reference.`);
        continue;
      }

      if (!existingTables.has(tableName)) {
        failures.push(
          `Table "${tableName}" for column chunk ${chunk.chunkId} does not exist in information_schema.tables.`,
        );
      }

      checkedColumns += 1;
      const colKey = `${tableName}.${colName}`;
      if (!existingColumns.has(colKey)) {
        failures.push(
          `Column "${colKey}" declared in columns.yaml (${chunk.chunkId}) does not exist in information_schema.columns.`,
        );
      }
    }
  }

  return { failures, checkedTables, checkedColumns };
}

/**
 * 2. Validate that every enumValues array matches SELECT DISTINCT <col> FROM <table>.
 */
export async function verifyEnumValues(
  client: VerifySemanticClient,
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): Promise<{ failures: string[]; checkedEnums: number }> {
  const failures: string[] = [];
  let checkedEnums = 0;

  const columnsFile = path.join(semanticDir, "columns.yaml");
  if (!existsSync(columnsFile)) {
    return { failures, checkedEnums };
  }

  const data = parseYamlFile<{ chunks: ColumnChunk[] }>(columnsFile);
  for (const chunk of data.chunks ?? []) {
    const rawEnums = chunk.enumValues ?? chunk.enum_values;
    if (!rawEnums || !Array.isArray(rawEnums) || rawEnums.length === 0) {
      continue;
    }

    checkedEnums += 1;
    const colDecl = chunk.column ?? chunk.chunkId.replace(/^column:/, "");
    let tableName = chunk.table;
    let colName = colDecl;
    if (colDecl.includes(".")) {
      const parts = colDecl.split(".");
      tableName = parts[0] ?? tableName;
      colName = parts[1] ?? colName;
    }

    if (!tableName || !colName) {
      failures.push(`Chunk ${chunk.chunkId} has enumValues but cannot resolve table/column.`);
      continue;
    }

    const expectedSet = new Set(rawEnums.map((v) => String(v).trim()));
    try {
      const res = await client.query(
        `SELECT DISTINCT "${colName}" AS val FROM public."${tableName}" WHERE "${colName}" IS NOT NULL`,
      );
      const actualSet = new Set(res.rows.map((r) => String(r["val"]).trim()));

      const missingInDb = [...expectedSet].filter((val) => !actualSet.has(val));
      const unexpectedInDb = [...actualSet].filter((val) => !expectedSet.has(val));

      if (missingInDb.length > 0 || unexpectedInDb.length > 0) {
        failures.push(
          `enumValues mismatch for ${tableName}.${colName} (${chunk.chunkId}): ` +
            `expected [${[...expectedSet].sort().join(", ")}], DB has [${[...actualSet].sort().join(", ")}]. ` +
            `(missing in DB: ${missingInDb.join(", ") || "none"}, unexpected in DB: ${unexpectedInDb.join(", ") || "none"})`,
        );
      }
    } catch (err) {
      failures.push(
        `Failed to query distinct values for ${tableName}.${colName} (${chunk.chunkId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { failures, checkedEnums };
}

/**
 * 3. Validate that EXPLAIN succeeds on every metrics.yaml SQL template.
 */
export async function verifyMetricsSql(
  client: VerifySemanticClient,
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): Promise<{ failures: string[]; checkedMetrics: number }> {
  const failures: string[] = [];
  let checkedMetrics = 0;

  const metricsFile = path.join(semanticDir, "metrics.yaml");
  if (!existsSync(metricsFile)) {
    return { failures, checkedMetrics };
  }

  const data = parseYamlFile<{ chunks: MetricChunk[] }>(metricsFile);
  for (const chunk of data.chunks ?? []) {
    if (!chunk.sql) continue;
    checkedMetrics += 1;

    // Substitute named parameter placeholders like :period_start or :period_end with safe test literals
    const explainSql = chunk.sql.replace(/:[a-zA-Z0-9_]+/g, "'2026-01-01'");

    try {
      await client.query(`EXPLAIN ${explainSql}`);
    } catch (err) {
      failures.push(
        `EXPLAIN failed for metric ${chunk.metricName ?? chunk.chunkId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { failures, checkedMetrics };
}

/**
 * Canonical join definitions corresponding to semantic/joins.yaml rules.
 */
export const CANONICAL_JOINS: Record<
  string,
  {
    tables: string[];
    query: string;
  }
> = {
  "join_rule:orders_items_payments": {
    tables: ["orders", "order_items", "payments"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT o.order_id) AS distinct_base " +
      "FROM public.orders o JOIN public.order_items oi USING (order_id) JOIN public.payments p USING (order_id)",
  },
  "join_rule:orders_order_items": {
    tables: ["orders", "order_items"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT o.order_id) AS distinct_base " +
      "FROM public.orders o JOIN public.order_items oi USING (order_id)",
  },
  "join_rule:orders_payments": {
    tables: ["orders", "payments"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT o.order_id) AS distinct_base " +
      "FROM public.orders o JOIN public.payments p USING (order_id)",
  },
  "join_rule:orders_customers_regions": {
    tables: ["orders", "customers", "regions"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT o.order_id) AS distinct_base " +
      "FROM public.orders o JOIN public.customers c USING (customer_id) JOIN public.regions r USING (province)",
  },
  "join_rule:order_items_products_categories": {
    tables: ["order_items", "products", "categories"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT oi.order_item_id) AS distinct_base " +
      "FROM public.order_items oi JOIN public.products p USING (product_id) JOIN public.categories cat USING (category_id)",
  },
  "join_rule:order_items_sellers_regions": {
    tables: ["order_items", "sellers", "regions"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT oi.order_item_id) AS distinct_base " +
      "FROM public.order_items oi JOIN public.sellers s USING (seller_id) JOIN public.regions r USING (province)",
  },
  "join_rule:orders_reviews": {
    tables: ["orders", "reviews"],
    query:
      "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT o.order_id) AS distinct_base " +
      "FROM public.orders o JOIN public.reviews r USING (order_id)",
  },
};

/**
 * 4. Validate that join keys in joins.yaml return >= 1 row and record empirical fan-out ratios.
 */
export async function verifyJoinsAndFanout(
  client: VerifySemanticClient,
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): Promise<{ failures: string[]; checkedJoins: number; fanoutRatios: Record<string, number> }> {
  const failures: string[] = [];
  const fanoutRatios: Record<string, number> = {};
  let checkedJoins = 0;

  const joinsFile = path.join(semanticDir, "joins.yaml");
  if (!existsSync(joinsFile)) {
    return { failures, checkedJoins, fanoutRatios };
  }

  const data = parseYamlFile<{ chunks: JoinChunk[] }>(joinsFile);
  for (const chunk of data.chunks ?? []) {
    const canonical = CANONICAL_JOINS[chunk.chunkId];
    const sql = chunk.sql ?? chunk.joinSql ?? canonical?.query;

    if (!sql) {
      failures.push(
        `Join chunk ${chunk.chunkId} has no verifiable SQL query definition and no canonical mapping.`,
      );
      continue;
    }

    checkedJoins += 1;
    try {
      const res = await client.query(sql);
      const row = res.rows[0];
      const totalRows = Number(row?.["total_rows"] ?? 0);
      const distinctBase = Number(row?.["distinct_base"] ?? 0);

      if (totalRows < 1) {
        failures.push(`Join rule "${chunk.chunkId}" returned 0 rows (expected >= 1 row).`);
      }

      const ratio = distinctBase > 0 ? Number((totalRows / distinctBase).toFixed(4)) : 0;
      fanoutRatios[chunk.chunkId] = ratio;
    } catch (err) {
      failures.push(
        `Failed executing join verification for "${chunk.chunkId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { failures, checkedJoins, fanoutRatios };
}

/**
 * 5. Reject duplicate aliases across metrics.
 */
export function verifyMetricAliases(
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): { failures: string[]; aliasCount: number } {
  const failures: string[] = [];
  const metricsFile = path.join(semanticDir, "metrics.yaml");
  if (!existsSync(metricsFile)) {
    return { failures, aliasCount: 0 };
  }

  const data = parseYamlFile<{ chunks: MetricChunk[] }>(metricsFile);
  const aliasToMetric = new Map<string, string>();
  let aliasCount = 0;

  for (const chunk of data.chunks ?? []) {
    const metricName = chunk.metricName ?? chunk.chunkId;
    for (const rawAlias of chunk.aliases ?? []) {
      const normalized = rawAlias.trim().toLowerCase();
      if (!normalized) continue;
      aliasCount += 1;
      const existing = aliasToMetric.get(normalized);
      if (existing && existing !== metricName) {
        failures.push(
          `Duplicate alias "${normalized}" in metric "${metricName}" (already used by "${existing}").`,
        );
      } else {
        aliasToMetric.set(normalized, metricName);
      }
    }
  }

  return { failures, aliasCount };
}

/**
 * Full semantic verification suite against live PostgreSQL (agent_ro).
 */
export async function verifySemanticCorpus(
  client: VerifySemanticClient,
  options: VerifyOptions = {},
): Promise<SemanticVerifyReport> {
  const semanticDir = options.semanticDir ?? DEFAULT_SEMANTIC_DIR;
  const failures: string[] = [];
  const warnings: string[] = [];

  // Check 5: Duplicate aliases (pure file check)
  const aliasCheck = verifyMetricAliases(semanticDir);
  failures.push(...aliasCheck.failures);

  // Check 1: Information schema
  const schemaCheck = await verifyInformationSchema(client, semanticDir);
  failures.push(...schemaCheck.failures);

  // Check 2: Enum values
  const enumCheck = await verifyEnumValues(client, semanticDir);
  failures.push(...enumCheck.failures);

  // Check 3: Metrics EXPLAIN
  const metricsCheck = await verifyMetricsSql(client, semanticDir);
  failures.push(...metricsCheck.failures);

  // Check 4: Joins and fanout ratios
  const joinsCheck = await verifyJoinsAndFanout(client, semanticDir);
  failures.push(...joinsCheck.failures);

  return {
    failures,
    warnings,
    checkedTables: schemaCheck.checkedTables,
    checkedColumns: schemaCheck.checkedColumns,
    checkedEnums: enumCheck.checkedEnums,
    checkedMetrics: metricsCheck.checkedMetrics,
    checkedJoins: joinsCheck.checkedJoins,
    fanoutRatios: joinsCheck.fanoutRatios,
  };
}

/**
 * CLI runner for pnpm semantic:verify.
 */
export async function runCli(): Promise<void> {
  const dbUrl = process.env.AGENT_RO_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      "❌ semantic:verify failed: AGENT_RO_DATABASE_URL (or DATABASE_URL) environment variable is not set.",
    );
    process.exit(1);
  }

  console.log("🔍 Running semantic:verify against live PostgreSQL (agent_ro)...");
  const pool = new Pool({ connectionString: dbUrl, max: 2 });

  try {
    const report = await verifySemanticCorpus(pool);

    console.log(
      `✓ Checked ${report.checkedTables} tables, ${report.checkedColumns} columns against information_schema.`,
    );
    console.log(`✓ Checked ${report.checkedEnums} enum columns against SELECT DISTINCT.`);
    console.log(`✓ EXPLAIN succeeded on ${report.checkedMetrics} metric SQL templates.`);
    console.log(`✓ Verified ${report.checkedJoins} join rules (all returned >= 1 row):`);
    for (const [joinId, ratio] of Object.entries(report.fanoutRatios)) {
      console.log(`   • ${joinId}: empirical fan-out ratio = ${ratio}`);
    }

    if (report.failures.length > 0) {
      console.error(`\n❌ semantic:verify failed with ${report.failures.length} errors:`);
      for (const failure of report.failures) {
        console.error(`  - ${failure}`);
      }
      process.exit(1);
    }

    console.log("\n✅ All semantic corpus checks passed cleanly!");
  } catch (err) {
    console.error(`\n❌ Fatal error during semantic verification: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    process.argv[1].endsWith("verify.ts") ||
    process.argv[1].endsWith("verify.js"));

if (isMain) {
  void runCli();
}
