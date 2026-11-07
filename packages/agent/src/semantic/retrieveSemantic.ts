// retrieveSemantic node (UC-02, architecture §3.2.3 + §2.2).
//
// Calls MCP `search_semantic_layer` (3-way hybrid RRF + join-rule expansion
// server-side) and enforces the Two-Tier Unknown-Term Guardrail
// (`requestedMetrics` vs `schemaEntities`, §3.2.3):
// - `requestedMetrics.length === 0` passes straight through.
// - Every requested KPI must match a retrieved `metric`/`column` chunk via
//   `aliasMatched === true` OR dense similarity `>= 0.60`.
// - Any unmatched KPI short-circuits to `status: cannot_answer` listing the
//   closest valid metrics — before any SQL is generated (0 SQL queries).
//
// `queryMode === "definition_lookup"` retrieves chunks and lets the UC entry
// fast-path synthesize directly from them (bypassing SQL execution).
//
// Injected via RootGraphDeps.retrieve (the frozen root builder owns routing;
// this module owns MCP + guard logic). No `pg` imports: DB access goes
// through the MCP client only.

import type { SearchSemanticLayerChunk } from "@shared/contracts";
import { callMcpTool, type TracerRunConfig } from "../mcpClient.js";
import type { AgentState, AgentUpdate, RootRuntime } from "../state.js";

/** Calibrated dense-similarity threshold (text-embedding-3-small default). */
export const UNKNOWN_TERM_DENSE_THRESHOLD = 0.6;

/** Default top-K for the semantic search call. */
export const RETRIEVE_TOP_K = 8;

/** Max closest-metric suggestions in a cannot_answer message. */
export const CLOSEST_METRICS_LIMIT = 5;

export type SemanticSearchFn = (
  query: string,
  topK: number,
) => Promise<SearchSemanticLayerChunk[]>;

export interface RetrieveSemanticDeps {
  search?: SemanticSearchFn;
  topK?: number;
}

function readTransport(rt: RootRuntime): TracerRunConfig | null {
  const cfg = (rt.config.configurable ?? {}) as Record<string, unknown>;
  const read = (key: string): string | null => {
    const value = cfg[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const mcpUrl = read("mcpUrl");
  const token = read("token");
  const runId = read("runId");
  const userId = read("userId");
  const roleScope = read("roleScope");
  if (!mcpUrl || !token || !runId || !userId || !roleScope) return null;
  return { mcpUrl, token, runId, userId, roleScope };
}

function toStateChunk(chunk: SearchSemanticLayerChunk): AgentState["semanticChunks"][number] {
  const out: AgentState["semanticChunks"][number] = {
    chunkId: chunk.chunkId,
    score: chunk.score,
    text: chunk.content,
  };
  if (chunk.aliasMatched !== undefined) out.aliasMatched = chunk.aliasMatched;
  if (chunk.denseScore !== undefined) out.denseScore = chunk.denseScore;
  return out;
}

/**
 * Minimal chunk view shared by MCP contract chunks and checkpointed state
 * chunks (state stores `text` instead of `content` and omits docType).
 */
export interface GroundingChunk {
  chunkId: string;
  aliasMatched?: boolean;
  denseScore?: number;
  docType?: string;
  metricName?: string | null;
  content?: string;
  text?: string;
}

/**
 * A requested metric is grounded when a retrieved metric/column chunk both
 * mentions the term (or vice versa) AND is trusted via exact alias
 * (`aliasMatched === true`) or calibrated dense similarity (`>= 0.60`).
 * The text-overlap requirement attributes a single multi-metric retrieval to
 * the term it actually defines, so "net revenue + NPS" grounds the former
 * but still short-circuits on the latter. Single-metric questions skip the
 * overlap check: `aliasMatched` already means the server matched the query
 * alias, and contract chunks do not carry the alias list to re-verify.
 */
export function isMetricGrounded(
  term: string,
  chunks: GroundingChunk[],
  threshold: number = UNKNOWN_TERM_DENSE_THRESHOLD,
  allTerms: readonly string[] = [term],
): boolean {
  const needle = term.normalize("NFC").toLowerCase().trim();
  if (!needle) return true;
  const trusted = chunks.filter((chunk) => {
    const docType = chunk.docType ?? inferDocType(chunk.chunkId);
    if (docType !== "metric" && docType !== "column") return false;
    return (
      chunk.aliasMatched === true ||
      (typeof chunk.denseScore === "number" && chunk.denseScore >= threshold)
    );
  });
  if (trusted.length === 0) return false;
  // Single-concept question: server-side alias/dense match is sufficient.
  if (allTerms.length <= 1) return true;
  const needleTokens = new Set(
    needle.split(/[^a-z0-9\u00e0-\u1ef9]+/iu).filter((token) => token.length >= 2),
  );
  for (const chunk of trusted) {
    const body = chunk.content ?? chunk.text ?? "";
    const haystack = `${chunk.chunkId} ${chunk.metricName ?? ""} ${body}`
      .normalize("NFC")
      .toLowerCase();
    if (haystack.includes(needle)) return true;
    const metricTokens = (chunk.metricName ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 2);
    if (metricTokens.length > 0 && metricTokens.every((token) => haystack.includes(token))) {
      // Chunk metric name fully present; check the term shares a token.
      if (metricTokens.some((token) => needle.includes(token) || needleTokens.has(token))) {
        return true;
      }
    }
    if (needleTokens.size > 0) {
      let overlap = 0;
      for (const token of needleTokens) {
        if (haystack.includes(token)) overlap += 1;
      }
      if (overlap >= Math.min(2, needleTokens.size) || overlap / needleTokens.size >= 0.5) {
        return true;
      }
    }
  }
  return false;
}

function inferDocType(chunkId: string): string {
  const prefix = chunkId.split(":")[0] ?? "";
  if (
    prefix === "metric" ||
    prefix === "column" ||
    prefix === "table" ||
    prefix === "join_rule" ||
    prefix === "example" ||
    prefix === "event"
  ) {
    return prefix;
  }
  return "unknown";
}

/**
 * Per-term grounding check. A term with no trusted retrieved metric/column
 * chunk mentioning it is ungrounded.
 */
export function checkUnknownTerms(
  requestedMetrics: string[],
  chunks: GroundingChunk[],
  threshold: number = UNKNOWN_TERM_DENSE_THRESHOLD,
): { ungrounded: string[] } {
  if (requestedMetrics.length === 0) return { ungrounded: [] };
  return {
    ungrounded: requestedMetrics.filter(
      (term) => !isMetricGrounded(term, chunks, threshold, requestedMetrics),
    ),
  };
}

/** Closest valid metrics for the cannot_answer clarification prompt. */
export function closestMetrics(
  chunks: Pick<GroundingChunk, "chunkId">[],
  limit: number = CLOSEST_METRICS_LIMIT,
): string[] {
  const metrics = chunks
    .filter((chunk) => chunk.chunkId.startsWith("metric:"))
    .map((chunk) => chunk.chunkId);
  const deduped = [...new Set(metrics)];
  if (deduped.length > 0) return deduped.slice(0, limit);
  return chunks.map((chunk) => chunk.chunkId).slice(0, limit);
}

function hasUserSuppliedFormula(question: string): boolean {
  return /(formula\s*:|define\s+\w+\s+as\s+|custom\s+formula)/i.test(question);
}

export function buildCannotAnswer(
  requestedMetrics: string[],
  chunks: Pick<GroundingChunk, "chunkId">[],
): AgentUpdate {
  const closest = closestMetrics(chunks);
  const available = closest.length > 0 ? closest.join(", ") : "no metric chunks retrieved";
  return {
    status: "cannot_answer",
    answerText:
      `None of the requested metrics (${requestedMetrics.join(", ")}) were found in the data dictionary ` +
      `(available: ${available}); cannot answer without speculating. ` +
      `Please pick one of the available metrics or supply an explicit formula.`,
    pendingClarification: null,
  };
}

/** Definitional fast-path answer (RT → SYN): no SQL, verified citations. */
export function buildDefinitionAnswer(
  requestedMetrics: string[],
  chunks: SearchSemanticLayerChunk[],
): AgentUpdate {
  const metricsLabel =
    requestedMetrics.length > 0 ? requestedMetrics.join(", ") : "the requested term";
  if (chunks.length === 0) {
    return {
      status: "cannot_answer",
      answerText: `No semantic definitions were retrieved; cannot define ${metricsLabel}.`,
    };
  }
  const lines = chunks.slice(0, 5).map((chunk) => {
    const snippet = chunk.content.slice(0, 300);
    return `- ${chunk.chunkId}: ${snippet}`;
  });
  const citations = chunks
    .filter((chunk) => chunk.chunkId.startsWith("metric:"))
    .map((chunk) => chunk.chunkId)
    .slice(0, 5);
  const citationLine =
    citations.length > 0 ? `\nCitations: ${citations.join(", ")}.` : "";
  const prefix =
    requestedMetrics.length > 0
      ? `Definitions for ${requestedMetrics.join(", ")}:\n`
      : "Definitions:\n";
  return {
    status: "ok",
    sql: null,
    tablesUsed: [],
    columns: [],
    resultPreview: [],
    answerText: `${prefix}${lines.join("\n")}${citationLine}`,
  };
}

/**
 * Build the retrieve seam. Hosts inject `search` in tests/evals; production
 * resolves MCP identity from RunnableConfig (same shape as text-to-SQL).
 */
export function createRetrieveSemantic(deps: RetrieveSemanticDeps = {}): (
  state: AgentState,
  rt: RootRuntime,
) => Promise<AgentUpdate> {
  const topK = deps.topK ?? RETRIEVE_TOP_K;
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    const metrics = state.intent.requestedMetrics ?? [];
    const isDefinition = state.intent.queryMode === "definition_lookup";

    // Basic UC-01 queries pass straight through (no semantic search).
    if (metrics.length === 0 && !isDefinition) return {};

    const started = Date.now();
    let chunks: SearchSemanticLayerChunk[];
    if (deps.search) {
      chunks = await deps.search(state.question, topK);
    } else {
      const transport = readTransport(rt);
      if (!transport) {
        // Fail closed: metrics present (or a definition lookup) but no MCP
        // transport means we cannot ground them — never skip the gate with {}.
        // Basic UC-01 queries (no metrics, no definition) still pass through.
        if (metrics.length === 0 && !isDefinition) return {};
        return {
          status: "error",
          answerText:
            "Semantic grounding unavailable (MCP transport identity is incomplete); cannot verify requested metrics without speculating.",
        };
      }
      const raw = await callMcpTool(transport, "search_semantic_layer", {
        query: state.question,
        topK,
      });
      const parsed = JSON.parse(raw.text) as { chunks?: SearchSemanticLayerChunk[] };
      chunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    }
    rt.emit({
      node: "retrieve",
      type: "tool_call",
      durationMs: Date.now() - started,
      payload: { tool: "search_semantic_layer", chunkCount: chunks.length },
    });

    const stateChunks = chunks.map(toStateChunk);

    // Unknown-term gate: short-circuit before any SQL (0 SQL queries).
    if (!hasUserSuppliedFormula(state.question)) {
      const { ungrounded } = checkUnknownTerms(metrics, chunks);
      if (ungrounded.length > 0) {
        rt.emit({
          node: "retrieve",
          type: "node_done",
          durationMs: 0,
          payload: { gate: "unknown_term", ungrounded },
        });
        return { semanticChunks: stateChunks, ...buildCannotAnswer(ungrounded, chunks) };
      }
    }

    rt.emit({
      node: "retrieve",
      type: "node_done",
      durationMs: 0,
      payload: {
        gate: isDefinition ? "definition_lookup" : "data_query",
        chunkIds: chunks.map((chunk) => chunk.chunkId),
      },
    });
    return { semanticChunks: stateChunks };
  };
}
