// Semantic indexer (MCP-02): chunks the versioned corpus markdown files,
// embeds through the configured embedder, and upserts into
// semantic_chunks with SHA-256 content_hash dedup so re-runs are
// incremental (new chunks inserted, changed chunks re-embedded, unchanged
// chunks skipped). Operator-run via tsx against this module directly — no
// new package script. Writes as the indexer role over INDEXER_DATABASE_URL.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { parse as parseYaml } from "yaml";
import { selectEmbedderFromEnv, type Embedder } from "./embedder.js";

export interface CorpusFile {
  path: string;
  docType: string;
}

export interface ParsedChunk {
  chunkId: string;
  docType: string;
  table: string | null;
  tables: string[];
  metricName: string | null;
  aliases: string[];
  sensitivity: "public" | "internal" | "restricted_pii";
  content: string;
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
    chunks.push({
      chunkId: `${source}:${slug(cleanTitle)}`,
      docType,
      table,
      tables,
      metricName,
      aliases,
      sensitivity: restricted ? "restricted_pii" : "public",
      content: current.join("\n").trim(),
    });
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
    const contentRaw =
      record["content"] ??
      record["body"] ??
      record["description"] ??
      record["text"] ??
      "";
    const content = String(contentRaw).trim();
    if (!content) return;
    chunks.push({
      chunkId,
      docType: String(docTypeRaw),
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
      content,
    });
  });
  return chunks;
}

export function contentHash(chunk: ParsedChunk): string {
  const canonical = JSON.stringify({
    chunkId: chunk.chunkId,
    docType: chunk.docType,
    table: chunk.table,
    tables: chunk.tables,
    metricName: chunk.metricName,
    aliases: chunk.aliases,
    sensitivity: chunk.sensitivity,
    content: chunk.content,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface IndexCounts {
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
}

export async function indexCorpus(options: {
  dbUrl: string;
  embedder: Embedder;
  files: CorpusFile[];
}): Promise<IndexCounts> {
  const pool = new Pool({ connectionString: options.dbUrl, max: 2 });
  try {
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
    const existing = await pool.query(
      "SELECT chunk_id, content_hash FROM semantic.semantic_chunks",
    );
    const known = new Map<string, string>();
    for (const row of existing.rows) {
      known.set(String(row["chunk_id"]), String(row["content_hash"]));
    }
    const counts: IndexCounts = { added: 0, updated: 0, skipped: 0, deleted: 0 };
    const currentIds = new Set(chunks.map((chunk) => chunk.chunkId));
    const toDelete = [...known.keys()].filter((id) => !currentIds.has(id));
    if (toDelete.length > 0) {
      await pool.query(`DELETE FROM semantic.semantic_chunks WHERE chunk_id = ANY($1)`, [
        toDelete,
      ]);
      counts.deleted = toDelete.length;
    }
    const dirty = chunks.filter((chunk) => known.get(chunk.chunkId) !== contentHash(chunk));
    const vectors = await options.embedder.embed(dirty.map((chunk) => chunk.content));
    for (let index = 0; index < dirty.length; index++) {
      const chunk = dirty[index] as ParsedChunk;
      const vector = vectors[index] as number[];
      const hash = contentHash(chunk);
      if (known.has(chunk.chunkId)) {
        await pool.query(
          `UPDATE semantic.semantic_chunks
           SET doc_type = $2, table_name = $3, tables = $4, metric_name = $5,
               aliases = $6, sensitivity = $7, content = $8, content_hash = $9,
               embedding = $10::vector, updated_at = now()
           WHERE chunk_id = $1`,
          [
            chunk.chunkId, chunk.docType, chunk.table,
            chunk.tables.join(","), chunk.metricName,
            chunk.aliases.join(","), chunk.sensitivity, chunk.content,
            hash, `[${vector.join(",")}]`,
          ],
        );
        counts.updated += 1;
      } else {
        await pool.query(
          `INSERT INTO semantic.semantic_chunks
             (chunk_id, doc_type, table_name, tables, metric_name, aliases,
              sensitivity, metadata, content, content_hash, embedding, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9, $10::vector, now())`,
          [
            chunk.chunkId, chunk.docType, chunk.table,
            chunk.tables.join(","), chunk.metricName,
            chunk.aliases.join(","), chunk.sensitivity, chunk.content,
            hash, `[${vector.join(",")}]`,
          ],
        );
        counts.added += 1;
      }
    }
    counts.skipped = chunks.length - dirty.length;
    return counts;
  } finally {
    await pool.end();
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

export function discoverDefaultFiles(): CorpusFile[] {
  const files: CorpusFile[] = [...DEFAULT_FILES];
  try {
    const dir = path.resolve("semantic");
    if (!existsSync(dir)) return files;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (!(entry.endsWith(".yaml") || entry.endsWith(".yml"))) continue;
      const full = path.resolve("semantic", entry);
      if (files.some((file) => file.path === full)) continue;
      const base = path.basename(entry, path.extname(entry));
      files.push({ path: full, docType: inferDocType(base, "metric") });
    }
  } catch {
    // Ignore filesystem errors; fall back to DEFAULT_FILES.
  }
  return files;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dbUrl = process.env["INDEXER_DATABASE_URL"];
  if (!dbUrl) {
    console.error("INDEXER_DATABASE_URL is not set");
    process.exit(1);
  }
  const selection = selectEmbedderFromEnv();
  console.log(`[semantic-index] embedder: ${selection.source}`);
  const counts = await indexCorpus({
    dbUrl,
    embedder: selection.embedder,
    files: discoverDefaultFiles(),
  });
  console.log(
    `[semantic-index] added=${counts.added} updated=${counts.updated} skipped=${counts.skipped} deleted=${counts.deleted}`,
  );
}
