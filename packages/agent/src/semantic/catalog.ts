import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const SEMANTIC_FILES = [
  "tables.yaml",
  "columns.yaml",
  "metrics.yaml",
  "joins.yaml",
  "examples.yaml",
  "events.yaml",
] as const;

export const DEFAULT_SEMANTIC_DIR = fileURLToPath(
  new URL("../../../../semantic", import.meta.url),
);

let cachedCatalog: ReadonlySet<string> | null = null;

function entriesFromYaml(text: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === "object",
    );
  }
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["chunks"])) {
      return (obj["chunks"] as unknown[]).filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object",
      );
    }
  }
  return [];
}

function collectEntryIds(
  entry: Record<string, unknown>,
  out: Set<string>,
): void {
  const chunkRaw = entry["chunkId"] ?? entry["chunk_id"] ?? entry["id"];
  const chunkId = typeof chunkRaw === "string" ? chunkRaw.trim() : "";
  if (chunkId) {
    out.add(chunkId);
    out.add(chunkId.replace(/^column:/, ""));
  }

  const metricRaw =
    entry["metricName"] ?? entry["metric_name"] ?? entry["metric"];
  if (typeof metricRaw === "string" && metricRaw.trim()) {
    out.add(`metric:${metricRaw.trim()}`);
  }

  const rawTables = entry["tables"];
  const tables = Array.isArray(rawTables)
    ? rawTables
        .map((t) => String(t).trim())
        .filter((t) => t.length > 0)
    : [];
  let table =
    typeof entry["table"] === "string" && entry["table"].trim()
      ? entry["table"].trim()
      : null;
  if (table === null && tables.length === 1) {
    table = tables[0] ?? null;
  }
  if (table) {
    out.add(`table:${table}`);
    out.add(table);
  }
}

export function loadSemanticCatalogIds(
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): ReadonlySet<string> {
  if (semanticDir === DEFAULT_SEMANTIC_DIR && cachedCatalog !== null) {
    return cachedCatalog;
  }
  const ids = new Set<string>();
  for (const file of SEMANTIC_FILES) {
    const fullPath = path.join(semanticDir, file);
    if (!existsSync(fullPath)) continue;
    const text = readFileSync(fullPath, "utf8");
    for (const entry of entriesFromYaml(text)) {
      collectEntryIds(entry, ids);
    }
  }
  if (semanticDir === DEFAULT_SEMANTIC_DIR) {
    cachedCatalog = ids;
  }
  return ids;
}

export function resetSemanticCatalogCacheForTests(): void {
  cachedCatalog = null;
}
