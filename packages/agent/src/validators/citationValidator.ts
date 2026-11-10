// Deterministic CitationValidator (UC-02 K7, architecture §3.2.9).
//
// Verifies that 100% of IDs in `citations` exist in the semantic/schema
// catalog AND were retrieved in the current turn, requires >= 1 `metric:*`
// citation for metric queries, and deterministically prepends
// `-- @citations: ...` to `SQLAnswer.sql` (<= 2 self-correction retries).
//
// Pure function — no model, no I/O, no pg.

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
    // metric:net_revenue <-> net_revenue interop.
    if (id.startsWith("metric:")) {
      const suffix = id.slice("metric:".length);
      if (suffix) out.add(suffix);
    }
  }
  return out;
}

/**
 * Parse the `-- @citations: a, b` header (line 1) from SQL. Returns [] when
 * no header is present.
 */
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

/**
 * Deterministically prepend (or replace) the `-- @citations: ...` header.
 * Normalizes to `id1, id2` sorted for stable output.
 */
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

/**
 * Validate citations against the catalog and the current turn's retrieved
 * set. Rules (UC-02 Feature 5):
 * 1. Every citation exists in the catalog.
 * 2. Every citation was retrieved this turn (or is its column:/metric: variant).
 * 3. Metric queries (requestedMetrics.length > 0) cite >= 1 `metric:*`.
 */
export function validateCitations(input: ValidateCitationsInput): CitationValidation {
  const citations = input.citations.map(normalizeId).filter((id) => id.length > 0);
  const catalog = catalogSet(input);
  const retrieved = expandRetrieved(input.retrievedChunkIds ?? []);

  const unknown = citations.filter((id) => catalog.size > 0 && !catalog.has(id));
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

  const notRetrieved = citations.filter((id) => retrieved.size > 0 && !retrieved.has(id));
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

  const wantsMetric = (input.requestedMetrics ?? []).length > 0;
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

/**
 * Derive a minimal valid citation set from retrieved chunks: prefer
 * retrieved `metric:*` chunks (up to 5), else the top retrieved chunkIds.
 * Used when the SQL proposer omits citations — the harness fills them from
 * grounding rather than letting the model invent IDs.
 */
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

/**
 * Repair loop helper (<= 2 retries): replaces invalid IDs with exact IDs
 * from the retrieved context, then re-validates. Returns the first passing
 * result, else the last failure.
 */
export function repairCitations(
  input: ValidateCitationsInput,
  maxRepairs: number = CITATION_REPAIR_LIMIT,
): CitationValidation {
  let current: ValidateCitationsInput = { ...input };
  let last: CitationValidation = validateCitations(current);
  if (last.ok) return last;
  for (let attempt = 0; attempt < maxRepairs; attempt += 1) {
    if (!last.ok && (last.issue.code === "citation_unknown" || last.issue.code === "citation_not_retrieved")) {
      const bad = new Set(last.missing.map(normalizeId));
      const fallback = deriveCitations(current.retrievedChunkIds ?? []);
      const kept = current.citations.filter((id) => !bad.has(normalizeId(id)));
      const next = [...new Set([...kept, ...fallback])];
      if (next.length === 0) break;
      current = { ...current, citations: next };
      last = validateCitations(current);
      if (last.ok) return last;
    } else {
      break;
    }
  }
  return last;
}
