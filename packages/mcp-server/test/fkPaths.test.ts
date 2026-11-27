import { describe, expect, it } from "vitest";
import type { SearchSemanticLayerChunk } from "@shared/contracts";
import type { ForeignKeyRef } from "../src/catalog.js";
import { foreignKeyPath } from "../src/semantic/fkPaths.js";
import { expandForeignKeyPaths } from "../src/semantic/retriever.js";

function refs(...targets: string[]): ForeignKeyRef[] {
  return targets.map((referencesTable) => ({ column: "id", referencesTable, referencesColumn: "id" }));
}

function chunk(table: string): SearchSemanticLayerChunk {
  return {
    chunkId: `table:${table}`, docType: "table", table, tables: [table],
    metricName: null, content: table, score: 0.5,
  };
}

describe("FK path completion", () => {
  it("injects a bridge and its join rule when an endpoint falls below the first five hits", () => {
    const fused = [
      chunk("order_items"), chunk("noise_a"), chunk("noise_b"),
      chunk("noise_c"), chunk("noise_d"), chunk("categories"),
    ];
    const foreignKeys = new Map<string, ForeignKeyRef[]>([
      ["order_items", refs("products")], ["products", refs("categories")],
    ]);
    const allRows = [
      { chunk_id: "table:products", doc_type: "table", table_name: "products", tables: "products", content: "Product catalog", sensitivity: "public" },
      { chunk_id: "join_rule:order_items_products_categories", doc_type: "join_rule", table_name: null,
        tables: "order_items,products,categories", content: "Join through products", sensitivity: "public" },
    ];
    const result = expandForeignKeyPaths(
      fused, allRows, "order_items categories", 6, foreignKeys,
      new Set(["order_items", "products", "categories", "noise_a", "noise_b", "noise_c", "noise_d"]),
    );
    expect(result.map((entry) => entry.chunkId)).toEqual(expect.arrayContaining([
      "table:order_items", "table:categories", "table:products",
      "join_rule:order_items_products_categories",
    ]));
    expect(result).toHaveLength(6);
    const evicted = expandForeignKeyPaths(
      fused.slice(0, 5), allRows, "order_items categories", 6, foreignKeys,
      new Set(["order_items", "products", "categories", "noise_a", "noise_b", "noise_c", "noise_d"]),
      false, fused,
    );
    expect(evicted.map((entry) => entry.chunkId)).toEqual(expect.arrayContaining([
      "table:order_items", "table:categories", "table:products",
      "join_rule:order_items_products_categories",
    ]));
  });

  it("chooses the same shortest path on ties and refuses disconnected or oversized paths", () => {
    const tied = new Map<string, ForeignKeyRef[]>([
      ["a", refs("c", "b")], ["b", refs("d")], ["c", refs("d")],
    ]);
    const path = foreignKeyPath(["a", "d"], tied, new Set(["a", "b", "c", "d"]));
    expect(path?.bridges).toEqual(["b"]);
    expect(foreignKeyPath(["a", "x"], tied, new Set(["a", "b", "c", "d", "x"]))).toBeNull();
    const chain = new Map<string, ForeignKeyRef[]>([
      ["a", refs("b")], ["b", refs("c")], ["c", refs("d")],
      ["d", refs("e")], ["e", refs("f")], ["f", refs("g")],
    ]);
    expect(foreignKeyPath(["a", "g"], chain, new Set(["a", "b", "c", "d", "e", "f", "g"]))).toBeNull();
  });
});
