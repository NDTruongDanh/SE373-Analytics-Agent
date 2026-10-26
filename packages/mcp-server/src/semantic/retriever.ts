// Hybrid retriever (MCP-02, D-18): pgvector cosine plus Postgres FTS,
// fused by RRF at k=60. Both legs fetch topK*3 candidates; chunks carrying
// sensitivity restricted_pii are filtered out unless the caller holds
// data:sensitive. Storage snake_case maps to the camelCase
// SearchSemanticLayer contract shapes from 01-02 at the boundary.
import type { SearchSemanticLayerChunk } from "@se373/contracts";
import { fuseRRF, rrfScore, RRF_K } from "./rrf.js";
import type { Embedder } from "./embedder.js";

export interface RetrieverQuery {
  (text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface StorageChunk {
  chunk_id: string;
  doc_type: string;
  table_name: string | null;
  tables: string;
  metric_name: string | null;
  aliases: string | null;
  sensitivity: string | null;
  content: string;
  score: number;
}

const CHUNK_COLUMNS = `chunk_id, doc_type, table_name, tables, metric_name, aliases, sensitivity, content`;

// Pure boundary mapper: storage row plus fusion score to the frozen
// contract shape (exported for unit tests).
export function toContractChunk(
  row: Record<string, unknown>,
  score: number,
): SearchSemanticLayerChunk {
  const tables = String(row["tables"] ?? "");
  return {
    chunkId: String(row["chunk_id"]),
    docType: row["doc_type"] as SearchSemanticLayerChunk["docType"],
    table: (row["table_name"] as string | null) ?? null,
    tables: tables.length > 0 ? tables.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [],
    metricName: (row["metric_name"] as string | null) ?? null,
    content: String(row["content"] ?? ""),
    score,
  };
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function hybridSearch(
  query: RetrieverQuery,
  embedder: Embedder,
  text: string,
  topK: number,
  allowRestricted: boolean,
): Promise<SearchSemanticLayerChunk[]> {
  const candidates = Math.max(topK * 3, topK);
  const restriction = allowRestricted ? "" : `AND sensitivity != 'restricted_pii'`;
  const [embedding] = await embedder.embed([text]);
  if (embedding === undefined) throw new Error("embedder returned no vector");

  const vectorRows = await query(
    `SELECT ${CHUNK_COLUMNS}
     FROM semantic.semantic_chunks
     WHERE embedding IS NOT NULL ${restriction}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral(embedding), candidates],
  );
  const ftsRows = await query(
    `SELECT ${CHUNK_COLUMNS}
     FROM semantic.semantic_chunks
     WHERE fts @@ plainto_tsquery('simple', semantic.immutable_unaccent($1)) ${restriction}
     ORDER BY ts_rank(fts, plainto_tsquery('simple', semantic.immutable_unaccent($1))) DESC
     LIMIT $2`,
    [text, candidates],
  );

  const vectorIds = new Map(
    vectorRows.rows.map((row, index) => [String(row["chunk_id"]), index + 1] as const),
  );
  const ftsIds = new Map(
    ftsRows.rows.map((row, index) => [String(row["chunk_id"]), index + 1] as const),
  );
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...vectorRows.rows, ...ftsRows.rows]) {
    byId.set(String(row["chunk_id"]), row);
  }
  const fused = fuseRRF(
    [
      [...vectorIds.keys()],
      [...ftsIds.keys()],
    ],
    { k: RRF_K, topK, idOf: (id) => id },
  );
  const rankOf = (map: Map<string, number>, id: string): number | undefined =>
    map.get(id);
  return fused.map((id) => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`fused chunk ${id} missing from legs`);
    return toContractChunk(
      row,
      rrfScore([rankOf(vectorIds, id), rankOf(ftsIds, id)], RRF_K),
    );
  });
}
