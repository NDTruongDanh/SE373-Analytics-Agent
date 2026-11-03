// Semantic indexer (MCP-02): chunks the versioned 6-type YAML corpus,
// embeds through the configured embedder, and upserts into
// semantic_chunks with SHA-256 content_hash dedup so re-runs are
// incremental (new chunks inserted, changed chunks re-embedded, unchanged
// chunks skipped, stale chunks deleted). Operator-run via tsx against this
// module directly (`pnpm semantic:index`). Writes as the indexer role over
// INDEXER_DATABASE_URL.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { parse as parseYaml } from "yaml";
import { SemanticChunkMetadataSchema, type SemanticChunkMetadata } from "@shared/contracts";
import { selectEmbedderFromEnv, type Embedder } from "./embedder.js";

export interface CorpusFile {
  path: string;
  docType: string;
}

export interface ParsedChunk {
  chunkId: string;
  docType: SemanticChunkMetadata["docType"];
  table: string | null;
  tables: string[];
  metricName: string | null;
  aliases: string[];
  sensitivity: "public" | "internal" | "restricted_pii";
  additive?: boolean;
  metadata?: Record<string, unknown>;
  content: string;
}

// Validate a parsed chunk against the shared contract. Throws on mismatch
// so every chunk leaving chunkYaml/chunkMarkdown is guaranteed compliant.
export function validateChunkMetadata(
  chunk: ParsedChunk,
  updatedAt = "1970-01-01T00:00:00.000Z",
): SemanticChunkMetadata {
  return SemanticChunkMetadataSchema.parse({
    chunkId: chunk.chunkId,
    docType: chunk.docType,
    table: chunk.table,
    tables: chunk.tables,
    metricName: chunk.metricName,
    aliases: chunk.aliases,
    sensitivity: chunk.sensitivity,
    ...(chunk.additive !== undefined ? { additive: chunk.additive } : {}),
    updatedAt,
  });
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u1ef9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function parseMetaLine(line: string): [key: string, value: string] | null {
  const match = /^(Table|Tables|Metric|Aliases):\s*(.+)$/.exec(line.trim());
  if (match === null) return null;
  return [match[1] as string, (match[2] as string).trim()];
}

// Pure chunker (exported for unit tests): every `## ` section is one chunk.
// A header ending in [restricted_pii] marks the chunk restricted; leading
// `Table:`/`Tables:`/`Metric:`/`Aliases:` lines populate the metadata
// columns and stay in the content for lexical search.
export function chunkMarkdown(
  source: string,
  text: string,
  docType: string,
): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const lines = text.split("\n");
  let current: string[] | null = null;
  let title = "";
  const flush = (): void => {
    if (current === null) return;
    const restricted = /\[restricted_pii\]\s*$/.test(title);
    const cleanTitle = title.replace(/\s*\[restricted_pii\]\s*$/, "").trim();
    let table: string | null = null;
    let tables: string[] = [];
    let metricName: string | null = null;
    let aliases: string[] = [];
    for (const line of current) {
      const meta = parseMetaLine(line);
      if (meta === null) break;
      const [key, value] = meta;
      if (key === "Table") table = value;
      else if (key === "Tables") {
        tables = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      } else if (key === "Metric") metricName = value;
      else if (key === "Aliases") {
        aliases = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      }
    }
    if (table === null && tables.length === 1) table = tables[0] as string;
    if (tables.length === 0 && table !== null) tables = [table];
    const chunk: ParsedChunk = {
      chunkId: `${source}:${slug(cleanTitle)}`,
      docType: docType as ParsedChunk["docType"],
      table,
      tables,
      metricName,
      aliases,
      sensitivity: restricted ? "restricted_pii" : "public",
      content: current.join("\n").trim(),
    };
    const validated = validateChunkMetadata(chunk);
    chunk.metadata = { ...validated };
    chunks.push(chunk);
    current = null;
  };
  for (const line of lines) {
    const header = /^##\s+(.*)$/.exec(line);
    if (header !== null) {
      flush();
      title = (header[1] as string).trim();
      current = [];
      continue;
    }
    if (current !== null) current.push(line);
  }
  flush();
  return chunks.filter((entry) => entry.content.length > 0);
}

interface StructuredField {
  keys: string[];
  label: string;
}

const STRUCTURED_FIELDS: StructuredField[] = [
  { keys: ["formula"], label: "Formula" },
  { keys: ["sql"], label: "SQL" },
  { keys: ["sqlTemplate", "sql_template"], label: "SQL Template" },
  { keys: ["caveats"], label: "Caveats" },
  { keys: ["question"], label: "Question" },
  { keys: ["citedMetrics", "cited_metrics"], label: "Cited Metrics" },
  { keys: ["startDate", "start_date"], label: "Start Date" },
  { keys: ["endDate", "end_date"], label: "End Date" },
  { keys: ["affectedRegions", "affected_regions"], label: "Affected Regions" },
  { keys: ["affectedChannels", "affected_channels"], label: "Affected Channels" },
  { keys: ["grain"], label: "Grain" },
  { keys: ["primaryKey", "primary_key"], label: "Primary Key" },
  { keys: ["rowCountScale", "row_count_scale"], label: "Row Count Scale" },
  { keys: ["dataType", "data_type"], label: "Data Type" },
  { keys: ["enumValues", "enum_values"], label: "Enum Values" },
];

function structuredFieldToString(value: unknown): string {
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0)
      .join(", ");
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value).trim();
}

// YAML chunker: parses YAML array/object entries into ParsedChunk[].
export function chunkYaml(
  source: string,
  text: string,
  docType: string,
): ParsedChunk[] {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    return [];
  }
  let entries: unknown[];
  if (Array.isArray(data)) {
    entries = data;
  } else if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj["chunks"])) {
      entries = obj["chunks"] as unknown[];
    } else if (
      obj["content"] !== undefined ||
      obj["body"] !== undefined ||
      obj["text"] !== undefined ||
      obj["description"] !== undefined ||
      obj["chunk_id"] !== undefined ||
      obj["chunkId"] !== undefined ||
      obj["id"] !== undefined
    ) {
      entries = [obj];
    } else {
      const values = Object.values(obj);
      if (
        values.length > 0 &&
        values.every((value) => typeof value === "object" && value !== null)
      ) {
        entries = values;
      } else {
        entries = [obj];
      }
    }
  } else {
    return [];
  }
  const chunks: ParsedChunk[] = [];
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const rawTables = record["tables"];
    let tables: string[] = [];
    if (Array.isArray(rawTables)) {
      tables = (rawTables as unknown[])
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
    } else if (typeof rawTables === "string" && rawTables.trim()) {
      tables = rawTables
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }
    const rawAliases = record["aliases"];
    let aliases: string[] = [];
    if (Array.isArray(rawAliases)) {
      aliases = (rawAliases as unknown[])
        .map((value) => String(value).trim())
        .filter((value) => value.length > 0);
    } else if (typeof rawAliases === "string" && rawAliases.trim()) {
      aliases = rawAliases
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    }
    let table: string | null = null;
    if (typeof record["table"] === "string" && (record["table"] as string).trim()) {
      table = (record["table"] as string).trim();
    }
    if (table === null && tables.length === 1) table = tables[0] as string;
    if (tables.length === 0 && table !== null) tables = [table];
    const metricRaw =
      record["metricName"] ?? record["metric_name"] ?? record["metric"];
    let metricName: string | null = null;
    if (typeof metricRaw === "string" && metricRaw.trim()) {
      metricName = metricRaw.trim();
    }
    const idRaw = record["chunkId"] ?? record["chunk_id"] ?? record["id"];
    let chunkId: string;
    if (typeof idRaw === "string" && idRaw.trim()) {
      chunkId = idRaw.trim();
    } else {
      const titleRaw =
        record["title"] ?? record["name"] ?? metricName ?? table ?? `chunk-${index}`;
      chunkId = `${source}:${slug(String(titleRaw))}`;
    }
    const docTypeRaw = record["docType"] ?? record["doc_type"] ?? docType;
    const sensitivityRaw =
      typeof record["sensitivity"] === "string"
        ? (record["sensitivity"] as string)
        : "public";
    let additive: boolean | undefined;
    if (typeof record["additive"] === "boolean") {
      additive = record["additive"] as boolean;
    }
    const contentRaw =
      record["content"] ??
      record["body"] ??
      record["description"] ??
      record["text"] ??
      "";
    let content = String(contentRaw).trim();
    const structuredExtras: Record<string, unknown> = {};
    for (const field of STRUCTURED_FIELDS) {
      let found = false;
      let rawValue: unknown;
      for (const key of field.keys) {
        if (record[key] !== undefined && record[key] !== null && String(record[key]).trim().length > 0) {
          rawValue = record[key];
          structuredExtras[key] = record[key];
          found = true;
          break;
        }
      }
      if (!found || rawValue === undefined) continue;
      const rendered = structuredFieldToString(rawValue);
      if (rendered.length === 0) continue;
      if (!content.includes(rendered)) {
        content = content.length > 0 ? `${content}\n${field.label}: ${rendered}` : `${field.label}: ${rendered}`;
      }
    }
    if (!content) return;
    const chunk: ParsedChunk = {
      chunkId,
      docType: String(docTypeRaw) as ParsedChunk["docType"],
      table,
      tables,
      metricName,
      aliases,
      sensitivity:
        sensitivityRaw === "restricted_pii"
          ? "restricted_pii"
          : sensitivityRaw === "internal"
            ? "internal"
            : "public",
      ...(additive !== undefined ? { additive } : {}),
      content,
    };
    const validated = validateChunkMetadata(chunk);
    chunk.metadata = { ...validated, ...structuredExtras };
    chunks.push(chunk);
  });
  return chunks;
}

export function canonicalJson(chunk: ParsedChunk): string {
  const payload: Record<string, unknown> = {
    chunkId: chunk.chunkId,
    docType: chunk.docType,
    table: chunk.table,
    tables: chunk.tables,
    metricName: chunk.metricName,
    aliases: chunk.aliases,
    sensitivity: chunk.sensitivity,
    ...(chunk.additive !== undefined ? { additive: chunk.additive } : {}),
    content: chunk.content,
  };
  return JSON.stringify(payload);
}

export function contentHash(chunk: ParsedChunk): string {
  return createHash("sha256").update(canonicalJson(chunk)).digest("hex");
}

export interface IndexCounts {
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
  embeddingTokens?: number;
  estimatedCostUsd?: number;
  durationMs?: number;
}

export type IndexQueryFn = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export async function indexCorpus(options: {
  dbUrl?: string;
  query?: IndexQueryFn;
  embedder: Embedder;
  files: CorpusFile[];
}): Promise<IndexCounts> {
  const startedAt = Date.now();
  let pool: Pool | null = null;
  try {
    let queryFn: IndexQueryFn;
    if (options.query !== undefined) {
      queryFn = options.query;
    } else {
      if (options.dbUrl === undefined || options.dbUrl.length === 0) {
        throw new Error("indexCorpus needs dbUrl or query");
      }
      pool = new Pool({ connectionString: options.dbUrl, max: 2 });
      const activePool: Pool = pool;
      queryFn = async (text: string, params?: unknown[]) => {
        const result = await activePool.query(text, params as unknown[]);
        return { rows: result.rows as Record<string, unknown>[] };
      };
    }
    const chunks: ParsedChunk[] = [];
    for (const file of options.files) {
      const text = readFileSync(file.path, "utf8");
      const source = path.basename(file.path, path.extname(file.path));
      if (file.path.endsWith(".yaml") || file.path.endsWith(".yml")) {
        chunks.push(...chunkYaml(source, text, file.docType));
      } else {
        chunks.push(...chunkMarkdown(source, text, file.docType));
      }
    }
    const existing = await queryFn(
      "SELECT chunk_id, content_hash FROM semantic.semantic_chunks",
    );
    const known = new Map<string, string>();
    for (const row of existing.rows) {
      known.set(String(row["chunk_id"]), String(row["content_hash"]));
    }
    const counts: IndexCounts = {
      added: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      embeddingTokens: 0,
      estimatedCostUsd: 0,
      durationMs: 0,
    };
    const currentIds = new Set(chunks.map((chunk) => chunk.chunkId));
    const toDelete = [...known.keys()].filter((id) => !currentIds.has(id));
    if (toDelete.length > 0) {
      await queryFn(`DELETE FROM semantic.semantic_chunks WHERE chunk_id = ANY($1)`, [
        toDelete,
      ]);
      counts.deleted = toDelete.length;
    }
    const dirty = chunks.filter((chunk) => known.get(chunk.chunkId) !== contentHash(chunk));
    const vectors = dirty.length > 0 ? await options.embedder.embed(dirty.map((chunk) => chunk.content)) : [];
    const embeddingTokens =
      dirty.length === 0
        ? 0
        : dirty.reduce((sum, chunk) => sum + Math.max(1, Math.ceil(chunk.content.length / 4)), 0);
    const estimatedCostUsd = Number(((embeddingTokens / 1_000_000) * 0.02).toFixed(8));
    for (let index = 0; index < dirty.length; index++) {
      const chunk = dirty[index] as ParsedChunk;
      const vector = vectors[index] as number[];
      const hash = contentHash(chunk);
      const chunkMeta = chunk.metadata ?? validateChunkMetadata(chunk);
      const metadataJson = JSON.stringify(chunkMeta);
      const additiveValue = chunk.additive ?? null;
      if (known.has(chunk.chunkId)) {
        await queryFn(
          `UPDATE semantic.semantic_chunks
           SET doc_type = $2, table_name = $3, tables = $4, metric_name = $5,
               aliases = $6, sensitivity = $7, additive = $8, metadata = $9::jsonb,
               content = $10, content_hash = $11,
               embedding = $12::vector, updated_at = now()
           WHERE chunk_id = $1`,
          [
            chunk.chunkId, chunk.docType, chunk.table,
            chunk.tables.join(","), chunk.metricName,
            chunk.aliases.join(","), chunk.sensitivity, additiveValue,
            metadataJson, chunk.content,
            hash, `[${vector.join(",")}]`,
          ],
        );
        counts.updated += 1;
      } else {
        await queryFn(
          `INSERT INTO semantic.semantic_chunks
             (chunk_id, doc_type, table_name, tables, metric_name, aliases,
              sensitivity, additive, metadata, content, content_hash, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::vector, now())`,
          [
            chunk.chunkId, chunk.docType, chunk.table,
            chunk.tables.join(","), chunk.metricName,
            chunk.aliases.join(","), chunk.sensitivity, additiveValue,
            metadataJson, chunk.content,
            hash, `[${vector.join(",")}]`,
          ],
        );
        counts.added += 1;
      }
    }
    counts.skipped = chunks.length - dirty.length;
    counts.embeddingTokens = embeddingTokens;
    counts.estimatedCostUsd = estimatedCostUsd;
    counts.durationMs = Math.max(0, Date.now() - startedAt);
    return counts;
  } finally {
    if (pool !== null) await pool.end();
  }
}

const DEFAULT_FILES: CorpusFile[] = [
  { path: path.resolve("semantic/data_dictionary.md"), docType: "table" },
  { path: path.resolve("semantic/metrics.md"), docType: "metric" },
];

function inferDocType(fileBase: string, fallback: string): string {
  const lower = fileBase.toLowerCase();
  if (lower.includes("join")) return "join_rule";
  if (lower.includes("table")) return "table";
  if (lower.includes("column")) return "column";
  if (lower.includes("metric")) return "metric";
  if (lower.includes("example")) return "example";
  if (lower.includes("event")) return "event";
  return fallback;
}

const CANONICAL_YAML_ORDER = ["tables", "columns", "metrics", "joins", "examples", "events"];

export function discoverDefaultFiles(dirPath = path.resolve("semantic")): CorpusFile[] {
  try {
    if (!existsSync(dirPath)) return [...DEFAULT_FILES];
    const entries = readdirSync(dirPath).filter(
      (entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"),
    );
    if (entries.length === 0) return [...DEFAULT_FILES];
    entries.sort((a, b) => {
      const baseA = path.basename(a, path.extname(a)).toLowerCase();
      const baseB = path.basename(b, path.extname(b)).toLowerCase();
      const indexA = CANONICAL_YAML_ORDER.indexOf(baseA);
      const indexB = CANONICAL_YAML_ORDER.indexOf(baseB);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return a.localeCompare(b);
    });
    return entries.map((entry) => {
      const full = path.resolve(dirPath, entry);
      const base = path.basename(entry, path.extname(entry));
      return { path: full, docType: inferDocType(base, "metric") };
    });
  } catch {
    // Ignore filesystem errors; fall back to DEFAULT_FILES.
    return [...DEFAULT_FILES];
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.loadEnvFile?.();
  } catch {
    // ignore missing .env
  }
  const dbUrl =
    process.env["INDEXER_DATABASE_URL"] ??
    `postgresql://indexer:${process.env["INDEXER_PASSWORD"] ?? "chosen_indexer_dev"}@127.0.0.1:${process.env["POSTGRES_PORT"] ?? "5433"}/${process.env["POSTGRES_DB"] ?? "chosen"}`;
  const selection = selectEmbedderFromEnv();
  console.log(`[semantic-index] embedder: ${selection.source}`);
  const counts = await indexCorpus({
    dbUrl,
    embedder: selection.embedder,
    files: discoverDefaultFiles(),
  });
  console.log(
    `[semantic-index] added=${counts.added} updated=${counts.updated} skipped=${counts.skipped} deleted=${counts.deleted} embeddingTokens=${counts.embeddingTokens} estimatedCostUsd=${counts.estimatedCostUsd} durationMs=${counts.durationMs}`,
  );
}
