import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { Command, Overwrite, type BaseCheckpointSaver } from "@langchain/langgraph";
import {
  BUDGET_DEFAULTS,
  buildRootGraph,
  createAnswerSynthesizer,
  previewCountTotal,
  RCA_ROUTE,
  routeQuestion,
  TEXT_TO_SQL_ROUTE,
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
  buildLangSmithRunConfig,
  createLangSmithTracer,
  createSpanEmitter,
  flushLangSmith,
  isRateLimitFailure,
  toModelDbToolError,
  type LangSmithRunConfig,
} from "@shared/agent/telemetry";
import { dbToolError, type DbToolError } from "@shared/contracts";
import {
  createHostPorts,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
  startCheckpointLifecycleScheduler,
  type CheckpointLifecycleScheduler,
  type HostPorts,
  type ThreadLockAcquirer,
  type ThreadLockHandle,
} from "./ports.js";
import {
  assertTokensPresent,
  InvalidThreadError,
  loadRegistryFromFile,
  mintRunContext,
  resolvePersona,
  UnknownPersonaError,
  type ClientRegistry,
  type Principal,
} from "./principals.js";
import {
  completedPayload,
  displayableSql,
  emitSseEvent,
  failedPayload,
  interruptPayload,
  schemaPayload,
  sqlPayload,
} from "./sse.js";
import type { AppStateStore } from "./store/alertStore.js";
import { API_SHELL } from "./constants.js";

export { API_SHELL };

export type ApiShellError = DbToolError;

export interface ReindexResult {
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
}

export interface BuildAppOptions {
  checkpointer: BaseCheckpointSaver;
  mcpUrl: string;
  tracesDir?: string;
  registry?: ClientRegistry;
  env?: NodeJS.ProcessEnv;
  // Held for UC-10 write-after-send; ask and resume never call it directly.
  store?: AppStateStore;
  acquireThreadLock?: ThreadLockAcquirer;
  allowInMemoryLockForTests?: boolean;
  routes?: RootGraphDeps["routes"];
  textToSql?: RootGraphDeps["textToSql"];
  retrieve?: RetrieveFn;
  viz?: VizFn;
  synthesize?: SynthesizeFn;
  reindex?: (ctx: { token: string; mcpUrl: string }) => Promise<ReindexResult>;
}

export async function defaultReindex(ctx: {
  token: string;
  mcpUrl: string;
}): Promise<ReindexResult> {
  const url = new URL("/reindex", ctx.mcpUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.token}`,
    },
  });
  if (!res.ok) {
    let message = `semantic re-index failed with status ${res.status}`;
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {
    }
    throw new Error(message);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    added: Number(body["added"] ?? 0),
    updated: Number(body["updated"] ?? 0),
    skipped: Number(body["skipped"] ?? 0),
    deleted: Number(body["deleted"] ?? 0),
  };
}

export interface StoredRun {
  threadId: string;
  userId: string;
  roleScope: string;
  token: string;
  mcpUrl: string;
  tracesDir: string;
}

function interruptedOf(output: unknown): unknown[] | undefined {
  return (output as { __interrupt__?: unknown[] }).__interrupt__;
}

function pendingClarificationOf(output: unknown): AgentState["pendingClarification"] {
  const direct = (output as Partial<AgentState>).pendingClarification;
  if (direct) return direct;
  for (const item of interruptedOf(output) ?? []) {
    const value = (item as { value?: unknown }).value ?? item;
    const pending = (value as { pendingClarification?: unknown }).pendingClarification;
    if (
      pending !== null &&
      typeof pending === "object" &&
      Array.isArray((pending as { options?: unknown }).options)
    ) {
      return pending as AgentState["pendingClarification"];
    }
  }
  return null;
}

// Allowlisted protocol verdict tokens safe to record verbatim; never user content.
const APPROVAL_VERDICTS = new Set([
  "approve",
  "approved",
  "yes",
  "confirm",
  "accept",
  "proceed",
  "reject",
  "rejected",
  "no",
  "deny",
  "cancel",
]);

function approvalKindFor(
  out: AgentState,
  pendingClarification: AgentState["pendingClarification"] = out.pendingClarification,
): string {
  return pendingClarification ? "clarification" : "approval";
}

// Record allowlisted protocol tokens verbatim and redact everything else to "provided" + length;
// avoid hashing short inputs because unsalted SHA-256 is brute-forceable.
function approvalDecision(value: unknown): {
  decision: string;
  valueLength: number;
} {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const lowered = typeof value === "string" ? value.toLowerCase() : "";
  return {
    decision: APPROVAL_VERDICTS.has(lowered) ? lowered : "provided",
    valueLength: text.length,
  };
}

// Scan the run trace for the latest approval_requested since header-only rehydration skips later events.
function readLastApprovalRequest(
  tracesDir: string,
  runId: string,
): { kind: string; tsMs: number } | null {
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(`${tracesDir}/${runId}.jsonl`, "utf8");
  } catch {
    return null;
  }
  let last: { kind: string; tsMs: number } | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "approval_requested"
    ) {
      const record = parsed as { ts?: unknown; payload?: unknown };
      const ts = typeof record.ts === "string" ? Date.parse(record.ts) : NaN;
      if (!Number.isFinite(ts)) continue;
      const kind = (record.payload as { kind?: unknown } | null | undefined)
        ?.kind;
      last = {
        kind: typeof kind === "string" && kind.length > 0 ? kind : "approval",
        tsMs: ts,
      };
    }
  }
  return last;
}

function toFailedSseData(error: unknown, fallbackMessage: string) {
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

export const API_CSP_HEADER =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'";

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-security-policy": API_CSP_HEADER,
};

// Bound detached LangSmith tail flush so a stalled batch cannot hold a response or shutdown open.
const LANGSMITH_FLUSH_TIMEOUT_MS = 2500;

export function buildApp(options: BuildAppOptions): express.Express {
  const tracesDir = options.tracesDir ?? "traces";
  const env = options.env ?? process.env;
  const registry = options.registry ?? loadRegistryFromFile();
  assertTokensPresent(registry, env);

  // Keyed by runId and write-once so concurrent asks cannot cross-contaminate run identity.
  const runs = new Map<string, StoredRun>();
  if (!options.acquireThreadLock && options.allowInMemoryLockForTests !== true) {
    throw new Error(
      "buildApp: acquireThreadLock is required in production; pass a PostgreSQL advisory lock acquirer or set allowInMemoryLockForTests: true for DB-free tests.",
    );
  }
  const activeInMemoryLocks = new Set<string>();
  const acquireThreadLock: ThreadLockAcquirer =
    options.acquireThreadLock ??
    (async (threadId: string): Promise<ThreadLockHandle> => {
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
    });

  async function readCheckpointId(threadId: string): Promise<string | undefined> {
    try {
      const tuple = await options.checkpointer.getTuple({
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

  const app = express();
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("content-security-policy", API_CSP_HEADER);
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  function buildGraph(run: StoredRun, runId: string, res: Response) {
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

  function configurableFor(run: StoredRun, runId: string): Record<string, unknown> {
    return configurableForRun(run, runId);
  }

  function streamCompletion(
    res: Response,
    runId: string,
    threadId: string,
    out: AgentState,
  ): void {
    const preview = (out.resultPreview ?? []) as Record<string, unknown>[];
    emitSseEvent(res, "completed", {
      runId,
      threadId,
      node: "answer",
      data: completedPayload({
        status: out.status,
        answerText: out.answerText,
        toolsCalled: [...(out.toolsCalled ?? [])],
        total: previewCountTotal((out.columns ?? []) as string[], preview),
      }),
    });
  }

  app.post("/api/ask", async (req: Request, res: Response) => {
    const question = req.body?.["question"];
    if (typeof question !== "string" || question.trim().length === 0) {
      res
        .status(400)
        .json(dbToolError("INVALID_PARAMS", "question must be a non-empty string"));
      return;
    }
    const persona = req.body?.["persona"];
    let principal: Principal;
    let token: string;
    try {
      if (typeof persona !== "string") {
        throw new UnknownPersonaError(String(persona));
      }
      ({ principal, token } = resolvePersona(persona, registry, env));
    } catch (error) {
      if (error instanceof UnknownPersonaError) {
        res
          .status(error.status)
          .json(dbToolError("INVALID_PARAMS", error.message));
        return;
      }
      res
        .status(500)
        .json(dbToolError("INTERNAL_ERROR", "persona resolution failed at boot-checked config"));
      return;
    }

    let runId: string;
    let threadId: string;
    try {
      const ctx = mintRunContext(
        principal.userId,
        typeof req.body?.["threadId"] === "string" ? req.body["threadId"] : undefined,
      );
      runId = ctx.runId;
      threadId = ctx.threadId;
    } catch (error) {
      if (error instanceof InvalidThreadError) {
        res
          .status(error.status)
          .json(dbToolError("INVALID_PARAMS", error.message));
        return;
      }
      res.status(500).json(dbToolError("INTERNAL_ERROR", "run context minting failed"));
      return;
    }

    const lock = await acquireThreadLock(threadId);
    if (!lock.acquired) {
      res.status(409).json({
        code: "CONFLICT",
        message: `thread '${threadId}' is already locked by an active operation`,
      });
      return;
    }

    const run: StoredRun = {
      threadId,
      userId: principal.userId,
      roleScope: principal.role,
      token,
      mcpUrl: options.mcpUrl,
      tracesDir,
    };
    if (!runs.has(runId)) runs.set(runId, run);

    res.writeHead(200, { ...SSE_HEADERS, "x-run-id": runId });
    emitSseEvent(res, "intent_parsed", { runId, threadId, node: "understand", data: { phase: "starting" } });

    let emit: ReturnType<typeof createSpanEmitter> | undefined;
    try {
      const built = buildGraph(run, runId, res);
      emit = built.emit;
      const graph = built.graph;
      // Reuse runId as LangSmith runId for 1:1 JSONL correlation; custom tracer suppresses env auto-tracing.
      const tracer = createLangSmithTracer(env);
      const ls = tracer
        ? buildLangSmithRunConfig(tracer, {
            runId,
            threadId,
            userId: principal.userId,
            role: principal.role,
            route: routeQuestion(question),
            maskedColumns: [],
          })
        : undefined;
      const out = (await graph.invoke(
        {
          question, runId, threadId,
          // A new question reuses the thread, but not the previous run's outputs or budgets.
          status: "no_data", errorCode: null, answerText: "", sql: null, tablesUsed: [],
          semanticChunks: [], catalogTables: [], catalogStatus: "unloaded",
          semanticQuery: null, semanticRetrieveStatus: "unloaded", semanticErrorCode: null,
          resultPreview: [], columns: [], toolsCalled: [],
          vizSpec: null, pendingClarification: null, analysisPlan: null, rootCauseAnswer: null,
          budget: new Overwrite({ llmCalls: 0, tokensUsed: 0, maxLlmCalls: BUDGET_DEFAULTS.maxLlmCalls, maxTokens: BUDGET_DEFAULTS.maxTokens, deadlineMs: 0 }),
          telemetry: new Overwrite({ promptTokens: 0, completionTokens: 0, latencyMs: 0 }),
        },
        {
          runId,
          callbacks: ls?.callbacks,
          tags: ls?.tags,
          metadata: ls?.metadata,
          configurable: configurableFor(run, runId),
        },
      )) as AgentState;
      const interrupts = interruptedOf(out);
      if (interrupts?.length) {
        const pendingClarification = pendingClarificationOf(out);
        const rawInterrupt = interrupts[0] as { value?: unknown } | unknown;
        const interruptValue =
          rawInterrupt && typeof rawInterrupt === "object" && "value" in rawInterrupt
            ? (rawInterrupt as { value: unknown }).value
            : rawInterrupt;
        const interruptData =
          interruptValue && typeof interruptValue === "object"
            ? (interruptValue as Record<string, unknown>)
            : {};
        const checkpointId = await readCheckpointId(threadId);
        const asOf =
          typeof interruptData["asOf"] === "string"
            ? interruptData["asOf"]
            : out.analysisPlan?.asOf;
        const interruptReason =
          typeof interruptData["reason"] === "string"
            ? interruptData["reason"]
            : undefined;
        emit?.({
          node: "answer",
          type: "approval_requested",
          durationMs: 0,
          attempt: 0,
          payload: {
            kind: approvalKindFor(out, pendingClarification),
            ...(checkpointId ? { checkpointId } : {}),
            ...(asOf ? { asOf } : {}),
            ...(interruptReason ? { reason: interruptReason } : {}),
            ...(pendingClarification
              ? { pendingClarification }
              : {}),
          },
        });
        emitSseEvent(res, "interrupt_waiting", {
          runId,
          threadId,
          ...(checkpointId ? { checkpointId } : {}),
          node: "answer",
          data: interruptPayload({
            action: typeof interruptData["action"] === "string" ? interruptData["action"] : undefined,
            reason: interruptReason,
            ...(checkpointId ? { checkpointId } : {}),
            ...(asOf ? { asOf } : {}),
            pendingClarification,
            plan: interruptData["plan"],
            currentPlan: interruptData["currentPlan"],
          }),
        });
        return;
      }
      streamCompletion(res, runId, threadId, out);
      emit.emitRunDone(out.status);
    } catch (error) {
      emit?.emitRunDone("error");
      emitSseEvent(res, "failed", {
        runId,
        threadId,
        node: "answer",
        data: toFailedSseData(error, "unknown ask failure"),
      });
    } finally {
      await lock.release();
      res.end();
      void flushLangSmith({ timeoutMs: LANGSMITH_FLUSH_TIMEOUT_MS });
    }
  });

  app.post("/api/semantic/reindex", async (req: Request, res: Response) => {
    const persona = req.body?.["persona"] ?? req.headers["x-persona"];
    let principal: Principal;
    let token: string;
    try {
      if (typeof persona !== "string") {
        throw new UnknownPersonaError(String(persona));
      }
      ({ principal, token } = resolvePersona(persona, registry, env));
    } catch (error) {
      if (error instanceof UnknownPersonaError) {
        res.status(error.status).json(dbToolError("INVALID_PARAMS", error.message));
        return;
      }
      res
        .status(500)
        .json(dbToolError("INTERNAL_ERROR", "persona resolution failed at boot-checked config"));
      return;
    }
    if (persona !== "data_admin" || principal.role !== "admin") {
      res
        .status(403)
        .json(dbToolError("SCOPE_DENIED", "only data_admin may trigger semantic re-indexing"));
      return;
    }
    try {
      const reindex = options.reindex ?? defaultReindex;
      const counts = await reindex({ token, mcpUrl: options.mcpUrl });
      res.status(200).json(counts);
    } catch (error) {
      res
        .status(500)
        .json(
          dbToolError(
            "INTERNAL_ERROR",
            error instanceof Error ? error.message : "semantic re-index failed",
          ),
        );
    }
  });

  app.post("/api/runs/:runId/resume", async (req: Request, res: Response) => {
    const runId = req.params["runId"];
    if (typeof runId !== "string" || runId.length === 0) {
      res.status(404).json(dbToolError("INVALID_PARAMS", "unknown runId ''"));
      return;
    }
    if (
      !isRecord(req.body) ||
      !("value" in req.body) ||
      req.body["value"] === undefined ||
      req.body["value"] === null
    ) {
      res.status(400).json(dbToolError("INVALID_PARAMS", "resume body must carry a value"));
      return;
    }
    const checkpointId = req.body["checkpointId"];
    if (typeof checkpointId !== "string" || checkpointId.length === 0) {
      res.status(400).json(dbToolError("INVALID_PARAMS", "resume body must carry a non-empty checkpointId"));
      return;
    }
    const stored = runs.get(runId) ?? rehydrateRun(runId, registry, env, options.mcpUrl, tracesDir);
    if (!stored) {
      res.status(404).json(dbToolError("INVALID_PARAMS", `unknown runId '${runId}'`));
      return;
    }
    if (!runs.has(runId)) runs.set(runId, stored);

    const lock = await acquireThreadLock(stored.threadId);
    if (!lock.acquired) {
      res.status(409).json({
        code: "CONFLICT",
        message: `thread '${stored.threadId}' is already locked by an active operation`,
      });
      return;
    }

    let emit: ReturnType<typeof createSpanEmitter> | undefined;
    try {
      const built = buildGraph(stored, runId, res);
      emit = built.emit;
      const graph = built.graph;
      const saved = await graph.getState({ configurable: configurableFor(stored, runId) });
      const hasActiveInterrupt =
        Array.isArray(saved.tasks) &&
        saved.tasks.some(
          (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0,
        );
      if (!hasActiveInterrupt) {
        res.status(409).json({
          code: "CONFLICT",
          message: "thread has no active interrupt to resume",
        });
        return;
      }
      const activeCheckpointId = await readCheckpointId(stored.threadId);
      if (activeCheckpointId !== checkpointId) {
        res.status(409).json({
          code: "CONFLICT",
          message: "stale checkpointId: checkpoint does not match active interrupt",
        });
        return;
      }

      res.writeHead(200, { ...SSE_HEADERS, "x-run-id": runId });
      emitSseEvent(res, "intent_parsed", { runId, threadId: stored.threadId, node: "understand", data: { phase: "resuming" } });

      const savedRoute = (saved.values as Partial<AgentState> | undefined)?.route;
      const tracer = createLangSmithTracer(env);
      const ls = tracer
        ? buildLangSmithRunConfig(tracer, {
            runId,
            threadId: stored.threadId,
            userId: stored.userId,
            role: stored.roleScope,
            route: savedRoute === RCA_ROUTE ? RCA_ROUTE : TEXT_TO_SQL_ROUTE,
            maskedColumns: [],
          })
        : undefined;
      const lastApproval = readLastApprovalRequest(stored.tracesDir, runId);
      const verdict = approvalDecision(req.body["value"]);
      emit({
        node: "answer",
        type: "approval_decided",
        durationMs: 0,
        attempt: 0,
        payload: {
          kind: lastApproval?.kind ?? "approval",
          checkpointId,
          decision: verdict.decision,
          reviewer: stored.userId,
          waitedMs: lastApproval
            ? Math.max(0, Date.now() - lastApproval.tsMs)
            : 0,
          valueLength: verdict.valueLength,
        },
      });
      const out = (await graph.invoke(new Command({ resume: req.body["value"] }), {
        ...buildResumeInvokeOptions({ langsmith: ls, run: stored, runId }),
      })) as AgentState;
      const resumeInterrupts = interruptedOf(out);
      if (resumeInterrupts?.length) {
        const pendingClarification = pendingClarificationOf(out);
        const rawInterrupt = resumeInterrupts[0] as { value?: unknown } | unknown;
        const interruptValue =
          rawInterrupt && typeof rawInterrupt === "object" && "value" in rawInterrupt
            ? (rawInterrupt as { value: unknown }).value
            : rawInterrupt;
        const interruptData =
          interruptValue && typeof interruptValue === "object"
            ? (interruptValue as Record<string, unknown>)
            : {};
        const nextCheckpointId = await readCheckpointId(stored.threadId);
        const asOf =
          typeof interruptData["asOf"] === "string"
            ? interruptData["asOf"]
            : out.analysisPlan?.asOf;
        const interruptReason =
          typeof interruptData["reason"] === "string"
            ? interruptData["reason"]
            : undefined;
        emit({
          node: "answer",
          type: "approval_requested",
          durationMs: 0,
          attempt: 0,
          payload: {
            kind: approvalKindFor(out, pendingClarification),
            ...(nextCheckpointId ? { checkpointId: nextCheckpointId } : {}),
            ...(asOf ? { asOf } : {}),
            ...(interruptReason ? { reason: interruptReason } : {}),
            ...(pendingClarification
              ? { pendingClarification }
              : {}),
          },
        });
        emitSseEvent(res, "interrupt_waiting", {
          runId,
          threadId: stored.threadId,
          ...(nextCheckpointId ? { checkpointId: nextCheckpointId } : {}),
          node: "answer",
          data: interruptPayload({
            action: typeof interruptData["action"] === "string" ? interruptData["action"] : undefined,
            reason: interruptReason,
            ...(nextCheckpointId ? { checkpointId: nextCheckpointId } : {}),
            ...(asOf ? { asOf } : {}),
            pendingClarification,
            plan: interruptData["plan"],
            currentPlan: interruptData["currentPlan"],
          }),
        });
        return;
      }
      streamCompletion(res, runId, stored.threadId, out);
      emit.emitRunDone(out.status);
    } catch (error) {
      emit?.emitRunDone("error");
      if (!res.headersSent) {
        res.status(500).json(dbToolError("INTERNAL_ERROR", error instanceof Error ? error.message : "unknown resume failure"));
      } else {
        emitSseEvent(res, "failed", {
          runId,
          threadId: stored.threadId,
          node: "answer",
          data: toFailedSseData(error, "unknown resume failure"),
        });
      }
    } finally {
      await lock.release();
      if (res.headersSent) {
        res.end();
      }
      void flushLangSmith({ timeoutMs: LANGSMITH_FLUSH_TIMEOUT_MS });
    }
  });

  return app;
}

// Parse only the trace header line with strict validation so malformed lines fail closed to 404 and cannot inject identity.
export function rehydrateRun(
  runId: string,
  registry: ClientRegistry,
  env: NodeJS.ProcessEnv,
  mcpUrl: string,
  tracesDir: string,
): StoredRun | null {
  try {
    const header = readTraceHeader(tracesDir, runId);
    if (!header || header.runId !== runId) return null;
    if (
      typeof header.threadId !== "string" ||
      header.threadId.length === 0 ||
      header.threadId.length >= 255 ||
      /\s/.test(header.threadId)
    ) {
      return null;
    }
    if (typeof header.userId !== "string" || header.userId.length === 0) return null;
    const client = registry.clients.find(
      (c) => c.role === header.role || c.clientId === header.role,
    );
    if (!client) return null;
    const token = env[client.tokenEnv];
    if (typeof token !== "string" || token.length === 0) return null;
    return {
      threadId: header.threadId,
      userId: header.userId,
      roleScope: client.role,
      token,
      mcpUrl,
      tracesDir,
    };
  } catch {
    return null;
  }
}

function readTraceHeader(
  tracesDir: string,
  runId: string,
): { runId?: unknown; threadId?: unknown; userId?: unknown; role?: unknown } | null {
  try {
    const first = readFirstLine(tracesDir, runId);
    if (!first) return null;
    const parsed: unknown = JSON.parse(first);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readFirstLine(tracesDir: string, runId: string): string | null {
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) return null;
  let fd = -1;
  try {
    fd = openSync(`${tracesDir}/${runId}.jsonl`, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
      if (buf.subarray(0, n).includes(0x0a)) break;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const line = text.split("\n")[0] ?? "";
    return line.length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
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

if (
  process.argv[1] !== undefined &&
  (await import("node:path")).resolve(process.argv[1]) ===
    (await import("node:url")).fileURLToPath(import.meta.url)
) {
  const apiPort = Number(process.env.API_PORT ?? 3001);
  const mcpPort = Number(process.env.MCP_PORT ?? 8081);
  const tracesDir = process.env.TRACES_DIR ?? "traces";
  const mcpUrl =
    process.env.MCP_URL ?? `http://127.0.0.1:${mcpPort}/mcp`;
  const rawInterval = Number(process.env.CHECKPOINT_CLEANUP_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS;
  const ports: HostPorts = await createHostPorts();
  const registry = loadRegistryFromFile();
  assertTokensPresent(registry);
  const app = buildApp({
    checkpointer: ports.checkpointer,
    store: ports.store,
    acquireThreadLock: ports.acquireThreadLock,
    mcpUrl,
    tracesDir,
    registry,
  });
  const server = app.listen(apiPort, () => {
    console.log(`[api] listening on 127.0.0.1:${apiPort}`);
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const checkpointScheduler = startApiCheckpointLifecycle({
    ports,
    intervalMs,
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      checkpointScheduler.stop();
      void Promise.allSettled([
        ports.lockPool.end(),
        flushLangSmith({ timeoutMs: LANGSMITH_FLUSH_TIMEOUT_MS }),
      ]).finally(() => process.exit(0));
    });
  }
}
