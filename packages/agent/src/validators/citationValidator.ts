export const CITATION_REPAIR_LIMIT = 2;

export const CITATION_HEADER_PREFIX = "-- @citations:";

export interface CitationIssue {
  code: "citation_unknown" | "citation_not_retrieved" | "citation_missing_metric" | "citation_header";
  field: string;
  message: string;
}

export type CitationValidation =
  | { ok: true; citations: string[]; sql: string | null }
  | { ok: false; issue: CitationIssue; missing: string[] };

export interface ValidateCitationsInput {
  citations: string[];
  sql?: string | null;
  requestedMetrics?: string[];
  retrievedChunkIds?: string[];
  catalogIds?: string[] | ReadonlySet<string>;
}

function normalizeId(id: string): string {
  return id.trim();
}

function catalogSet(input: ValidateCitationsInput): Set<string> {
  const raw = input.catalogIds;
  if (!raw) return new Set<string>();
  if (raw instanceof Set) return new Set<string>([...raw].map(normalizeId));
  return new Set<string>((raw as readonly string[]).map(normalizeId));
}

function expandRetrieved(ids: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of ids) {
    const id = normalizeId(raw);
    if (!id) continue;
    out.add(id);
    // column:orders.status <-> orders.status interop (retriever catalog rule).
    if (id.startsWith("column:")) out.add(id.slice("column:".length));
    else if (/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(id)) out.add(`column:${id}`);
    if (id.startsWith("metric:")) {
      const suffix = id.slice("metric:".length);
      if (suffix) out.add(suffix);
    }
  }
  return out;
}

export function parseCitationHeader(sql: string | null | undefined): string[] {
  if (!sql) return [];
  const first = sql.split("\n")[0]?.trim() ?? "";
  if (!first.toLowerCase().startsWith(CITATION_HEADER_PREFIX)) return [];
  const rest = first.slice(CITATION_HEADER_PREFIX.length).trim();
  if (!rest) return [];
  return rest
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function ensureCitationHeader(
  sql: string | null | undefined,
  citations: string[],
): string | null {
  if (sql === null || sql === undefined) return sql ?? null;
  const ids = [...new Set(citations.map(normalizeId).filter((id) => id.length > 0))].sort();
  const header = `${CITATION_HEADER_PREFIX} ${ids.join(", ")}`;
  const lines = sql.split("\n");
  if ((lines[0]?.trim().toLowerCase().startsWith(CITATION_HEADER_PREFIX)) ?? false) {
    lines[0] = header;
    return lines.join("\n");
  }
  return `${header}\n${sql}`;
}

export function validateCitations(input: ValidateCitationsInput): CitationValidation {
  const citations = input.citations.map(normalizeId).filter((id) => id.length > 0);
  const catalog = catalogSet(input);
  const retrieved = expandRetrieved(input.retrievedChunkIds ?? []);

  const wantsMetric = (input.requestedMetrics ?? []).length > 0;
  const isDataAnswer = typeof input.sql === "string" && input.sql.trim().length > 0;
  const isMetricOrData = wantsMetric || isDataAnswer || citations.length > 0;

  if (isMetricOrData && catalog.size === 0) {
    return {
      ok: false,
      issue: {
        code: "citation_unknown",
        field: "catalogIds",
        message: "citation catalog is empty; cannot validate citations for metric/data answer.",
      },
      missing: citations,
    };
  }

  if (isMetricOrData && retrieved.size === 0) {
    return {
      ok: false,
      issue: {
        code: "citation_not_retrieved",
        field: "retrievedChunkIds",
        message: "no chunks retrieved this turn; cannot validate citations for metric/data answer.",
      },
      missing: citations,
    };
  }

  const unknown = citations.filter((id) => !catalog.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      issue: {
        code: "citation_unknown",
        field: "citations",
        message: `citations not in catalog: ${unknown.join(", ")}.`,
      },
      missing: unknown,
    };
  }

  const notRetrieved = citations.filter((id) => !retrieved.has(id));
  if (notRetrieved.length > 0) {
    return {
      ok: false,
      issue: {
        code: "citation_not_retrieved",
        field: "citations",
        message: `citations not retrieved this turn: ${notRetrieved.join(", ")}.`,
      },
      missing: notRetrieved,
    };
  }

  if (wantsMetric && !citations.some((id) => id.startsWith("metric:"))) {
    return {
      ok: false,
      issue: {
        code: "citation_missing_metric",
        field: "citations",
        message: "metric queries must cite at least one metric:* chunk.",
      },
      missing: [],
    };
  }

  return { ok: true, citations, sql: ensureCitationHeader(input.sql ?? null, citations) };
}

/** Derives citations from retrieved chunks so the harness supplies grounding instead of letting the model invent IDs. */
export function deriveCitations(
  retrievedChunkIds: string[],
  opts: { max?: number } = {},
): string[] {
  const max = opts.max ?? 5;
  const ids = retrievedChunkIds.map(normalizeId).filter((id) => id.length > 0);
  const metrics = ids.filter((id) => id.startsWith("metric:"));
  const base = metrics.length > 0 ? metrics : ids;
  return [...new Set(base)].slice(0, Math.max(1, max));
}

export function repairCitations(
  input: ValidateCitationsInput,
  maxRepairs: number = CITATION_REPAIR_LIMIT,
): CitationValidation {
  let current: ValidateCitationsInput = { ...input };
  let last: CitationValidation = validateCitations(current);
  if (last.ok) return last;
  for (let attempt = 0; attempt < maxRepairs; attempt += 1) {
    if (last.ok) return last;
    if (last.issue.code === "citation_unknown" || last.issue.code === "citation_not_retrieved") {
      const bad = new Set(last.missing.map(normalizeId));
      const fallback = deriveCitations(current.retrievedChunkIds ?? []).filter(
        (id) => !bad.has(normalizeId(id)),
      );
      const kept = current.citations.filter((id) => !bad.has(normalizeId(id)));
      const next = [...new Set([...kept, ...fallback])];
      if (next.length === 0) break;
      current = { ...current, citations: next };
      last = validateCitations(current);
      if (last.ok) return last;
    } else if (last.issue.code === "citation_missing_metric") {
      const metricChunks = (current.retrievedChunkIds ?? [])
        .map(normalizeId)
        .filter((id) => id.startsWith("metric:"));
      if (metricChunks.length === 0) break;
      const next = [...new Set([...current.citations, ...metricChunks])];
      current = { ...current, citations: next };
      last = validateCitations(current);
      if (last.ok) return last;
    } else {
      break;
    }
  }
  return last;
}
