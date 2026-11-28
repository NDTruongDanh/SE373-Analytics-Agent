import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEMANTIC_DIR,
  verifyEnumValues,
  verifyInformationSchema,
  verifyJoinsAndFanout,
  verifyMetricAliases,
  verifyMetricsSql,
  verifySemanticCorpus,
  verifySemanticCorpusWithPool,
  verifySemanticIndexed,
  verifySemanticIndexedWithPool,
  type VerifySemanticClient,
  type VerifySemanticPool,
} from "../src/semantic/verify.js";
import { chunkYaml, contentHash } from "../src/semantic/index.js";

describe("verifyMetricAliases", () => {
  it("passes cleanly on the committed semantic/metrics.yaml without duplicate aliases", () => {
    const report = verifyMetricAliases(DEFAULT_SEMANTIC_DIR);
    expect(report.failures).toEqual([]);
    expect(report.aliasCount).toBeGreaterThan(50);
  });

  it("rejects duplicate aliases across distinct metrics", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const yaml = `
chunks:
  - chunkId: "metric:rev1"
    metricName: "net_revenue"
    aliases: ["revenue", "doanh thu"]
    sql: "SELECT 1"
  - chunkId: "metric:rev2"
    metricName: "gross_revenue"
    aliases: ["doanh thu", "gross sales"]
    sql: "SELECT 2"
`;
      writeFileSync(path.join(tmpDir, "metrics.yaml"), yaml, "utf8");
      const report = verifyMetricAliases(tmpDir);
      expect(report.failures.length).toBe(1);
      expect(report.failures[0]).toMatch(/Duplicate alias "doanh thu"/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifyInformationSchema", () => {
  it("passes when all declared tables and columns exist in information_schema", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const tablesYaml = `
chunks:
  - chunkId: "table:orders"
    table: "orders"
    columns: ["order_id", "status"]
`;
      const columnsYaml = `
chunks:
  - chunkId: "column:orders.status"
    table: "orders"
    column: "orders.status"
`;
      writeFileSync(path.join(tmpDir, "tables.yaml"), tablesYaml, "utf8");
      writeFileSync(path.join(tmpDir, "columns.yaml"), columnsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          if (sql.includes("information_schema.tables")) {
            return { rows: [{ table_name: "orders" }] };
          }
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                { table_name: "orders", column_name: "order_id" },
                { table_name: "orders", column_name: "status" },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const res = await verifyInformationSchema(mockClient, tmpDir);
      expect(res.failures).toEqual([]);
      expect(res.checkedTables).toBe(1);
      expect(res.checkedColumns).toBe(3); // 2 in tables.yaml + 1 in columns.yaml
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches missing tables and columns in information_schema", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const tablesYaml = `
chunks:
  - chunkId: "table:orders"
    table: "orders"
    columns: ["order_id", "non_existent_col"]
  - chunkId: "table:non_existent_table"
    table: "non_existent_table"
    columns: ["id"]
`;
      writeFileSync(path.join(tmpDir, "tables.yaml"), tablesYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          if (sql.includes("information_schema.tables")) {
            return { rows: [{ table_name: "orders" }] };
          }
          if (sql.includes("information_schema.columns")) {
            return { rows: [{ table_name: "orders", column_name: "order_id" }] };
          }
          return { rows: [] };
        },
      };

      const res = await verifyInformationSchema(mockClient, tmpDir);
      expect(res.failures.length).toBe(3);
      expect(res.failures.some((f) => f.includes("Table \"non_existent_table\""))).toBe(true);
      expect(res.failures.some((f) => f.includes("Column \"orders.non_existent_col\""))).toBe(true);
      expect(res.failures.some((f) => f.includes("Column \"non_existent_table.id\""))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifyEnumValues", () => {
  it("passes when SELECT DISTINCT matches enumValues exactly", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const columnsYaml = `
chunks:
  - chunkId: "column:orders.status"
    table: "orders"
    column: "orders.status"
    enumValues: ["delivered", "shipped", "canceled"]
`;
      writeFileSync(path.join(tmpDir, "columns.yaml"), columnsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          return {
            rows: [{ val: "delivered" }, { val: "shipped" }, { val: "canceled" }],
          };
        },
      };

      const res = await verifyEnumValues(mockClient, tmpDir);
      expect(res.failures).toEqual([]);
      expect(res.checkedEnums).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches missing and unexpected enum values", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const columnsYaml = `
chunks:
  - chunkId: "column:orders.status"
    table: "orders"
    column: "orders.status"
    enumValues: ["delivered", "shipped", "returned"]
`;
      writeFileSync(path.join(tmpDir, "columns.yaml"), columnsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          // DB is missing 'returned' and has unexpected 'canceled'
          return {
            rows: [{ val: "delivered" }, { val: "shipped" }, { val: "canceled" }],
          };
        },
      };

      const res = await verifyEnumValues(mockClient, tmpDir);
      expect(res.failures.length).toBe(1);
      expect(res.failures[0]).toMatch(/enumValues mismatch for orders.status/);
      expect(res.failures[0]).toMatch(/missing in DB: returned/);
      expect(res.failures[0]).toMatch(/unexpected in DB: canceled/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifyMetricsSql", () => {
  it("runs EXPLAIN on all metrics and substitutes parameter placeholders while preserving ::numeric casts", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const metricsYaml = `
chunks:
  - chunkId: "metric:new_customers"
    metricName: "new_customers"
    sql: "SELECT COUNT(*)::numeric FROM orders WHERE purchase_date >= :period_start AND purchase_date < :period_end"
`;
      writeFileSync(path.join(tmpDir, "metrics.yaml"), metricsYaml, "utf8");

      const executedQueries: string[] = [];
      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          executedQueries.push(sql);
          return { rows: [] };
        },
      };

      const res = await verifyMetricsSql(mockClient, tmpDir);
      expect(res.failures).toEqual([]);
      expect(res.checkedMetrics).toBe(1);
      expect(executedQueries[0]).toMatch(/^EXPLAIN /);
      expect(executedQueries[0]).toContain("COUNT(*)::numeric");
      expect(executedQueries[0]).not.toContain(":period_start");
      expect(executedQueries[0]).toContain("'2026-01-01'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches EXPLAIN syntax / schema failure on metric SQL", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const metricsYaml = `
chunks:
  - chunkId: "metric:broken"
    metricName: "broken_metric"
    sql: "SELECT invalid_syntax FROM"
`;
      writeFileSync(path.join(tmpDir, "metrics.yaml"), metricsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          throw new Error('syntax error at or near "FROM"');
        },
      };

      const res = await verifyMetricsSql(mockClient, tmpDir);
      expect(res.failures.length).toBe(1);
      expect(res.failures[0]).toMatch(/EXPLAIN failed for metric broken_metric/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifyJoinsAndFanout", () => {
  it("confirms join keys return >= 1 row and records empirical fan-out ratios", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const joinsYaml = `
chunks:
  - chunkId: "join_rule:orders_order_items"
    table: "orders"
    tables: ["orders", "order_items"]
`;
      writeFileSync(path.join(tmpDir, "joins.yaml"), joinsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          return {
            rows: [{ total_rows: 240, distinct_base: 100 }],
          };
        },
      };

      const res = await verifyJoinsAndFanout(mockClient, tmpDir);
      expect(res.failures).toEqual([]);
      expect(res.checkedJoins).toBe(1);
      expect(res.fanoutRatios["join_rule:orders_order_items"]).toBe(2.4);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects joins that return 0 rows", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const joinsYaml = `
chunks:
  - chunkId: "join_rule:orders_order_items"
    table: "orders"
    tables: ["orders", "order_items"]
`;
      writeFileSync(path.join(tmpDir, "joins.yaml"), joinsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          return {
            rows: [{ total_rows: 0, distinct_base: 0 }],
          };
        },
      };

      const res = await verifyJoinsAndFanout(mockClient, tmpDir);
      expect(res.failures.length).toBe(1);
      expect(res.failures[0]).toMatch(/returned 0 rows/);
      expect(res.fanoutRatios["join_rule:orders_order_items"]).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails when declared cardinality is 1:1 or N:1 but empirical fan-out ratio exceeds 1.0", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const joinsYaml = `
chunks:
  - chunkId: "join_rule:orders_customers_regions"
    table: "orders"
    tables: ["orders", "customers"]
    cardinality: "N:1"
`;
      writeFileSync(path.join(tmpDir, "joins.yaml"), joinsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          return {
            rows: [{ total_rows: 150, distinct_base: 100 }],
          };
        },
      };

      const res = await verifyJoinsAndFanout(mockClient, tmpDir);
      expect(res.failures.length).toBe(1);
      expect(res.failures[0]).toMatch(/declared cardinality "N:1" but empirical fanout ratio is 1.5/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes when declared cardinality 1:N has empirical fan-out ratio > 1.0", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      const joinsYaml = `
chunks:
  - chunkId: "join_rule:orders_order_items"
    table: "orders"
    tables: ["orders", "order_items"]
    cardinality: "1:N"
`;
      writeFileSync(path.join(tmpDir, "joins.yaml"), joinsYaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query() {
          return {
            rows: [{ total_rows: 240, distinct_base: 100 }],
          };
        },
      };

      const res = await verifyJoinsAndFanout(mockClient, tmpDir);
      expect(res.failures).toEqual([]);
      expect(res.fanoutRatios["join_rule:orders_order_items"]).toBe(2.4);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifySemanticCorpus (full suite)", () => {
  it("aggregates checks across all semantic corpus files", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      writeFileSync(
        path.join(tmpDir, "metrics.yaml"),
        `chunks:
  - chunkId: "metric:m1"
    metricName: "m1"
    aliases: ["alias1"]
    sql: "SELECT 1"`,
        "utf8",
      );
      writeFileSync(
        path.join(tmpDir, "tables.yaml"),
        `chunks:
  - chunkId: "table:orders"
    table: "orders"
    columns: ["id"]`,
        "utf8",
      );
      writeFileSync(
        path.join(tmpDir, "columns.yaml"),
        `chunks:
  - chunkId: "column:orders.status"
    table: "orders"
    column: "orders.status"
    enumValues: ["delivered"]`,
        "utf8",
      );
      writeFileSync(
        path.join(tmpDir, "joins.yaml"),
        `chunks:
  - chunkId: "join_rule:orders_order_items"
    table: "orders"
    tables: ["orders", "order_items"]`,
        "utf8",
      );

      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          if (sql.includes("information_schema.tables")) {
            return { rows: [{ table_name: "orders" }] };
          }
          if (sql.includes("information_schema.columns")) {
            return {
              rows: [
                { table_name: "orders", column_name: "id" },
                { table_name: "orders", column_name: "status" },
              ],
            };
          }
          if (sql.includes("total_rows")) {
            return { rows: [{ total_rows: 10, distinct_base: 5 }] };
          }
          if (sql.includes("DISTINCT")) {
            return { rows: [{ val: "delivered" }] };
          }
          if (sql.includes("EXPLAIN")) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const report = await verifySemanticCorpus(mockClient, { semanticDir: tmpDir });
      expect(report.failures).toEqual([]);
      expect(report.checkedTables).toBe(1);
      expect(report.checkedColumns).toBe(2);
      expect(report.checkedEnums).toBe(1);
      expect(report.checkedMetrics).toBe(1);
      expect(report.checkedJoins).toBe(1);
      expect(report.fanoutRatios["join_rule:orders_order_items"]).toBe(2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifyEnumValues identifier quoting", () => {
  it("escapes embedded double quotes in table and column identifiers", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
    try {
      writeFileSync(
        path.join(tmpDir, "columns.yaml"),
        `chunks:
  - chunkId: "column:odd.col"
    table: 'odd"table'
    column: 'weird"col'
    enumValues: ["ok"]`,
        "utf8",
      );
      const queries: string[] = [];
      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          queries.push(sql);
          return { rows: [{ val: "ok" }] };
        },
      };
      const res = await verifyEnumValues(mockClient, tmpDir);
      expect(res.failures).toEqual([]);
      expect(queries[0]).toBe(
        'SELECT DISTINCT "weird""col" AS val FROM public."odd""table" WHERE "weird""col" IS NOT NULL',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifySemanticCorpusWithPool", () => {
  it("sets BEGIN READ ONLY, statement_timeout, and unscoped RLS context before verifying", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-pool-"));
    try {
      const executed: Array<{ sql: string; params?: unknown[] }> = [];
      let releasedArg: unknown = "not-called";
      const mockPool: VerifySemanticPool = {
        async connect() {
          return {
            async query(sql: string, params?: unknown[]) {
              executed.push({ sql, params });
              return { rows: [] };
            },
            release(destroy?: boolean | Error) {
              releasedArg = destroy;
            },
          };
        },
      };

      const report = await verifySemanticCorpusWithPool(mockPool, { semanticDir: tmpDir });
      expect(report.failures).toEqual([]);
      expect(executed[0]?.sql).toBe("BEGIN READ ONLY");
      expect(executed[1]?.sql).toContain("statement_timeout");
      expect(executed[2]?.sql).toContain("set_config('app.role'");
      expect(executed[2]?.params).toEqual(["admin", "*"]);
      expect(executed.at(-1)?.sql).toBe("ROLLBACK");
      expect(releasedArg).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("destroys the pooled client when ROLLBACK throws", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-pool-"));
    try {
      let releasedArg: unknown;
      const mockPool: VerifySemanticPool = {
        async connect() {
          return {
            async query(sql: string) {
              if (sql === "ROLLBACK") throw new Error("connection lost");
              return { rows: [] };
            },
            release(destroy?: boolean | Error) {
              releasedArg = destroy;
            },
          };
        },
      };

      await verifySemanticCorpusWithPool(mockPool, { semanticDir: tmpDir });
      expect(releasedArg).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("verifySemanticIndexed", () => {
  it("passes when all corpus chunks are indexed with matching content_hash and embeddings", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-idx-"));
    try {
      const yaml = `
chunks:
  - chunkId: "table:orders"
    table: "orders"
    content: "Orders table"
  - chunkId: "metric:gmv"
    metricName: "gmv"
    content: "Gross Merchandise Value"
`;
      writeFileSync(path.join(tmpDir, "tables.yaml"), yaml, "utf8");
      const parsed = chunkYaml("tables", yaml, "table");

      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          if (sql.includes("FROM semantic.semantic_chunks")) {
            return {
              rows: parsed.map((chunk) => ({
                chunk_id: chunk.chunkId,
                content_hash: contentHash(chunk),
                has_embedding: true,
              })),
            };
          }
          if (sql.includes("FROM semantic.corpus_version")) {
            return { rows: [{ version: 3 }] };
          }
          return { rows: [] };
        },
      };

      const report = await verifySemanticIndexed(mockClient, { semanticDir: tmpDir });
      expect(report.failures).toEqual([]);
      expect(report.expectedChunks).toBe(2);
      expect(report.indexedChunks).toBe(2);
      expect(report.embeddedChunks).toBe(2);
      expect(report.corpusVersion).toBe(3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when semantic.semantic_chunks is empty", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-idx-empty-"));
    try {
      writeFileSync(
        path.join(tmpDir, "tables.yaml"),
        `chunks:\n  - chunkId: "table:orders"\n    table: "orders"\n    content: "Orders"\n`,
        "utf8",
      );
      const mockClient: VerifySemanticClient = {
        async query() {
          return { rows: [] };
        },
      };

      const report = await verifySemanticIndexed(mockClient, { semanticDir: tmpDir });
      expect(report.failures.length).toBe(1);
      expect(report.failures[0]).toMatch(/not indexed.*0 rows/);
      expect(report.missingChunks).toEqual(["table:orders"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects missing, stale, unembedded, and orphaned chunks", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-idx-drift-"));
    try {
      const yaml = `
chunks:
  - chunkId: "table:orders"
    table: "orders"
    content: "Orders updated"
  - chunkId: "table:customers"
    table: "customers"
    content: "Customers"
`;
      writeFileSync(path.join(tmpDir, "tables.yaml"), yaml, "utf8");

      const mockClient: VerifySemanticClient = {
        async query(sql: string) {
          if (sql.includes("FROM semantic.semantic_chunks")) {
            return {
              rows: [
                { chunk_id: "table:orders", content_hash: "stale-hash", has_embedding: false },
                { chunk_id: "table:legacy", content_hash: "old-hash", has_embedding: true },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const report = await verifySemanticIndexed(mockClient, { semanticDir: tmpDir });
      expect(report.missingChunks).toEqual(["table:customers"]);
      expect(report.staleChunks).toEqual(["table:orders"]);
      expect(report.unembeddedChunks).toEqual(["table:orders"]);
      expect(report.orphanedChunks).toEqual(["table:legacy"]);
      expect(report.failures.length).toBe(4);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs inside a read-only transaction via verifySemanticIndexedWithPool", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "semantic-idx-pool-"));
    try {
      writeFileSync(
        path.join(tmpDir, "tables.yaml"),
        `chunks:\n  - chunkId: "table:orders"\n    table: "orders"\n    content: "Orders"\n`,
        "utf8",
      );
      const executed: string[] = [];
      const mockPool: VerifySemanticPool = {
        async connect() {
          return {
            async query(sql: string) {
              executed.push(sql);
              return { rows: [] };
            },
            release() {},
          };
        },
      };

      const report = await verifySemanticIndexedWithPool(mockPool, { semanticDir: tmpDir });
      expect(report.failures.length).toBe(1);
      expect(executed[0]).toBe("BEGIN READ ONLY");
      expect(executed[1]).toContain("statement_timeout");
      expect(executed.at(-1)).toBe("ROLLBACK");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
