// Hybrid retriever (MCP-02, D-18, UC-02): 3-way hybrid — dense pgvector,
// in-memory Okapi BM25 (hot-reloaded), and deterministic alias/identifier
// matcher fused by weighted RRF at k=60 with join-rule graph expansion.
// Storage snake_case maps to the camelCase SearchSemanticLayer contract
// shapes at the boundary.
import type { SearchSemanticLayerChunk } from "@shared/contracts";
import {
  DEFAULT_RRF_WEIGHTS,
  fuseRRF,
  rrfScore,
  RRF_K,
} from "./rrf.js";
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

const WATERMARK_SQL = `SELECT EXTRACT(EPOCH FROM MAX(updated_at)) AS max_ts, COUNT(*)::int AS total
FROM semantic.semantic_chunks`;

const CATALOG_SQL = `SELECT chunk_id, doc_type, table_name, tables, metric_name, aliases, sensitivity, content, updated_at
FROM semantic.semantic_chunks`;

// Pure boundary mapper: storage row plus fusion score to the frozen
// contract shape (exported for unit tests).
export function toContractChunk(
  row: Record<string, unknown>,
  score: number,
  extra?: { aliasMatched?: boolean; denseScore?: number },
): SearchSemanticLayerChunk {
  const tables = String(row["tables"] ?? "");
  const base = {
    chunkId: String(row["chunk_id"]),
    docType: row["doc_type"] as SearchSemanticLayerChunk["docType"],
    table: (row["table_name"] as string | null) ?? null,
    tables: tables.length > 0 ? tables.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0) : [],
    metricName: (row["metric_name"] as string | null) ?? null,
    content: String(row["content"] ?? ""),
    score,
  };
  if (extra?.aliasMatched === undefined && extra?.denseScore === undefined) {
    return base;
  }
  const out: SearchSemanticLayerChunk = { ...base };
  if (extra?.aliasMatched !== undefined) {
    out.aliasMatched = extra.aliasMatched;
  }
  if (extra?.denseScore !== undefined) {
    out.denseScore = extra.denseScore;
  }
  return out;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

// ---------------------------------------------------------------------------
// BM25 text normalization
// ---------------------------------------------------------------------------

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export function foldAscii(text: string): string {
  return text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const VI_STOPWORDS = new Set<string>([
  "la", "cua", "va", "cac", "co", "trong", "cho", "theo", "voi", "nhung",
  "duoc", "de", "den", "tu", "ve", "nhu", "ma", "thi", "nay", "do", "bi",
  "bo", "mot", "hai", "nhung", "cai", "nay", "kia", "ay",
]);

const EN_STOPWORDS = new Set<string>([
  "the", "is", "of", "and", "in", "to", "for", "by", "with", "on", "at",
  "from", "a", "an", "as", "are", "be", "or", "it", "this", "that", "these",
  "those", "was", "were", "has", "have", "had", "will", "would", "can",
  "could", "should", "what", "which", "who", "how", "when", "where", "why",
  "do", "does", "did", "not", "no", "if", "then", "than", "such", "into",
  "over", "under", "about", "between", "through", "during", "each", "other",
  "some", "any", "all", "both", "few", "more", "most", "many", "much", "own",
  "same", "too", "very",
]);

const STOPWORDS = new Set<string>([...VI_STOPWORDS, ...EN_STOPWORDS]);

export function tokenizeForBm25(text: string): string[] {
  const lowered = text.normalize("NFC").toLowerCase();
  const rawTokens =
    lowered.match(/[a-z\u00e0-\u1ef9\p{L}\p{N}]+(?:[_\.\-][\p{L}\p{N}]+)*/gu) ??
    [];
  const expanded: string[] = [];
  for (const raw of rawTokens) {
    if (!raw) continue;
    expanded.push(raw);
    if (raw.includes("_") || raw.includes(".") || raw.includes("-")) {
      const parts = raw.split(/[_\.\-]+/).filter((part) => part.length > 0);
      for (const part of parts) {
        if (part !== raw) expanded.push(part);
      }
    }
  }
  if (expanded.length === 0) return [];
  const filtered = expanded.filter((token) => !STOPWORDS.has(foldAscii(token)));
  const base = filtered.length > 0 ? filtered : expanded;
  const out: string[] = [];
  for (const token of base) {
    out.push(token);
    const folded = foldAscii(token);
    if (folded && folded !== token) out.push(folded);
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory Okapi BM25
// ---------------------------------------------------------------------------

function compositeText(row: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = row["content"];
  if (typeof content === "string" && content) parts.push(content);
  const metricName = row["metric_name"];
  if (typeof metricName === "string" && metricName) parts.push(metricName);
  const aliases = row["aliases"];
  if (typeof aliases === "string" && aliases) {
    for (const alias of aliases.split(",")) {
      const trimmed = alias.trim();
      if (trimmed) parts.push(trimmed);
    }
  } else if (Array.isArray(aliases)) {
    for (const alias of aliases) {
      const text = String(alias).trim();
      if (text) parts.push(text);
    }
  }
  const tableName = row["table_name"];
  if (typeof tableName === "string" && tableName) parts.push(tableName);
  const tables = row["tables"];
  if (typeof tables === "string" && tables) {
    for (const table of tables.split(",")) {
      const trimmed = table.trim();
      if (trimmed) parts.push(trimmed);
    }
  } else if (Array.isArray(tables)) {
    for (const table of tables) {
      const text = String(table).trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(" ");
}

/**
 * Single-term Okapi BM25 contribution with the standard non-negative IDF.
 * `tf` is the term frequency in the doc, `df` the number of docs containing
 * the term, `N` the collection size, `dl` the doc length and `avgdl` the
 * average doc length.
 */
export function scoreBm25(
  tf: number,
  df: number,
  N: number,
  dl: number,
  avgdl: number,
  k1: number = BM25_K1,
  b: number = BM25_B,
): number {
  if (tf <= 0 || N <= 0 || avgdl <= 0) return 0;
  const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
  const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl));
  return idf * norm;
}

interface IndexedDoc {
  id: string;
  tf: Map<string, number>;
  length: number;
  row: Record<string, unknown>;
}

export class Bm25Retriever {
  private docs: IndexedDoc[] = [];
  private df = new Map<string, number>();
  private avgdl = 0;
  private k1: number;
  private b: number;

  constructor(a?: number | Record<string, unknown>[], bParam?: number, c?: number);
  constructor(
    a?: number | Record<string, unknown>[],
    bParam?: number,
    c?: number,
  ) {
    if (Array.isArray(a)) {
      this.k1 = typeof bParam === "number" ? bParam : BM25_K1;
      this.b = typeof c === "number" ? c : BM25_B;
      this.index(a);
    } else {
      this.k1 = typeof a === "number" ? a : BM25_K1;
      this.b = typeof bParam === "number" ? bParam : BM25_B;
    }
  }

  index(rows: Record<string, unknown>[]): void {
    this.docs = [];
    this.df = new Map<string, number>();
    let totalLen = 0;
    for (const row of rows) {
      const id = String(row["chunk_id"] ?? "");
      if (!id) continue;
      const tokens = tokenizeForBm25(compositeText(row));
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      for (const term of new Set(tokens)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
      totalLen += tokens.length;
      this.docs.push({ id, tf, length: tokens.length, row });
    }
    this.avgdl = this.docs.length > 0 ? totalLen / this.docs.length : 0;
  }

  search(
    queryText: string,
    topK: number,
    allowRestricted = false,
  ): { id: string; score: number; row: Record<string, unknown> }[] {
    const queryTokens = tokenizeForBm25(queryText);
    const N = this.docs.length;
    if (N === 0 || queryTokens.length === 0 || this.avgdl <= 0) return [];
    const results: { id: string; score: number; row: Record<string, unknown> }[] = [];
    for (const doc of this.docs) {
      if (
        !allowRestricted &&
        String(doc.row["sensitivity"] ?? "") === "restricted_pii"
      ) {
        continue;
      }
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.tf.get(term) ?? 0;
        if (tf <= 0) continue;
        const df = this.df.get(term) ?? 0;
        score += scoreBm25(tf, df, N, doc.length, this.avgdl, this.k1, this.b);
      }
      if (score > 0) results.push({ id: doc.id, score, row: doc.row });
    }
    results.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    const limit = Math.max(topK * 3, topK);
    return results.slice(0, limit);
  }

  get size(): number {
    return this.docs.length;
  }
}

// ---------------------------------------------------------------------------
// Cross-process hot-reload catalog
// ---------------------------------------------------------------------------

let cachedMaxTs: string | null = null;
let cachedTotal: number | null = null;
let catalogRows: Record<string, unknown>[] = [];
let citationCatalogSet = new Set<string>();
let bm25Retriever: Bm25Retriever | null = null;
let catalogInitialized = false;

function rebuildCatalog(
  rows: Record<string, unknown>[],
  maxTs: string,
  total: number,
): void {
  catalogRows = rows;
  const retriever = new Bm25Retriever();
  retriever.index(rows);
  bm25Retriever = retriever;
  const next = new Set<string>();
  for (const row of rows) {
    const chunkId = String(row["chunk_id"] ?? "");
    if (!chunkId) continue;
    next.add(chunkId);
    const metric = row["metric_name"];
    if (typeof metric === "string" && metric.trim()) {
      next.add(`metric:${metric.trim()}`);
    }
    const tableName = row["table_name"];
    if (typeof tableName === "string" && tableName.trim()) {
      const trimmed = tableName.trim();
      next.add(`table:${trimmed}`);
      next.add(trimmed);
    }
    next.add(chunkId.replace(/^column:/, ""));
  }
  citationCatalogSet = next;
  cachedMaxTs = maxTs;
  cachedTotal = total;
  catalogInitialized = true;
}

export function getCitationCatalog(): ReadonlySet<string> {
  return citationCatalogSet;
}

export function resetSemanticCache(): void {
  cachedMaxTs = null;
  cachedTotal = null;
  catalogRows = [];
  citationCatalogSet = new Set<string>();
  bm25Retriever = null;
  catalogInitialized = false;
}

// ---------------------------------------------------------------------------
// Leg 3: deterministic alias & identifier matcher
// ---------------------------------------------------------------------------

function candidatesForRow(row: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) candidates.push(trimmed);
  };
  const metric = row["metric_name"];
  if (typeof metric === "string" && metric.trim()) push(metric);
  const aliases = row["aliases"];
  if (typeof aliases === "string" && aliases) {
    for (const alias of aliases.split(",")) push(alias);
  } else if (Array.isArray(aliases)) {
    for (const alias of aliases) push(alias);
  }
  const chunkId = String(row["chunk_id"] ?? "");
  if (chunkId) {
    push(chunkId);
    const colon = chunkId.indexOf(":");
    const suffix = colon >= 0 ? chunkId.slice(colon + 1) : chunkId;
    if (suffix && suffix !== chunkId) push(suffix);
    const spaced = suffix
      .replace(/[_\.\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (spaced && spaced !== suffix) push(spaced);
  }
  const tableName = row["table_name"];
  if (typeof tableName === "string" && tableName.trim()) push(tableName.trim());
  return candidates;
}

function spacedVariant(text: string): string {
  return text
    .replace(/[_\.\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsOnBoundaries(haystack: string, needle: string): boolean {
  if (!needle || !haystack.includes(needle)) return false;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? "" : (haystack[index - 1] as string);
    const afterIndex = index + needle.length;
    const after =
      afterIndex >= haystack.length ? "" : (haystack[afterIndex] as string);
    const beforeIsWord = before ? /[\p{L}\p{N}]/u.test(before) : false;
    const afterIsWord = after ? /[\p{L}\p{N}]/u.test(after) : false;
    if (!beforeIsWord && !afterIsWord) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/**
 * Deterministic alias & identifier matcher. Returns matching chunk_ids
 * ranked with exact matches first, then by matched phrase length descending,
 * then by chunk_id ascending.
 */
export function matchAliases(
  queryText: string,
  rows: Record<string, unknown>[],
  allowRestricted = false,
): string[] {
  const q = queryText.normalize("NFC").toLowerCase().trim();
  const qFold = foldAscii(queryText);
  const qSpaced = spacedVariant(q);
  const qFoldSpaced = spacedVariant(qFold);
  const queryForms = [...new Set([q, qFold, qSpaced, qFoldSpaced])].filter(
    (form) => form.length > 0,
  );
  if (queryForms.length === 0) return [];
  interface Match {
    id: string;
    exact: boolean;
    matchedLength: number;
  }
  const matches: Match[] = [];
  for (const row of rows) {
    if (
      !allowRestricted &&
      String(row["sensitivity"] ?? "") === "restricted_pii"
    ) {
      continue;
    }
    const chunkId = String(row["chunk_id"] ?? "");
    if (!chunkId) continue;
    const candidates = candidatesForRow(row);
    let bestExact = false;
    let bestLength = 0;
    let matched = false;
    for (const candidate of candidates) {
      const c = candidate.normalize("NFC").toLowerCase().trim();
      const cFold = foldAscii(candidate);
      const cSpaced = spacedVariant(c);
      const cFoldSpaced = spacedVariant(cFold);
      const candidateForms = [...new Set([c, cFold, cSpaced, cFoldSpaced])].filter(
        (form) => form.length > 0,
      );
      for (const qf of queryForms) {
        for (const cf of candidateForms) {
          if (qf === cf) {
            matched = true;
            bestExact = true;
            bestLength = Math.max(bestLength, cf.length);
          } else if (cf.length >= 2 && containsOnBoundaries(qf, cf)) {
            matched = true;
            bestLength = Math.max(bestLength, cf.length);
          }
        }
      }
    }
    if (matched) {
      matches.push({ id: chunkId, exact: bestExact, matchedLength: bestLength });
    }
  }
  matches.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (b.matchedLength !== a.matchedLength)
      return b.matchedLength - a.matchedLength;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return matches.map((match) => match.id);
}

// ---------------------------------------------------------------------------
// Automatic join-rule graph expansion
// ---------------------------------------------------------------------------

function parseTablesField(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const tableName = row["table_name"];
  if (typeof tableName === "string" && tableName.trim()) out.push(tableName.trim());
  const tables = row["tables"];
  if (typeof tables === "string" && tables) {
    for (const table of tables.split(",")) {
      const trimmed = table.trim();
      if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    }
  } else if (Array.isArray(tables)) {
    for (const table of tables) {
      const text = String(table).trim();
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function contractTables(chunk: SearchSemanticLayerChunk): string[] {
  const out: string[] = [];
  if (chunk.table) out.push(chunk.table);
  for (const table of chunk.tables ?? []) {
    if (table && !out.includes(table)) out.push(table);
  }
  return out;
}

/**
 * Inject join_rule chunks whose tables overlap with >= 2 tables from the
 * top-5 fused chunks, keeping the result length within topK.
 */
export function expandJoinRules(
  fused: SearchSemanticLayerChunk[],
  allRows: Record<string, unknown>[],
  topK: number,
  allowRestricted = false,
  scoreById: Map<string, number> = new Map<string, number>(),
  aliasMatchedIds: Set<string> = new Set<string>(),
): SearchSemanticLayerChunk[] {
  const head = fused.slice(0, 5);
  const candidateTables = new Set<string>();
  for (const chunk of head) {
    for (const table of contractTables(chunk)) candidateTables.add(table);
  }
  if (candidateTables.size < 2) return [...fused];
  interface JoinCandidate {
    row: Record<string, unknown>;
    id: string;
    overlap: number;
    score: number;
  }
  const joinCandidates: JoinCandidate[] = [];
  for (const row of allRows) {
    if (String(row["doc_type"] ?? "") !== "join_rule") continue;
    if (
      !allowRestricted &&
      String(row["sensitivity"] ?? "") === "restricted_pii"
    ) {
      continue;
    }
    const chunkId = String(row["chunk_id"] ?? "");
    if (!chunkId) continue;
    const tables = parseTablesField({
      table_name: row["table_name"],
      tables: row["tables"],
    });
    // Also parse tables stored as comma string directly.
    const overlap = tables.filter((table) => candidateTables.has(table)).length;
    if (overlap >= 2) {
      joinCandidates.push({
        row,
        id: chunkId,
        overlap,
        score: scoreById.get(chunkId) ?? 0,
      });
    }
  }
  if (joinCandidates.length === 0) return [...fused];
  joinCandidates.sort(
    (a, b) => b.overlap - a.overlap || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const result = [...fused];
  const existing = new Set(result.map((chunk) => chunk.chunkId));
  for (const candidate of joinCandidates) {
    if (existing.has(candidate.id)) continue;
    const extra: { aliasMatched: boolean; denseScore?: number } = {
      aliasMatched: aliasMatchedIds.has(candidate.id),
    };
    const denseRaw = candidate.row["dense_score"];
    if (typeof denseRaw === "number" && Number.isFinite(denseRaw)) {
      extra.denseScore = denseRaw;
    }
    const contract = toContractChunk(candidate.row, candidate.score, extra);
    if (result.length < topK) {
      result.push(contract);
      existing.add(candidate.id);
    } else if (topK >= 2) {
      let replaceIndex = -1;
      for (let index = result.length - 1; index >= 0; index--) {
        if ((result[index] as SearchSemanticLayerChunk).docType !== "join_rule") {
          replaceIndex = index;
          break;
        }
      }
      if (replaceIndex === -1) continue;
      existing.delete((result[replaceIndex] as SearchSemanticLayerChunk).chunkId);
      result[replaceIndex] = contract;
      existing.add(candidate.id);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 3-way hybrid search
// ---------------------------------------------------------------------------

export async function hybridSearch(
  query: RetrieverQuery,
  embedder: Embedder,
  text: string,
  topK: number,
  allowRestricted: boolean,
): Promise<SearchSemanticLayerChunk[]> {
  const candidates = Math.max(topK * 3, topK);

  try {
    const watermark = await query(WATERMARK_SQL, []);
    const watermarkRow = (watermark.rows[0] ?? {}) as Record<string, unknown>;
    const maxTs = String(watermarkRow["max_ts"] ?? "");
    const total = Number(watermarkRow["total"] ?? -1);
    if (
      !catalogInitialized ||
      maxTs !== cachedMaxTs ||
      total !== cachedTotal
    ) {
      try {
        const catalog = await query(CATALOG_SQL, []);
        const rows = (catalog.rows ?? []) as Record<string, unknown>[];
        rebuildCatalog(rows, maxTs, total);
      } catch {
        // Graceful: fall back to cached or vector rows below.
      }
    }
  } catch {
    // Graceful: a mock query function may not implement the watermark
    // probe; continue with cached or vector-row fallback.
  }

  const restriction = allowRestricted ? "" : `AND sensitivity != 'restricted_pii'`;
  const [embedding] = await embedder.embed([text]);
  if (embedding === undefined) throw new Error("embedder returned no vector");

  const vectorRows = await query(
    `SELECT ${CHUNK_COLUMNS}, 1 - (embedding <=> $1::vector) AS dense_score
     FROM semantic.semantic_chunks
     WHERE embedding IS NOT NULL ${restriction}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral(embedding), candidates],
  );

  let effectiveRows = catalogRows;
  let retriever = bm25Retriever;
  if (effectiveRows.length === 0 && vectorRows.rows.length > 0) {
    effectiveRows = vectorRows.rows as Record<string, unknown>[];
    const fallback = new Bm25Retriever();
    fallback.index(effectiveRows);
    retriever = fallback;
    if (citationCatalogSet.size === 0) {
      const next = new Set<string>();
      for (const row of effectiveRows) {
        const chunkId = String(row["chunk_id"] ?? "");
        if (!chunkId) continue;
        next.add(chunkId);
        const metric = row["metric_name"];
        if (typeof metric === "string" && metric.trim()) {
          next.add(`metric:${(metric as string).trim()}`);
        }
        const tableName = row["table_name"];
        if (typeof tableName === "string" && (tableName as string).trim()) {
          const trimmed = (tableName as string).trim();
          next.add(`table:${trimmed}`);
          next.add(trimmed);
        }
        next.add(chunkId.replace(/^column:/, ""));
      }
      citationCatalogSet = next;
    }
  }

  const vectorIds = vectorRows.rows.map((row) =>
    String(row["chunk_id"]),
  );
  const vectorRank = new Map<string, number>();
  vectorIds.forEach((id, index) => {
    if (!vectorRank.has(id)) vectorRank.set(id, index + 1);
  });
  const denseScoreById = new Map<string, number>();
  for (const row of vectorRows.rows) {
    const id = String(row["chunk_id"]);
    const raw = row["dense_score"];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      denseScoreById.set(id, raw);
    } else if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) denseScoreById.set(id, parsed);
    }
  }

  const bm25Hits = retriever
    ? retriever.search(text, topK, allowRestricted)
    : [];
  const bm25Ids = bm25Hits.map((hit) => hit.id);
  const bm25Rank = new Map<string, number>();
  bm25Ids.forEach((id, index) => {
    if (!bm25Rank.has(id)) bm25Rank.set(id, index + 1);
  });

  const aliasIds = matchAliases(text, effectiveRows, allowRestricted);
  const aliasRank = new Map<string, number>();
  aliasIds.forEach((id, index) => {
    if (!aliasRank.has(id)) aliasRank.set(id, index + 1);
  });
  const aliasMatchedIds = new Set(aliasIds);

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of effectiveRows) {
    byId.set(String(row["chunk_id"]), row);
  }
  for (const row of vectorRows.rows) {
    byId.set(String(row["chunk_id"]), row as Record<string, unknown>);
  }

  const fused = fuseRRF([vectorIds, bm25Ids, aliasIds], {
    k: RRF_K,
    topK,
    weights: DEFAULT_RRF_WEIGHTS,
    idOf: (id) => id,
  });
  const scoreById = new Map<string, number>();
  const initial: SearchSemanticLayerChunk[] = [];
  for (const id of fused) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const score = rrfScore(
      [vectorRank.get(id), bm25Rank.get(id), aliasRank.get(id)],
      RRF_K,
      DEFAULT_RRF_WEIGHTS,
    );
    scoreById.set(id, score);
    const extra: { aliasMatched: boolean; denseScore?: number } = {
      aliasMatched: aliasMatchedIds.has(id),
    };
    const dense = denseScoreById.get(id);
    if (dense !== undefined) extra.denseScore = dense;
    initial.push(toContractChunk(row, score, extra));
  }

  return expandJoinRules(
    initial,
    effectiveRows,
    topK,
    allowRestricted,
    scoreById,
    aliasMatchedIds,
  );
}
