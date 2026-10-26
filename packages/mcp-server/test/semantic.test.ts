// Semantic unit suite (MCP-02): fake embedder shape and determinism,
// RRF ordering at k=60, resource section filtering, and the storage to
// contract camelCase mapping. Fully DB-free.
import { describe, expect, it } from "vitest";
import { createFakeEmbedder } from "../src/semantic/embedder.js";
import { fuseRRF, rrfScore, RRF_K } from "../src/semantic/rrf.js";
import { toContractChunk } from "../src/semantic/retriever.js";
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
