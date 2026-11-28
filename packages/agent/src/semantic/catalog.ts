import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { SqlIdentifierAliases } from "@shared/access-policy";

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
let cachedAliases: SqlIdentifierAliases | null = null;
let cachedJoinEdges: readonly (readonly [string, string])[] | null = null;
let cachedJoinRules: readonly SemanticJoinRuleMeta[] | null = null;

export interface SemanticJoinRuleMeta {
  chunkId: string;
  table: string | null;
  tables: string[];
  cardinality: "1:1" | "1:N" | "N:1" | "M:N";
  grain?: string;
}

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

export function loadSqlIdentifierAliases(
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): SqlIdentifierAliases {
  if (semanticDir === DEFAULT_SEMANTIC_DIR && cachedAliases !== null) return cachedAliases;
  const aliases: {
    tables: Record<string, string[]>;
    columns: Record<string, Record<string, string[]>>;
  } = { tables: {}, columns: {} };
  for (const file of ["tables.yaml", "columns.yaml"] as const) {
    const fullPath = path.join(semanticDir, file);
    if (!existsSync(fullPath)) continue;
    for (const entry of entriesFromYaml(readFileSync(fullPath, "utf8"))) {
      if (entry["sensitivity"] === "restricted_pii") continue;
      const names = Array.isArray(entry["aliases"])
        ? entry["aliases"].filter((value): value is string => typeof value === "string")
        : [];
      if (names.length === 0) continue;
      if (file === "tables.yaml") {
        const table = entry["table"];
        if (typeof table === "string") aliases.tables[table] = names;
      } else {
        const column = entry["column"];
        if (typeof column !== "string") continue;
        const parts = column.split(".");
        if (parts.length !== 2) continue;
        const table = parts[0] as string;
        const name = parts[1] as string;
        if (!aliases.columns[table]) aliases.columns[table] = {};
        aliases.columns[table][name] = names;
      }
    }
  }
  if (semanticDir === DEFAULT_SEMANTIC_DIR) cachedAliases = aliases;
  return aliases;
}

export function loadSemanticJoinEdges(
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): readonly (readonly [string, string])[] {
  if (semanticDir === DEFAULT_SEMANTIC_DIR && cachedJoinEdges !== null) return cachedJoinEdges;
  const fullPath = path.join(semanticDir, "tables.yaml");
  const edges = new Map<string, readonly [string, string]>();
  if (existsSync(fullPath)) {
    for (const entry of entriesFromYaml(readFileSync(fullPath, "utf8"))) {
      if (entry["docType"] !== "table" || typeof entry["table"] !== "string") continue;
      const source = entry["table"];
      const content = typeof entry["content"] === "string" ? entry["content"] : "";
      for (const match of content.matchAll(/\bFK\s+to\s+([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*/gi)) {
        const target = match[1] as string;
        if (source === target) continue;
        const pair = [source, target].sort() as [string, string];
        edges.set(pair.join("\u0000"), pair);
      }
    }
  }
  edges.set("orders\u0000promotions", ["orders", "promotions"]);
  const result = [...edges.values()].sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
  if (semanticDir === DEFAULT_SEMANTIC_DIR) cachedJoinEdges = result;
  return result;
}

export function loadSemanticJoinRules(
  semanticDir: string = DEFAULT_SEMANTIC_DIR,
): readonly SemanticJoinRuleMeta[] {
  if (semanticDir === DEFAULT_SEMANTIC_DIR && cachedJoinRules !== null) return cachedJoinRules;
  const fullPath = path.join(semanticDir, "joins.yaml");
  const rules: SemanticJoinRuleMeta[] = [];
  if (existsSync(fullPath)) {
    for (const entry of entriesFromYaml(readFileSync(fullPath, "utf8"))) {
      if (entry["docType"] !== "join_rule") continue;
      const rawTables = entry["tables"];
      const tables = Array.isArray(rawTables)
        ? rawTables.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : [];
      const card = entry["cardinality"];
      const cardinality =
        card === "1:1" || card === "1:N" || card === "N:1" || card === "M:N"
          ? card
          : "1:N";
      rules.push({
        chunkId: String(entry["chunkId"] ?? ""),
        table: typeof entry["table"] === "string" ? entry["table"].toLowerCase() : null,
        tables,
        cardinality,
        grain: typeof entry["grain"] === "string" ? entry["grain"] : undefined,
      });
    }
  }
  if (semanticDir === DEFAULT_SEMANTIC_DIR) cachedJoinRules = rules;
  return rules;
}

export function resetSemanticCatalogCacheForTests(): void {
  cachedCatalog = null;
  cachedAliases = null;
  cachedJoinEdges = null;
  cachedJoinRules = null;
}
