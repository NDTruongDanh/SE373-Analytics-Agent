// Pure trace-tree builder for G4 (03-04): nests redacted JSONL events by
// parentSpanId, joins MCP audit lines by runId, and derives the run_done
// summary table. No I/O, no network, no redaction of its own — inputs are
// already-redacted file contents parsed by the caller (scripts/trace-show).
// Counts and column names only; cell values never flow through here.

export interface TreeInputEvent {
  spanId?: string;
  parentSpanId?: string;
  node: string;
  type: string;
  ts?: string;
  durationMs?: number;
  attempt?: number;
  payload?: unknown;
}

export interface TreeNode {
  spanId: string;
  parentSpanId?: string;
  node: string;
  type: string;
  ts?: string;
  durationMs: number;
  attempt?: number;
  payload?: unknown;
  children: TreeNode[];
}

export interface TreeAuditLine {
  tool: string;
  decision: string;
  rowCount?: number;
  durationMs?: number;
  maskedColumns: string[];
  rowScopeApplied: { table: string; column: string }[];
  errorCode?: string;
}

export interface TraceApprovals {
  requested: number;
  decided: number;
}

export interface TraceSummary {
  status: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  sqlAttempts: number;
  sqlFailures: number;
  maskedColumns: string[];
  approvals: TraceApprovals;
}

export interface TraceTree {
  runId: string;
  eventCount: number;
  roots: TreeNode[];
  audits: TreeAuditLine[];
  summary: TraceSummary | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asScopeArray(value: unknown): { table: string; column: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { table: string; column: string }[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (typeof record["table"] === "string" && typeof record["column"] === "string") {
      out.push({ table: record["table"], column: record["column"] });
    }
  }
  return out;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Nest flat events into a forest by parentSpanId (orphans become roots). */
export function nestEvents(events: TreeInputEvent[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const order: TreeNode[] = [];
  events.forEach((event, index) => {
    const spanId =
      typeof event.spanId === "string" && event.spanId.length > 0
        ? event.spanId
        : `synthetic-${index}`;
    const node: TreeNode = {
      spanId,
      ...(event.parentSpanId !== undefined ? { parentSpanId: event.parentSpanId } : {}),
      node: event.node,
      type: event.type,
      ...(event.ts !== undefined ? { ts: event.ts } : {}),
      durationMs: asFiniteNumber(event.durationMs) ?? 0,
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
      children: [],
    };
    // First write wins: duplicate spanIds (should not happen from the
    // writer, which mints UUIDs) keep the earliest event.
    if (!nodes.has(spanId)) {
      nodes.set(spanId, node);
      order.push(node);
    }
  });
  const roots: TreeNode[] = [];
  for (const node of order) {
    const parent =
      node.parentSpanId !== undefined ? nodes.get(node.parentSpanId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortTree = (list: TreeNode[]): void => {
    list.sort((a, b) => {
      if ((a.attempt ?? 0) !== (b.attempt ?? 0)) {
        return (a.attempt ?? 0) - (b.attempt ?? 0);
      }
      const tsA = a.ts ?? "";
      const tsB = b.ts ?? "";
      return tsA < tsB ? -1 : tsA > tsB ? 1 : 0;
    });
    for (const node of list) sortTree(node.children);
  };
  // Keep insertion order at the top level (chronological file order), sort
  // only nested children by attempt then timestamp.
  for (const root of roots) sortTree(root.children);
  return roots;
}

/** Keep only audit lines for this run, projected to the viewer shape. */
export function joinAudits(
  runId: string,
  auditLines: unknown[],
): TreeAuditLine[] {
  const out: TreeAuditLine[] = [];
  for (const line of auditLines) {
    const record = asRecord(line);
    if (record["runId"] !== runId) continue;
    const tool = record["tool"];
    const decision = record["decision"];
    if (typeof tool !== "string" || typeof decision !== "string") continue;
    const rowCount = asFiniteNumber(record["rowCount"]);
    const durationMs = asFiniteNumber(record["durationMs"]);
    const errorCode = record["errorCode"];
    out.push({
      tool,
      decision,
      ...(rowCount !== null ? { rowCount } : {}),
      ...(durationMs !== null ? { durationMs } : {}),
      maskedColumns: asStringArray(record["maskedColumns"]),
      rowScopeApplied: asScopeArray(record["rowScopeApplied"]),
      ...(typeof errorCode === "string" ? { errorCode } : {}),
    });
  }
  return out;
}

/**
 * Derive the summary table from the terminal run_done event. Totals come
 * from the run_done payload (the accumulator's reconciled roll-up); the
 * masked-column union and approval counts are re-tallied from the event
 * list so the viewer stays correct even if the payload predates them.
 */
export function deriveSummary(events: TreeInputEvent[]): TraceSummary | null {
  const runDone = [...events].reverse().find((event) => event.type === "run_done");
  if (!runDone) return null;
  const payload = asRecord(runDone.payload);
  const masked = new Set<string>();
  let requested = 0;
  let decided = 0;
  for (const event of events) {
    if (event.type === "approval_requested") requested += 1;
    if (event.type === "approval_decided") decided += 1;
    for (const column of asStringArray(asRecord(event.payload)["maskedColumns"])) {
      masked.add(column);
    }
  }
  for (const column of asStringArray(payload["maskedColumns"])) {
    masked.add(column);
  }
  const num = (key: string): number => asFiniteNumber(payload[key]) ?? 0;
  const status = payload["status"];
  return {
    status: typeof status === "string" ? status : "unknown",
    llmCalls: num("llmCalls"),
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    estimatedCostUsd: num("estimatedCostUsd"),
    toolCalls: num("toolCalls"),
    sqlAttempts: num("sqlAttempts"),
    sqlFailures: num("sqlFailures"),
    maskedColumns: [...masked].sort(),
    approvals: { requested, decided },
  };
}

/** Build the full viewer model: tree + joined audits + summary. */
export function buildTraceTree(
  runId: string,
  events: TreeInputEvent[],
  auditLines: unknown[],
): TraceTree {
  return {
    runId,
    eventCount: events.length,
    roots: nestEvents(events),
    audits: joinAudits(runId, auditLines),
    summary: deriveSummary(events),
  };
}
