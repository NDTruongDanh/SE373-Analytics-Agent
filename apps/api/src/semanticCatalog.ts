import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  SemanticCatalogCountsSchema,
  SemanticCatalogItemSchema,
  SemanticCatalogResponseSchema,
  SemanticDocTypeSchema,
  SemanticSensitivitySchema,
  type SemanticCatalogCounts,
  type SemanticCatalogItem,
  type SemanticCatalogResponse,
  type SemanticDocType,
  type SemanticSensitivity,
} from "@shared/contracts";

const CANONICAL_YAML_ORDER = [
  "tables",
  "columns",
  "metrics",
  "joins",
  "examples",
  "events",
];

function inferDocType(fileBase: string): SemanticDocType {
  const lower = fileBase.toLowerCase();
  if (lower.includes("join")) return "join_rule";
  if (lower.includes("table")) return "table";
  if (lower.includes("column")) return "column";
  if (lower.includes("metric")) return "metric";
  if (lower.includes("example")) return "example";
  if (lower.includes("event")) return "event";
  return "metric";
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u1ef9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickStringArray(
  record: Record<string, unknown>,
  ...keys: string[]
): string[] | undefined {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      const parsed = asStringArray(record[key]);
      if (parsed.length > 0) return parsed;
    }
  }
  return undefined;
}

function emptyCounts(): SemanticCatalogCounts {
  return SemanticCatalogCountsSchema.parse({
    table: 0,
    column: 0,
    metric: 0,
    join_rule: 0,
    example: 0,
    event: 0,
  });
}

function normalizeDocType(value: unknown, fallback: SemanticDocType): SemanticDocType {
  const parsed = SemanticDocTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function normalizeSensitivity(value: unknown): SemanticSensitivity {
  const parsed = SemanticSensitivitySchema.safeParse(value);
  return parsed.success ? parsed.data : "public";
}

function extractEntries(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["chunks"])) {
      return obj["chunks"].filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      );
    }
    return [obj];
  }
  return [];
}

function toIsoTimestamp(value: unknown, fallbackIso: string): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return fallbackIso;
}

function latestIso(timestamps: (string | null | undefined)[]): string | null {
  let maxMs = -Infinity;
  let maxIso: string | null = null;
  for (const ts of timestamps) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
      maxIso = new Date(ms).toISOString();
    }
  }
  return maxIso;
}

/** Default semantic corpus directory: `<repo>/semantic` from this module. */
export function defaultSemanticDir(): string {
  const cwdCandidate = path.resolve("semantic");
  if (existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "semantic");
}

/**
 * Load read-only semantic layer catalog metadata from versioned YAML corpus files.
 * Never connects to PostgreSQL or exposes raw PII rows.
 */
export function loadSemanticCatalogFromDir(
  semanticDir = defaultSemanticDir(),
  lastReindexedAt: string | null = null,
): SemanticCatalogResponse {
  const counts = emptyCounts();
  const items: SemanticCatalogItem[] = [];

  if (!existsSync(semanticDir)) {
    return SemanticCatalogResponseSchema.parse({
      totalChunks: 0,
      countsByDocType: counts,
      lastUpdatedAt: lastReindexedAt,
      items: [],
    });
  }

  const entries = readdirSync(semanticDir).filter(
    (entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"),
  );
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

  for (const entry of entries) {
    const fullPath = path.resolve(semanticDir, entry);
    const base = path.basename(entry, path.extname(entry));
    const defaultDocType = inferDocType(base);
    const fileMtimeIso = statSync(fullPath).mtime.toISOString();
    const raw = readFileSync(fullPath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue;
    }

    const records = extractEntries(parsed);
    records.forEach((record, index) => {
      let tables = asStringArray(record["tables"]);
      const table = pickString(record, "table") ?? (tables.length === 1 ? tables[0]! : null);
      if (tables.length === 0 && table !== null) {
        tables = [table];
      }
      const metricName = pickString(record, "metricName", "metric_name", "metric") ?? null;
      const aliases = asStringArray(record["aliases"]);
      const docType = normalizeDocType(
        record["docType"] ?? record["doc_type"],
        defaultDocType,
      );
      const sensitivity = normalizeSensitivity(record["sensitivity"]);
      const rawId = pickString(record, "chunkId", "chunk_id", "id");
      const fallbackTitle =
        pickString(record, "title", "name", "column") ??
        metricName ??
        table ??
        `chunk-${index}`;
      const chunkId = rawId ?? `${base}:${slug(fallbackTitle)}`;
      const summary =
        pickString(record, "content", "description", "body", "text", "question") ??
        fallbackTitle;

      const formula = pickString(record, "formula");
      const sqlTemplate = pickString(record, "sqlTemplate", "sql_template", "sql");
      const caveats = pickStringArray(record, "caveats") ?? [];
      const primaryKey = pickString(record, "primaryKey", "primary_key");
      const grain = pickString(record, "grain");
      const rowCountScale = pickString(record, "rowCountScale", "row_count_scale");
      const column = pickString(record, "column");
      const dataType = pickString(record, "dataType", "data_type");
      const enumValues = pickStringArray(record, "enumValues", "enum_values");
      const question = pickString(record, "question");
      const citedMetrics = pickStringArray(record, "citedMetrics", "cited_metrics");
      const startDate = pickString(record, "startDate", "start_date");
      const endDate = pickString(record, "endDate", "end_date");
      const affectedRegions = pickStringArray(record, "affectedRegions", "affected_regions");
      const affectedChannels = pickStringArray(record, "affectedChannels", "affected_channels");
      const additive =
        typeof record["additive"] === "boolean" ? record["additive"] : undefined;
      const updatedAt = toIsoTimestamp(
        record["updatedAt"] ?? record["updated_at"],
        fileMtimeIso,
      );

      const item = SemanticCatalogItemSchema.parse({
        chunkId,
        docType,
        table,
        tables,
        metricName,
        aliases,
        sensitivity,
        ...(additive !== undefined ? { additive } : {}),
        updatedAt,
        summary,
        ...(formula !== undefined ? { formula } : {}),
        ...(sqlTemplate !== undefined ? { sqlTemplate } : {}),
        caveats,
        ...(primaryKey !== undefined ? { primaryKey } : {}),
        ...(grain !== undefined ? { grain } : {}),
        ...(rowCountScale !== undefined ? { rowCountScale } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(dataType !== undefined ? { dataType } : {}),
        ...(enumValues !== undefined ? { enumValues } : {}),
        ...(question !== undefined ? { question } : {}),
        ...(citedMetrics !== undefined ? { citedMetrics } : {}),
        ...(startDate !== undefined ? { startDate } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
        ...(affectedRegions !== undefined ? { affectedRegions } : {}),
        ...(affectedChannels !== undefined ? { affectedChannels } : {}),
      });

      items.push(item);
      counts[item.docType] += 1;
    });
  }

  const lastUpdatedAt = latestIso([
    ...items.map((item) => item.updatedAt),
    lastReindexedAt,
  ]);

  return SemanticCatalogResponseSchema.parse({
    totalChunks: items.length,
    countsByDocType: counts,
    lastUpdatedAt,
    items,
  });
}

/**
 * Filter items in a semantic catalog response while preserving total counts and timestamps.
 */
export function filterSemanticCatalog(
  catalog: SemanticCatalogResponse,
  filters: { docType?: SemanticDocType; q?: string },
): SemanticCatalogResponse {
  const query = filters.q?.trim().toLowerCase() ?? "";
  const filteredItems = catalog.items.filter((item) => {
    if (filters.docType && item.docType !== filters.docType) {
      return false;
    }
    if (!query) return true;
    const haystacks: string[] = [
      item.chunkId,
      item.docType,
      item.table ?? "",
      ...item.tables,
      item.metricName ?? "",
      ...item.aliases,
      item.summary,
      item.formula ?? "",
      item.column ?? "",
      item.question ?? "",
      ...item.caveats,
    ];
    return haystacks.some((field) => field.toLowerCase().includes(query));
  });

  return SemanticCatalogResponseSchema.parse({
    totalChunks: catalog.totalChunks,
    countsByDocType: catalog.countsByDocType,
    lastUpdatedAt: catalog.lastUpdatedAt,
    items: filteredItems,
  });
}
