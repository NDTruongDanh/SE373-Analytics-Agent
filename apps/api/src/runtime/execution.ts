import type { Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  buildRootGraph,
  createAnswerSynthesizer,
  previewCountTotal,
  type AgentState,
  type RetrieveFn,
  type RootGraphDeps,
  type SpanEvent,
  type SynthesizeFn,
  type VizFn,
} from "@shared/agent";
import { createRetrieveSemantic } from "@shared/agent/uc02";
import { createUc03Viz } from "@shared/agent/uc03";
import {
  createSpanEmitter,
  isRateLimitFailure,
  toModelDbToolError,
  type LangSmithRunConfig,
} from "@shared/agent/telemetry";
import {
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
  startCheckpointLifecycleScheduler,
  type CheckpointLifecycleScheduler,
  type HostPorts,
  type ThreadLockAcquirer,
  type ThreadLockHandle,
} from "../ports.js";
import {
  completionArtifacts,
  completedPayload,
  displayableSql,
  emitSseEvent,
  failedPayload,
  interruptPayload,
  schemaPayload,
  sqlPayload,
  vizPayload,
} from "../sse.js";
import type { BuildAppOptions, StoredRun } from "../types.js";
import { approvalKindFor, extractInterruptInfo } from "./approvals.js";

// Bound detached LangSmith tail flush so a stalled batch cannot hold a response or shutdown open.
export const LANGSMITH_FLUSH_TIMEOUT_MS = 2500;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createInMemoryLockAcquirer(): ThreadLockAcquirer {
  const activeInMemoryLocks = new Set<string>();
  return async (threadId: string): Promise<ThreadLockHandle> => {
    if (activeInMemoryLocks.has(threadId)) {
      return { acquired: false, release: async () => {} };
    }
    activeInMemoryLocks.add(threadId);
    let released = false;
    return {
      acquired: true,
      release: async () => {
        if (!released) {
          released = true;
          activeInMemoryLocks.delete(threadId);
        }
      },
    };
  };
}

export async function readCheckpointId(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<string | undefined> {
  try {
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    const id = (tuple?.config?.configurable as Record<string, unknown> | undefined)?.[
      "checkpoint_id"
    ];
    if (typeof id !== "string" || id.length === 0) return undefined;
    // Include a hash of pendingWrites so sequential interrupts inside a single LangGraph node superstep get distinct tokens.
    const writes = Array.isArray(tuple?.pendingWrites) ? tuple.pendingWrites : [];
    if (writes.length === 0) return id;
    const digest = createHash("sha256")
      .update(JSON.stringify(writes))
      .digest("hex")
      .slice(0, 12);
    return `${id}:${digest}`;
  } catch {
    return undefined;
  }
}

export function configurableForRun(
  run: StoredRun,
  runId: string,
): Record<string, unknown> {
  return {
    thread_id: run.threadId,
    threadId: run.threadId,
    runId,
    userId: run.userId,
    roleScope: run.roleScope,
    rowScope: run.rowScope ?? null,
    token: run.token,
    mcpUrl: run.mcpUrl,
    tracesDir: run.tracesDir,
  };
}

// Mint a fresh RunnableConfig runId per resume for LangSmith, while keeping configurable.runId as the JSONL runId.
// Checkpointing keys on thread_id, so the fresh root runId will not fork the thread.
export function buildResumeInvokeOptions(args: {
  langsmith: LangSmithRunConfig | undefined;
  run: StoredRun;
  runId: string;
}): {
  runId: string;
  callbacks: LangSmithRunConfig["callbacks"] | undefined;
  tags: string[] | undefined;
  metadata: Record<string, unknown> | undefined;
  configurable: Record<string, unknown>;
} {
  return {
    runId: randomUUID(),
    callbacks: args.langsmith?.callbacks,
    tags: args.langsmith?.tags,
    metadata: args.langsmith?.metadata,
    configurable: configurableForRun(args.run, args.runId),
  };
}

export function buildRunGraph(
  options: BuildAppOptions,
  run: StoredRun,
  runId: string,
  res: Response,
) {
  const emit = createSpanEmitter({
    runId,
    threadId: run.threadId,
    userId: run.userId,
    role: run.roleScope,
    tracesDir: run.tracesDir,
  });
  const sent = new Set<string>();
  let proposedSql: string | null = null;
  function progress(event: SpanEvent): string {
    const spanId = emit(event);
    const payload = isRecord(event.payload) ? event.payload : {};
    const envelope = { runId, threadId: run.threadId };
    // Emit only allowlisted progress metadata; never expose model text, SQL literals, cells, or credentials.
    if (event.node === "understand" && event.type === "node_done" && typeof payload["sql"] === "string" && !sent.has("sql_generated")) {
      const sql = payload["sql"];
      proposedSql = sql;
      emitSseEvent(res, "sql_generated", { ...envelope, node: "understand", data: sqlPayload(sql, []) });
      sent.add("sql_generated");
    }
    if (event.node === "describe" && event.type === "tool_call" && payload["tool"] === "list_tables" && !sent.has("schema_retrieved")) {
      const tables = Array.isArray(payload["tables"]) ? payload["tables"].filter(
        (table): table is string => typeof table === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(table),
      ) : [];
      emitSseEvent(res, "schema_retrieved", { ...envelope, node: "describe", data: schemaPayload(tables) });
      emitSseEvent(res, "query_running", { ...envelope, node: "run", data: { phase: "starting" } });
      sent.add("schema_retrieved");
    }
    if (event.node === "run" && event.type === "tool_call" && payload["tool"] === "run_query" && payload["ok"] === true && proposedSql && !sent.has("sql_display")) {
      const sql = displayableSql(proposedSql);
      emitSseEvent(res, "sql_generated", { ...envelope, node: "run", data: { phase: "display", ...(sql ? { sql } : { withheld: true }) } });
      sent.add("sql_display");
    }
    return spanId;
  }
  return {
    graph: buildRootGraph({
      checkpointer: options.checkpointer,
      emitSpan: progress,
      ...(options.routes ? { routes: options.routes } : {}),
      ...(options.textToSql ? { textToSql: options.textToSql } : {}),
      retrieve: options.retrieve ?? createRetrieveSemantic(),
      viz: options.viz ?? createUc03Viz(),
      synthesize: options.synthesize ?? createAnswerSynthesizer(),
    }),
    emit,
  };
}

export function streamCompletion(
  res: Response,
  runId: string,
  threadId: string,
  out: AgentState,
): void {
  const preview = (out.resultPreview ?? []) as Record<string, unknown>[];
  const viz = vizPayload(out);
  if (viz) {
    emitSseEvent(res, "viz", { runId, threadId, node: "viz", data: viz });
  }
  const artifacts = completionArtifacts(out);
  emitSseEvent(res, "completed", {
    runId,
    threadId,
    node: "answer",
    data: completedPayload({
      status: out.status,
      answerText: out.answerText,
      toolsCalled: [...(out.toolsCalled ?? [])],
      total: previewCountTotal((out.columns ?? []) as string[], preview),
      ...(artifacts ?? {}),
    }),
  });
}

export async function emitInterruptWaiting(args: {
  checkpointer: BaseCheckpointSaver;
  res: Response;
  emit: ReturnType<typeof createSpanEmitter>;
  runId: string;
  threadId: string;
  interrupts: unknown[];
  out: AgentState;
}): Promise<void> {
  const info = extractInterruptInfo(args.interrupts, args.out);
  const checkpointId = await readCheckpointId(args.checkpointer, args.threadId);
  args.emit({
    node: "answer",
    type: "approval_requested",
    durationMs: 0,
    attempt: 0,
    payload: {
      kind: approvalKindFor(args.out, info.pendingClarification),
      ...(checkpointId ? { checkpointId } : {}),
      ...(info.asOf ? { asOf: info.asOf } : {}),
      ...(info.reason ? { reason: info.reason } : {}),
      ...(info.pendingClarification
        ? { pendingClarification: info.pendingClarification }
        : {}),
    },
  });
  emitSseEvent(args.res, "interrupt_waiting", {
    runId: args.runId,
    threadId: args.threadId,
    ...(checkpointId ? { checkpointId } : {}),
    node: "answer",
    data: interruptPayload({
      action: info.action,
      reason: info.reason,
      ...(checkpointId ? { checkpointId } : {}),
      ...(info.asOf ? { asOf: info.asOf } : {}),
      pendingClarification: info.pendingClarification,
      plan: info.plan,
      currentPlan: info.currentPlan,
    }),
  });
}

export function toFailedSseData(error: unknown, fallbackMessage: string) {
  if (isRateLimitFailure(error)) {
    const rateErr = toModelDbToolError(error, fallbackMessage);
    return failedPayload({
      code: rateErr.code,
      message: rateErr.message,
      retryable: rateErr.retryable,
      repairable: rateErr.repairable,
    });
  }
  return failedPayload({
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: true,
    repairable: false,
  });
}

export function startApiCheckpointLifecycle(options: {
  ports: Pick<HostPorts, "checkpointer" | "lockPool" | "acquireThreadLock">;
  intervalMs?: number;
  maxAgeDays?: number;
  retentionDays?: number;
  routes?: RootGraphDeps["routes"];
  retrieve?: RetrieveFn;
  viz?: VizFn;
  synthesize?: SynthesizeFn;
  onError?: (error: unknown) => void;
}): CheckpointLifecycleScheduler {
  const lifecycleGraph = buildRootGraph({
    checkpointer: options.ports.checkpointer,
    emitSpan: () => "",
    ...(options.routes ? { routes: options.routes } : {}),
    retrieve: options.retrieve ?? createRetrieveSemantic(),
    viz: options.viz ?? createUc03Viz(),
    synthesize: options.synthesize ?? createAnswerSynthesizer(),
  });
  return startCheckpointLifecycleScheduler({
    pool: options.ports.lockPool,
    graph: lifecycleGraph,
    acquireThreadLock: options.ports.acquireThreadLock,
    intervalMs:
      options.intervalMs ?? DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
    ...(options.maxAgeDays !== undefined
      ? { maxAgeDays: options.maxAgeDays }
      : {}),
    ...(options.retentionDays !== undefined
      ? { retentionDays: options.retentionDays }
      : {}),
    onError:
      options.onError ??
      ((err) => {
        console.error(
          "[api] checkpoint lifecycle sweep failed:",
          err instanceof Error ? err.message : String(err),
        );
      }),
  });
}
