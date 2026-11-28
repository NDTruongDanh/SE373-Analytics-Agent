import { createHash } from "node:crypto";
import { redactPII } from "@shared/access-policy";
import {
  AnalysisStateSchema,
  IntentFilterSchema,
  type AnalysisState,
  type IntentFilter,
} from "@shared/contracts";
import { z } from "zod";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AgentState, AgentUpdate, PendingClarification, TurnSummary } from "./state.js";
import { parseCitationHeader } from "./validators/citationValidator.js";
import { foldAscii } from "./subgraphs/tableResolver.js";
import { TEXT_TO_SQL_ROUTE } from "./constants.js";

export const DeltaFieldSchema = z.enum(["metric", "dimensions", "filters", "timeRange"]);
export const DeltaOpSchema = z.object({
  op: z.enum(["replace", "add", "remove"]),
  field: DeltaFieldSchema,
  value: z.unknown(),
});
export type DeltaOp = z.infer<typeof DeltaOpSchema>;

export interface MultiTurnProposal {
  metric: string | null;
  dimensions: string[];
  filters: IntentFilter[];
  timeRange: string | null;
  requestedMetrics: string[];
  schemaEntities: string[];
  queryMode: AgentState["intent"]["queryMode"];
  isFollowUp: boolean;
  topicChanged: boolean;
  ambiguousReference: boolean;
  clarificationCandidates: string[];
  deltaOps: DeltaOp[];
}

export type MultiTurnResolution =
  | { kind: "intent"; intent: AgentState["intent"]; followUp: boolean; topicChanged: boolean }
  | { kind: "clarification"; intent?: AgentState["intent"]; pendingClarification: PendingClarification | null; answerText: string };

function unique(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = foldAscii(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0
  );
}

function filters(value: unknown): IntentFilter[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.flatMap((candidate) => {
    const parsed = IntentFilterSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function removeSingleFilter(current: IntentFilter[], value: unknown): IntentFilter[] {
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const field = typeof object?.field === "string" ? foldAscii(object.field) : null;
  const target = typeof object?.value === "string" ? foldAscii(object.value)
    : typeof value === "string" ? foldAscii(value) : null;
  if (!field && !target) return current;
  return current.filter((filter) => {
    const sameField = field !== null && foldAscii(filter.field) === field;
    const sameValue = target !== null && foldAscii(String(filter.value)) === target;
    return field && target ? !(sameField && sameValue) : !(sameField || sameValue);
  });
}

function removeFilter(current: IntentFilter[], value: unknown): IntentFilter[] {
  const items = Array.isArray(value) ? value : [value];
  return items.reduce((next, item) => removeSingleFilter(next, item), current);
}

function applyDelta(intent: AgentState["intent"], delta: DeltaOp): void {
  if (delta.field === "metric") {
    if (delta.op === "remove") {
      intent.metric = null;
      intent.requestedMetrics = [];
    } else if (delta.op === "replace" && (typeof delta.value === "string" || delta.value === null)) {
      intent.metric = delta.value;
      intent.requestedMetrics = delta.value ? [delta.value] : [];
    }
    return;
  }
  if (delta.field === "timeRange") {
    if (delta.op === "remove") intent.timeRange = null;
    else if (delta.op === "replace" && (typeof delta.value === "string" || delta.value === null)) {
      intent.timeRange = delta.value;
    }
    return;
  }
  if (delta.field === "dimensions") {
    const values = strings(delta.value);
    if (delta.op === "replace") intent.dimensions = unique(values, 10);
    else if (delta.op === "add") intent.dimensions = unique([...intent.dimensions, ...values], 10);
    else if (delta.op === "remove") {
      const removed = new Set(values.map(foldAscii));
      intent.dimensions = intent.dimensions.filter((item) => !removed.has(foldAscii(item)));
    }
    return;
  }
  if (delta.field === "filters") {
    if (delta.op === "remove") {
      intent.filters = removeFilter(intent.filters, delta.value);
      return;
    }
    const incoming = filters(delta.value);
    if (delta.op === "replace" && Array.isArray(delta.value)) {
      intent.filters = incoming.slice(0, 16);
    } else {
      for (const item of incoming) {
        const key = foldAscii(item.field);
        const at = intent.filters.findIndex((current) => foldAscii(current.field) === key &&
          (delta.op === "replace" || foldAscii(current.operator) === foldAscii(item.operator)));
        if (at < 0) intent.filters.push(item);
        else intent.filters[at] = item;
      }
      intent.filters = intent.filters.slice(0, 16);
    }
  }
}

function toPlainIntent(proposal: MultiTurnProposal): AgentState["intent"] {
  return {
    metric: proposal.metric,
    dimensions: [...proposal.dimensions],
    filters: proposal.filters.map((item) => ({ ...item })),
    timeRange: proposal.timeRange,
    requestedMetrics: [...proposal.requestedMetrics],
    schemaEntities: [...proposal.schemaEntities],
    queryMode: proposal.queryMode,
  };
}

export function resolveMultiTurnIntent(state: AgentState, proposal: MultiTurnProposal): MultiTurnResolution {
  const prior = state.analysisState;
  if (proposal.ambiguousReference) {
    const options = unique([
      ...proposal.clarificationCandidates,
      ...proposal.requestedMetrics,
      ...(prior?.requestedMetrics ?? []),
      ...(prior?.metric ? [prior.metric] : []),
    ], 4);
    const pendingClarification = options.length >= 2 && state.clarificationAttempts < 2
      ? {
          field: "metric" as const,
          question: `Bạn muốn nói đến chỉ số nào: ${options.join(", ")}?`,
          options,
          attempts: state.clarificationAttempts,
        }
      : null;
    const preservedIntent: AgentState["intent"] | undefined = prior && !proposal.topicChanged
      ? {
          metric: null,
          dimensions: [...prior.dimensions],
          filters: prior.filters.map((item) => ({ ...item })),
          timeRange: prior.timeRange,
          requestedMetrics: [],
          schemaEntities: unique([...prior.schemaEntities, ...proposal.schemaEntities], 16),
          queryMode: proposal.queryMode,
        }
      : undefined;
    return {
      kind: "clarification",
      ...(preservedIntent ? { intent: preservedIntent } : {}),
      pendingClarification,
      answerText: pendingClarification?.question ?? "Vui lòng nói rõ chỉ số hoặc phạm vi bạn muốn so sánh.",
    };
  }
  const topicChanged = proposal.topicChanged && prior !== null;
  if (!prior || topicChanged || (!proposal.isFollowUp && proposal.deltaOps.length === 0)) {
    return { kind: "intent", intent: toPlainIntent(proposal), followUp: false, topicChanged };
  }
  const intent: AgentState["intent"] = {
    metric: prior.metric,
    dimensions: [...prior.dimensions],
    filters: prior.filters.map((item) => ({ ...item })),
    timeRange: prior.timeRange,
    requestedMetrics: [...prior.requestedMetrics],
    schemaEntities: unique([...prior.schemaEntities, ...proposal.schemaEntities], 16),
    queryMode: proposal.queryMode,
  };
  for (const delta of proposal.deltaOps) applyDelta(intent, delta);
  return { kind: "intent", intent, followUp: true, topicChanged: false };
}

export function buildGroundedSearchQuery(question: string, intent: AgentState["intent"]): string {
  const parts = [question, intent.metric, ...intent.requestedMetrics, ...intent.dimensions,
    ...intent.schemaEntities, ...intent.filters.flatMap((filter) => [filter.field, String(filter.value ?? "")]),
    intent.timeRange].filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return redactPII(unique(parts, 32).join(" ").slice(0, 1000)).redacted;
}

export function finalizeTurnMemory(state: AgentState, update: AgentUpdate): AgentUpdate {
  const status = update.status ?? state.status;
  const answerText = typeof update.answerText === "string" ? update.answerText : state.answerText;
  const summary: TurnSummary = {
    question: redactPII(state.question).redacted.slice(0, 500),
    summary: redactPII(answerText).redacted.slice(0, 1000),
    status,
    route: state.route,
  };
  const turnHistory = [...(state.turnHistory ?? []), summary].slice(-3);
  let analysisState: AnalysisState | null | undefined;
  if ((status === "ok" || status === "no_data") && state.route === TEXT_TO_SQL_ROUTE &&
      state.intent.queryMode === "standard_query" && state.sql?.trim()) {
    analysisState = AnalysisStateSchema.parse({
      metric: state.intent.metric,
      dimensions: state.intent.dimensions.slice(0, 10),
      filters: state.intent.filters.slice(0, 16),
      timeRange: state.intent.timeRange,
      requestedMetrics: state.intent.requestedMetrics.slice(0, 10),
      schemaEntities: state.intent.schemaEntities.slice(0, 16),
      citations: parseCitationHeader(state.sql).slice(0, 20),
      lastSqlHash: createHash("sha256").update(state.sql).digest("hex"),
    });
  } else if (state.analysisTopicChanged) {
    analysisState = null;
  }
  return { ...update, turnHistory, analysisTopicChanged: false,
    ...(analysisState !== undefined ? { analysisState } : {}) };
}

export async function compactTurnCheckpoint(
  graph: { updateState(config: LangGraphRunnableConfig, values: AgentUpdate, asNode?: string): Promise<unknown> },
  config: LangGraphRunnableConfig,
): Promise<void> {
  await graph.updateState(config, {
    resultPreview: [],
    semanticChunks: [],
    semanticQuery: null,
    semanticRetrieveStatus: "unloaded",
    semanticErrorCode: null,
    clarificationAttempts: 0,
  }, "answer");
}
