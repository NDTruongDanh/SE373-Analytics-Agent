import {
  dbToolError,
  SearchSemanticLayerOutputSchema,
  type SearchSemanticLayerChunk,
} from "@shared/contracts";
import {
  callMcpTool,
  parseMcpToolError,
  toNormalizedMcpError,
  type TracerRunConfig,
} from "../mcpClient.js";
import type { AgentState, AgentUpdate, RootRuntime } from "../state.js";
import { loadSemanticCatalogIds } from "./catalog.js";

export const UNKNOWN_TERM_DENSE_THRESHOLD = 0.6;

export const RETRIEVE_TOP_K = 8;

export const CLOSEST_METRICS_LIMIT = 5;

export type SemanticSearchFn = (
  query: string,
  topK: number,
) => Promise<SearchSemanticLayerChunk[]>;

export interface RetrieveSemanticDeps {
  search?: SemanticSearchFn;
  topK?: number;
  catalogIds?: string[] | ReadonlySet<string>;
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
  return { mcpUrl, token, runId, userId, roleScope, callbacks: rt.config.callbacks };
}

export function toStateChunk(
  chunk: SearchSemanticLayerChunk,
): AgentState["semanticChunks"][number] {
  const out: AgentState["semanticChunks"][number] = {
    chunkId: chunk.chunkId,
    docType: chunk.docType,
    table: chunk.table,
    score: chunk.score,
    text: chunk.content,
  };
  if (chunk.aliasMatched !== undefined) out.aliasMatched = chunk.aliasMatched;
  if (chunk.denseScore !== undefined) out.denseScore = chunk.denseScore;
  const tables = [...new Set([...(chunk.table ? [chunk.table] : []), ...chunk.tables])];
  if (tables.length > 0) out.tables = tables;
  return out;
}

export async function fetchSemanticChunks(
  transport: TracerRunConfig,
  query: string,
  topK: number = RETRIEVE_TOP_K,
): Promise<SearchSemanticLayerChunk[]> {
  const raw = await callMcpTool(transport, "search_semantic_layer", {
    query,
    topK,
  });
  if (raw.isError) {
    throw parseMcpToolError("search_semantic_layer", raw.text);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.text);
  } catch {
    throw dbToolError(
      "INTERNAL_ERROR",
      "MCP tool search_semantic_layer returned invalid JSON",
    );
  }
  const validated = SearchSemanticLayerOutputSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw dbToolError(
      "INTERNAL_ERROR",
      "MCP tool search_semantic_layer returned an unexpected shape",
    );
  }
  return validated.data.chunks;
}

export interface GroundingChunk {
  chunkId: string;
  aliasMatched?: boolean;
  denseScore?: number;
  docType?: string;
  metricName?: string | null;
  content?: string;
  text?: string;
}

// Multi-metric queries require chunk text overlap so one matched KPI cannot ground an unknown sibling;
// single-metric queries skip overlap because contract chunks omit the alias list that aliasMatched used.
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

export function closestMetrics(
  chunks: Pick<GroundingChunk, "chunkId">[],
  limit: number = CLOSEST_METRICS_LIMIT,
  catalogIds?: string[] | ReadonlySet<string>,
): string[] {
  const metrics = chunks
    .filter((chunk) => chunk.chunkId.startsWith("metric:"))
    .map((chunk) => chunk.chunkId);
  const deduped = [...new Set(metrics)];
  if (deduped.length > 0) return deduped.slice(0, limit);
  if (catalogIds) {
    const catalogMetrics = [...catalogIds].filter((id) =>
      id.startsWith("metric:"),
    );
    if (catalogMetrics.length > 0) return catalogMetrics.slice(0, limit);
  }
  return chunks.map((chunk) => chunk.chunkId).slice(0, limit);
}

function hasUserSuppliedFormula(question: string): boolean {
  return /(formula\s*:|define\s+\w+\s+as\s+|custom\s+formula)/i.test(question);
}

export function buildCannotAnswer(
  requestedMetrics: string[],
  chunks: Pick<GroundingChunk, "chunkId">[],
  catalogIds?: string[] | ReadonlySet<string>,
): AgentUpdate {
  const closest = closestMetrics(chunks, CLOSEST_METRICS_LIMIT, catalogIds);
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

export function createRetrieveSemantic(deps: RetrieveSemanticDeps = {}): (
  state: AgentState,
  rt: RootRuntime,
) => Promise<AgentUpdate> {
  const topK = deps.topK ?? RETRIEVE_TOP_K;
  const catalogIds = deps.catalogIds ?? loadSemanticCatalogIds();
  return async (state: AgentState, rt: RootRuntime): Promise<AgentUpdate> => {
    if (
      state.status === "error" ||
      state.status === "restricted" ||
      state.status === "cannot_answer" ||
      state.status === "needs_clarification"
    ) {
      return {};
    }
    const metrics = state.intent.requestedMetrics ?? [];
    const query = state.semanticQuery?.trim() || state.question;
    const isDefinition = state.intent.queryMode === "definition_lookup";
    const needsGrounding = metrics.length > 0 || isDefinition;

    // Reuse pre-intent retrieval for the same question to avoid a duplicate MCP search.
    if (
      state.semanticRetrieveStatus === "ok" &&
      state.semanticQuery === query
    ) {
      if (!hasUserSuppliedFormula(state.question) && metrics.length > 0) {
        const { ungrounded } = checkUnknownTerms(metrics, state.semanticChunks);
        if (ungrounded.length > 0) {
          rt.emit({
            node: "retrieve",
            type: "node_done",
            durationMs: 0,
            payload: { gate: "unknown_term", ungrounded, reusedPreRetrieval: true },
          });
          return buildCannotAnswer(ungrounded, state.semanticChunks, catalogIds);
        }
      }
      rt.emit({
        node: "retrieve",
        type: "node_done",
        durationMs: 0,
        payload: {
          gate: isDefinition ? "definition_lookup" : "data_query",
          reusedPreRetrieval: true,
          chunkIds: state.semanticChunks.map((chunk) => chunk.chunkId),
        },
      });
      return {};
    }

    const started = Date.now();
    let chunks: SearchSemanticLayerChunk[];
    try {
      if (deps.search) {
        chunks = await deps.search(query, topK);
      } else {
        const transport = readTransport(rt);
        if (!transport) {
          // Fail closed when metrics/definitions cannot be grounded without transport;
          // plain data queries without transport still pass through for unit tests.
          if (!needsGrounding) return {};
          return {
            status: "error",
            semanticRetrieveStatus: "error",
            semanticErrorCode: "INTERNAL_ERROR",
            answerText:
              "Semantic grounding unavailable (MCP transport identity is incomplete); cannot verify requested metrics without speculating.",
          };
        }
        chunks = await fetchSemanticChunks(transport, query, topK);
      }
    } catch (error) {
      const normalized = toNormalizedMcpError("search_semantic_layer", error);
      rt.emit({
        node: "retrieve",
        type: "tool_call",
        durationMs: Date.now() - started,
        payload: {
          tool: "search_semantic_layer",
          ok: false,
          code: normalized.code,
        },
      });
      // Metric/definition queries stay fail-closed (never speculate or claim out-of-schema).
      if (needsGrounding) {
        return {
          status:
            normalized.code === "SCOPE_DENIED" || normalized.code === "UNAUTHORIZED"
              ? "restricted"
              : "error",
          semanticRetrieveStatus: "error",
          semanticErrorCode: normalized.code,
          answerText: `Semantic grounding failed (${normalized.code}): ${normalized.message}`,
        };
      }
      // Plain data queries degrade instead of failing so catalog-verified entities can proceed without false out-of-schema claims.
      rt.emit({
        node: "retrieve",
        type: "node_done",
        durationMs: 0,
        payload: {
          gate: "data_query",
          degraded: true,
          errorCode: normalized.code,
          chunkIds: [],
        },
      });
      return {
        semanticRetrieveStatus: "error",
        semanticErrorCode: normalized.code,
      };
    }
    rt.emit({
      node: "retrieve",
      type: "tool_call",
      durationMs: Date.now() - started,
      payload: { tool: "search_semantic_layer", ok: true, chunkCount: chunks.length },
    });

    const stateChunks = chunks.map(toStateChunk);

    if (!hasUserSuppliedFormula(state.question)) {
      const { ungrounded } = checkUnknownTerms(metrics, chunks);
      if (ungrounded.length > 0) {
        rt.emit({
          node: "retrieve",
          type: "node_done",
          durationMs: 0,
          payload: { gate: "unknown_term", ungrounded },
        });
        return {
          semanticChunks: stateChunks,
          semanticQuery: query,
          semanticRetrieveStatus: "ok",
          semanticErrorCode: null,
          ...buildCannotAnswer(ungrounded, chunks, catalogIds),
        };
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
    return {
      semanticChunks: stateChunks,
      semanticQuery: query,
      semanticRetrieveStatus: "ok",
      semanticErrorCode: null,
    };
  };
}
