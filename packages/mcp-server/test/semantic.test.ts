// Semantic unit suite (MCP-02): fake embedder shape and determinism,
// RRF ordering at k=60, resource section filtering, and the storage to
// contract camelCase mapping. Fully DB-free.
import { describe, expect, it, beforeEach } from "vitest";
import { createFakeEmbedder } from "../src/semantic/embedder.js";
import {
  fuseRRF,
  rrfScore,
  RRF_K,
  W_DENSE,
  W_BM25,
  W_ALIAS,
  DEFAULT_RRF_WEIGHTS,
} from "../src/semantic/rrf.js";
import {
  toContractChunk,
  hybridSearch,
  foldAscii,
  tokenizeForBm25,
  Bm25Retriever,
  scoreBm25,
  matchAliases,
  expandJoinRules,
  getCitationCatalog,
  resetSemanticCache,
  BM25_K1,
  BM25_B,
  type RetrieverQuery,
} from "../src/semantic/retriever.js";
import { chunkMarkdown } from "../src/semantic/index.js";
import { filterResourceSections } from "../src/pipeline.js";

describe("fake embedder", () => {
  it("emits exactly 1536 dims, L2-normalized, deterministic across calls", async () => {
    const embedder = createFakeEmbedder();
    expect(embedder.dimensions).toBe(1536);
    const [first, second, other] = await embedder.embed([
      "doanh thu theo đơn hàng",
      "doanh thu theo đơn hàng",
      "chi phí nhân sự",
    ]);
    expect(first).toHaveLength(1536);
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    const norm = Math.sqrt(
      (first as number[]).reduce((sum, value) => sum + value * value, 0),
    );
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe("fuseRRF", () => {
  it("orders by fused score at k=60 with stable tie-breaking", () => {
    expect(RRF_K).toBe(60);
    // b outranks a: b leads one leg and trails the other by one rank.
    const fused = fuseRRF([["a", "b"], ["b"]], {
      k: 60,
      topK: 2,
      idOf: (item) => item,
    });
    expect(fused).toEqual(["b", "a"]);
    // Exact tie (a first in list 0, b first in list 1) breaks by first-seen.
    const tied = fuseRRF([["a", "b"], ["b", "a"]], {
      k: 60,
      topK: 2,
      idOf: (item) => item,
    });
    expect(tied[0]).toBe("a");
    expect(rrfScore([1, 2], 60)).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(rrfScore([undefined, 1], 60)).toBeCloseTo(1 / 61, 12);
  });

  it("truncates to topK", () => {
    const fused = fuseRRF([["a", "b", "c", "d"]], {
      k: 60,
      topK: 2,
      idOf: (item) => item,
    });
    expect(fused).toEqual(["a", "b"]);
  });
});

describe("resource section filter", () => {
  const text = "## Public bit\n\nOpen.\n\n## Salary bands [restricted_pii]\n\nShut.\n";
  it("withholds restricted sections without data:sensitive", () => {
    const filtered = filterResourceSections(text, false);
    expect(filtered).toContain("Open.");
    expect(filtered).not.toContain("Shut.");
  });
  it("keeps everything with data:sensitive", () => {
    expect(filterResourceSections(text, true)).toContain("Shut.");
  });
});

describe("storage to contract mapping", () => {
  it("maps snake_case storage to the camelCase contract shape", () => {
    const chunk = toContractChunk(
      {
        chunk_id: "metrics:revenue_vnd",
        doc_type: "metric",
        table_name: null,
        tables: "orders,order_items",
        metric_name: "revenue_vnd",
        content: "revenue",
      },
      0.5,
    );
    expect(chunk).toEqual({
      chunkId: "metrics:revenue_vnd",
      docType: "metric",
      table: null,
      tables: ["orders", "order_items"],
      metricName: "revenue_vnd",
      content: "revenue",
      score: 0.5,
    });
  });
});

describe("corpus chunker", () => {
  it("splits sections, parses metadata and tags restricted headers", () => {
    const chunks = chunkMarkdown(
      "metrics",
      "Preamble is skipped.\n\n## revenue_vnd\nMetric: revenue_vnd\nTables: orders, order_items\nAliases: doanh thu, revenue\n\nBody.\n\n## pay [restricted_pii]\nMetric: pay\n\nSecret.\n",
      "metric",
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.chunkId).toBe("metrics:revenue-vnd");
    expect(chunks[0]?.metricName).toBe("revenue_vnd");
    expect(chunks[0]?.tables).toEqual(["orders", "order_items"]);
    expect(chunks[0]?.aliases).toEqual(["doanh thu", "revenue"]);
    expect(chunks[0]?.sensitivity).toBe("public");
    expect(chunks[1]?.sensitivity).toBe("restricted_pii");
  });
});

// ---------------------------------------------------------------------------
// UC-02: 3-way hybrid RRF, BM25, alias matcher, join expansion, hot-reload.
// ---------------------------------------------------------------------------

function makeCatalogRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    chunk_id: "test:chunk",
    doc_type: "metric",
    table_name: null,
    tables: "",
    metric_name: null,
    aliases: null,
    sensitivity: "public",
    content: "test content",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMockQuery(state: {
  maxTs: string;
  total: number;
  catalog: Record<string, unknown>[];
  vectorOrder?: string[];
}): RetrieverQuery {
  return async (sql: string) => {
    if (sql.includes("MAX(updated_at)")) {
      return { rows: [{ max_ts: state.maxTs, total: state.total }] };
    }
    if (
      sql.includes("FROM semantic.semantic_chunks") &&
      sql.includes("updated_at") &&
      !sql.includes("embedding") &&
      !sql.includes("MAX")
    ) {
      return { rows: state.catalog };
    }
    if (sql.includes("embedding")) {
      const restrictedOnly = sql.includes("restricted_pii");
      let pool = state.catalog;
      if (restrictedOnly) {
        pool = pool.filter(
          (row) => String(row["sensitivity"] ?? "") !== "restricted_pii",
        );
      }
      const order =
        state.vectorOrder ?? pool.map((row) => String(row["chunk_id"]));
      const byId = new Map(pool.map((row) => [String(row["chunk_id"]), row]));
      const rows = order
        .map((id, index) => {
          const base = byId.get(id);
          if (!base) return null;
          return { ...base, dense_score: 0.9 - index * 0.05 };
        })
        .filter((row) => row !== null) as Record<string, unknown>[];
      // Include any pool rows missing from the explicit order at the tail.
      const seen = new Set(rows.map((row) => String(row["chunk_id"])));
      for (const row of pool) {
        if (!seen.has(String(row["chunk_id"]))) {
          rows.push({ ...row, dense_score: 0.1 });
        }
      }
      return { rows };
    }
    return { rows: [] };
  };
}

describe("weighted 3-way RRF", () => {
  beforeEach(() => {
    resetSemanticCache();
  });

  it("uses DEFAULT_RRF_WEIGHTS [1.0, 1.0, 1.5] and boosts alias rank-1 above single-leg hits", () => {
    expect(W_DENSE).toBe(1.0);
    expect(W_BM25).toBe(1.0);
    expect(W_ALIAS).toBe(1.5);
    expect([...DEFAULT_RRF_WEIGHTS]).toEqual([1.0, 1.0, 1.5]);

    // Weighted: alias-only at rank 1 outranks vector-only or bm25-only at rank 1.
    const fused = fuseRRF([["vectorOnly"], ["bm25Only"], ["aliasOnly"]], {
      k: 60,
      topK: 3,
      idOf: (item) => item,
      weights: DEFAULT_RRF_WEIGHTS,
    });
    expect(fused[0]).toBe("aliasOnly");

    const vectorScore = rrfScore([1, undefined, undefined], 60, DEFAULT_RRF_WEIGHTS);
    const bm25Score = rrfScore([undefined, 1, undefined], 60, DEFAULT_RRF_WEIGHTS);
    const aliasScore = rrfScore([undefined, undefined, 1], 60, DEFAULT_RRF_WEIGHTS);
    expect(aliasScore).toBeCloseTo(1.5 / 61, 12);
    expect(vectorScore).toBeCloseTo(1 / 61, 12);
    expect(bm25Score).toBeCloseTo(1 / 61, 12);
    expect(aliasScore).toBeGreaterThan(vectorScore);
    expect(aliasScore).toBeGreaterThan(bm25Score);
  });

  it("omitted weights behave like unweighted RRF", () => {
    expect(rrfScore([1, 2], 60)).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(rrfScore([1, 2], 60, undefined)).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });
});

describe("Okapi BM25 with Vietnamese diacritics", () => {
  beforeEach(() => {
    resetSemanticCache();
  });

  it("exposes k1=1.2 and b=0.75", () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
  });

  it("foldAscii strips Vietnamese diacritics", () => {
    expect(foldAscii("Doanh Số Ròng")).toBe("doanh so rong");
    expect(foldAscii("đơn hàng")).toBe("don hang");
  });

  it("tokenizeForBm25 emits accented and folded variants with sub-tokens", () => {
    const tokens = tokenizeForBm25("doanh số ròng");
    expect(tokens).toContain("số");
    expect(tokens).toContain("so");
    expect(tokens).toContain("ròng");
    expect(tokens).toContain("rong");

    const compound = tokenizeForBm25("orders.status");
    expect(compound).toContain("orders.status");
    expect(compound).toContain("orders");
    expect(compound).toContain("status");

    const snake = tokenizeForBm25("order_items");
    expect(snake).toContain("order_items");
    expect(snake).toContain("order");
    expect(snake).toContain("items");
  });

  it("scoreBm25 follows the non-negative Okapi formula", () => {
    // dl == avgdl collapses the TF norm to 1, leaving pure IDF.
    const idf = Math.log(1 + (10 - 0 + 0.5) / (0 + 0.5));
    expect(scoreBm25(1, 0, 10, 5, 5)).toBeCloseTo(idf, 12);
    expect(scoreBm25(0, 0, 10, 5, 5)).toBe(0);
  });

  it("matches accented and ASCII-folded queries to the same chunk", () => {
    const rows = [
      makeCatalogRow({
        chunk_id: "metric:net_revenue",
        doc_type: "metric",
        metric_name: "net_revenue",
        aliases: "net sales,doanh số ròng",
        tables: "orders,order_items",
        content: "doanh số ròng là doanh thu thuần sau hoàn trả",
      }),
      makeCatalogRow({
        chunk_id: "table:customers",
        doc_type: "table",
        table_name: "customers",
        tables: "customers",
        content: "khách hàng và thông tin liên hệ",
      }),
    ];
    const retriever = new Bm25Retriever();
    retriever.index(rows);
    const accented = retriever.search("doanh số ròng", 5, true);
    const folded = retriever.search("doanh so rong", 5, true);
    expect(accented.length).toBeGreaterThan(0);
    expect(folded.length).toBeGreaterThan(0);
    expect(accented[0]?.id).toBe("metric:net_revenue");
    expect(folded[0]?.id).toBe("metric:net_revenue");
  });

  it("respects allowRestricted", () => {
    const rows = [
      makeCatalogRow({
        chunk_id: "column:customers.phone",
        doc_type: "column",
        table_name: "customers",
        tables: "customers",
        content: "số điện thoại khách hàng phone number",
        sensitivity: "restricted_pii",
      }),
      makeCatalogRow({
        chunk_id: "table:orders",
        doc_type: "table",
        table_name: "orders",
        tables: "orders",
        content: "đơn hàng orders",
      }),
    ];
    const retriever = new Bm25Retriever();
    retriever.index(rows);
    const open = retriever.search("phone", 5, false);
    expect(open.map((hit) => hit.id)).not.toContain("column:customers.phone");
    const privileged = retriever.search("phone", 5, true);
    expect(privileged.map((hit) => hit.id)).toContain("column:customers.phone");
  });
});

describe("alias and identifier matcher", () => {
  beforeEach(() => {
    resetSemanticCache();
  });

  const aliasRows = [
    makeCatalogRow({
      chunk_id: "metric:net_revenue",
      doc_type: "metric",
      metric_name: "net_revenue",
      aliases: "net sales,doanh số ròng",
      tables: "orders,order_items",
      content: "net revenue definition",
    }),
    makeCatalogRow({
      chunk_id: "column:orders.status",
      doc_type: "column",
      table_name: "orders",
      tables: "orders",
      content: "order status column",
    }),
  ];

  it("matches exact and substring aliases, ranking exact first", () => {
    expect(matchAliases("doanh số ròng", aliasRows, true)).toEqual([
      "metric:net_revenue",
    ]);
    expect(matchAliases("net sales", aliasRows, true)).toContain(
      "metric:net_revenue",
    );
    expect(matchAliases("orders.status", aliasRows, true)).toContain(
      "column:orders.status",
    );
    // Substring on phrase boundaries still matches.
    expect(
      matchAliases("tính doanh số ròng tháng 8", aliasRows, true),
    ).toContain("metric:net_revenue");
  });

  it("hybridSearch sets aliasMatched=true on alias or metric hits", async () => {
    const embedder = createFakeEmbedder();
    const state = {
      maxTs: "100",
      total: aliasRows.length,
      catalog: aliasRows,
      vectorOrder: ["column:orders.status", "metric:net_revenue"],
    };
    const results = await hybridSearch(
      makeMockQuery(state),
      embedder,
      "doanh số ròng",
      5,
      true,
    );
    const netRevenue = results.find(
      (chunk) => chunk.chunkId === "metric:net_revenue",
    );
    expect(netRevenue).toBeDefined();
    expect(netRevenue?.aliasMatched).toBe(true);
  });
});

describe("automatic join-rule graph expansion", () => {
  beforeEach(() => {
    resetSemanticCache();
  });

  it("injects the covering join_rule when top-5 touches >= 2 tables", async () => {
    const catalog = [
      makeCatalogRow({
        chunk_id: "table:orders",
        doc_type: "table",
        table_name: "orders",
        tables: "orders",
        content: "orders grain one row per order",
      }),
      makeCatalogRow({
        chunk_id: "table:order_items",
        doc_type: "table",
        table_name: "order_items",
        tables: "order_items",
        content: "order items grain one row per item",
      }),
      makeCatalogRow({
        chunk_id: "table:payments",
        doc_type: "table",
        table_name: "payments",
        tables: "payments",
        content: "payments grain one row per payment attempt",
      }),
      makeCatalogRow({
        chunk_id: "join_rule:orders_items_payments",
        doc_type: "join_rule",
        table_name: null,
        tables: "orders,order_items,payments",
        content: "Warning fan-out: pre-aggregate payments before joining orders",
      }),
      makeCatalogRow({
        chunk_id: "metric:net_revenue",
        doc_type: "metric",
        metric_name: "net_revenue",
        aliases: "net sales",
        tables: "orders,order_items",
        content: "net revenue formula",
      }),
    ];
    const embedder = createFakeEmbedder();
    const state = {
      maxTs: "300",
      total: catalog.length,
      catalog,
      vectorOrder: [
        "table:orders",
        "table:order_items",
        "table:payments",
        "metric:net_revenue",
        "table:orders",
      ],
    };
    const results = await hybridSearch(
      makeMockQuery(state),
      embedder,
      "orders order_items payments revenue fan-out",
      5,
      true,
    );
    const ids = results.map((chunk) => chunk.chunkId);
    expect(ids).toContain("join_rule:orders_items_payments");
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("expandJoinRules replaces the lowest non-join tail when at topK", () => {
    const fused = [
      {
        chunkId: "table:orders",
        docType: "table",
        table: "orders",
        tables: ["orders"],
        metricName: null,
        content: "orders",
        score: 0.05,
      },
      {
        chunkId: "table:order_items",
        docType: "table",
        table: "order_items",
        tables: ["order_items"],
        metricName: null,
        content: "items",
        score: 0.04,
      },
      {
        chunkId: "table:payments",
        docType: "table",
        table: "payments",
        tables: ["payments"],
        metricName: null,
        content: "payments",
        score: 0.03,
      },
    ] as const;
    const catalog = [
      makeCatalogRow({
        chunk_id: "join_rule:orders_items_payments",
        doc_type: "join_rule",
        tables: "orders,order_items,payments",
        content: "fan-out warning",
      }),
    ];
    const expanded = expandJoinRules(
      [...fused] as never,
      catalog,
      3,
      true,
      new Map([
        ["table:orders", 0.05],
        ["table:order_items", 0.04],
        ["table:payments", 0.03],
      ]),
      new Set<string>(),
    );
    expect(expanded).toHaveLength(3);
    expect(expanded.map((chunk) => chunk.chunkId)).toContain(
      "join_rule:orders_items_payments",
    );
  });
});

describe("cross-process BM25 hot-reload", () => {
  beforeEach(() => {
    resetSemanticCache();
  });

  it("reloads the BM25 index and citation catalog on watermark change", async () => {
    const embedder = createFakeEmbedder();
    const v1 = [
      makeCatalogRow({
        chunk_id: "metric:net_revenue",
        doc_type: "metric",
        metric_name: "net_revenue",
        aliases: "net sales",
        tables: "orders",
        content: "old formula version one",
      }),
      makeCatalogRow({
        chunk_id: "table:orders",
        doc_type: "table",
        table_name: "orders",
        tables: "orders",
        content: "orders table",
      }),
    ];
    const state = { maxTs: "100", total: v1.length, catalog: v1 };
    const query = makeMockQuery(state);

    const first = await hybridSearch(query, embedder, "net sales", 5, true);
    expect(first.map((chunk) => chunk.chunkId)).toContain("metric:net_revenue");
    expect(getCitationCatalog().has("metric:net_revenue")).toBe(true);
    expect(getCitationCatalog().has("table:orders")).toBe(true);

    // Simulate an external re-index: bump watermark and change the definition.
    const v2 = [
      makeCatalogRow({
        chunk_id: "metric:net_revenue",
        doc_type: "metric",
        metric_name: "net_revenue",
        aliases: "net sales,unicorn metric",
        tables: "orders",
        content: "new formula version two unicorn",
      }),
      makeCatalogRow({
        chunk_id: "table:orders",
        doc_type: "table",
        table_name: "orders",
        tables: "orders",
        content: "orders table",
      }),
      makeCatalogRow({
        chunk_id: "metric:new_kpi",
        doc_type: "metric",
        metric_name: "new_kpi",
        aliases: "shiny kpi",
        tables: "orders",
        content: "brand new metric unicorn shiny",
      }),
    ];
    state.maxTs = "200";
    state.total = v2.length;
    state.catalog = v2;

    const second = await hybridSearch(query, embedder, "unicorn", 5, true);
    expect(second.map((chunk) => chunk.chunkId)).toContain("metric:new_kpi");
    expect(getCitationCatalog().has("metric:new_kpi")).toBe(true);
    expect(getCitationCatalog().has("metric:net_revenue")).toBe(true);
  });
});
