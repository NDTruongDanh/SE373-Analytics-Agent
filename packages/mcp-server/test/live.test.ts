// Semantic live suite (MCP-02, D-21): indexes the two committed corpus
// files through the fake embedder, then proves hybrid retrieval plus the
// data:sensitive split on the real role grants. Skips green without DB
// URLs so unit CI stays DB-free; the 01-08 verify runs it live.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createFakeEmbedder } from "../src/semantic/embedder.js";
import { hybridSearch } from "../src/semantic/retriever.js";
import { indexCorpus } from "../src/semantic/index.js";
import { executeResourceRead } from "../src/pipeline.js";
import type { GatewayDeps } from "../src/pipeline.js";
import { ColumnScopePolicy } from "@se373/access-policy";
import { buildCatalog, fetchCatalogSource } from "../src/catalog.js";
import { loadSensitiveColumns } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const HAS_DB = Boolean(process.env["DATABASE_URL"]) && Boolean(process.env["INDEXER_DATABASE_URL"]);
const describeLive = HAS_DB ? describe : describe.skip;

const FAKE = createFakeEmbedder();

function agentRoQuery(text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: 2 });
  return pool
    .query(text, params as unknown[])
    .then((result) => ({ rows: result.rows as Record<string, unknown>[] }))
    .finally(() => pool.end().catch(() => undefined));
}

describeLive("semantic live", () => {
  it("indexes the corpus incrementally through the fake embedder", async () => {
    const first = await indexCorpus({
      dbUrl: process.env["INDEXER_DATABASE_URL"] as string,
      embedder: FAKE,
      files: [
        { path: path.join(ROOT, "semantic/data_dictionary.md"), docType: "table" },
        { path: path.join(ROOT, "semantic/metrics.md"), docType: "metric" },
      ],
    });
    expect(first.added + first.updated + first.skipped).toBeGreaterThan(0);
    const second = await indexCorpus({
      dbUrl: process.env["INDEXER_DATABASE_URL"] as string,
      embedder: FAKE,
      files: [
        { path: path.join(ROOT, "semantic/data_dictionary.md"), docType: "table" },
        { path: path.join(ROOT, "semantic/metrics.md"), docType: "metric" },
      ],
    });
    // Re-run is fully incremental: nothing to add or update.
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(first.added + first.updated + first.skipped);
  });

  it("returns fused chunks with scores for a revenue query", async () => {
    const chunks = await hybridSearch(agentRoQuery, FAKE, "doanh thu revenue", 5, true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(5);
    for (const chunk of chunks) {
      expect(chunk.chunkId.length).toBeGreaterThan(0);
      expect(typeof chunk.score).toBe("number");
      expect(chunk.score).toBeGreaterThan(0);
    }
    expect(chunks.some((chunk) => chunk.tables.includes("orders"))).toBe(true);
  });

  it("withholds restricted_pii chunks without data:sensitive and shows them to hr", async () => {
    const sales = await hybridSearch(agentRoQuery, FAKE, "compensation payroll", 10, false);
    const hr = await hybridSearch(agentRoQuery, FAKE, "compensation payroll", 10, true);
    expect(hr.some((chunk) => chunk.chunkId.includes("compensation"))).toBe(true);
    expect(sales.some((chunk) => chunk.chunkId.includes("compensation"))).toBe(false);
  });

  it("filters the real corpus resources by scope", async () => {
    const sensitive = loadSensitiveColumns(
      readFileSync(path.join(ROOT, "policies/sensitive_columns.yaml"), "utf8"),
    );
    const pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: 2 });
    try {
      const source = await fetchCatalogSource(async (text) => {
        const result = await pool.query(text);
        return { rows: result.rows as Record<string, unknown>[] };
      });
      const deps: GatewayDeps = {
        clients: [
          {
            clientId: "sales_south",
            role: "sales_south",
            scopes: ["schema:read", "data:read"],
            rowScope: null,
            token: "sales-token",
          },
          {
            clientId: "hr",
            role: "hr",
            scopes: ["schema:read", "data:read", "data:sensitive"],
            rowScope: null,
            token: "hr-token",
          },
        ],
        catalog: buildCatalog(source, sensitive),
        policy: new ColumnScopePolicy(sensitive.columns.map((entry) => ({ ...entry }))),
        sessionFactory: async () => {
          throw new Error("no SQL in the resource leg");
        },
        search: async () => [],
      };
      const documents = [
        {
          uri: "semantic://metrics",
          text: readFileSync(path.join(ROOT, "semantic/metrics.md"), "utf8"),
        },
      ];
      const salesHeaders = { authorization: "Bearer sales-token" };
      const sales = await executeResourceRead(deps, salesHeaders, "semantic://metrics", documents);
      expect(sales.ok).toBe(true);
      if (sales.ok) {
        expect((sales.data as { text: string }).text).not.toContain("compensation_cost");
      }
      const hr = await executeResourceRead(
        deps,
        { authorization: "Bearer hr-token" },
        "semantic://metrics",
        documents,
      );
      expect(hr.ok).toBe(true);
      if (hr.ok) {
        expect((hr.data as { text: string }).text).toContain("compensation_cost");
      }
    } finally {
      await pool.end();
    }
  });
});

afterAll(async () => {
  // Pools are per-call above; nothing shared to drain.
});
