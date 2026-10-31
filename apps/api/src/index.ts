// Full API host (API-01/API-02/API-03, 01-14, wave 6).
//
// buildApp wires the 01-10 root graph, the 01-12 span emitter, and the
// 01-13 persistence ports together behind sanitized SSE: POST /api/ask
// mints D-13 run context, maps the UI persona to an MCP principal through
// the server-side yaml map, invokes buildRootGraph with configurable
// holding thread_id, runId, and principal, streams allowlisted
// schema-validated SSE, and lets the 01-09 TraceWriter plus the 01-12 span
// emitter write the full redacted trace. POST /api/runs/:runId/resume
// issues Command({resume}) on the SAME thread_id, restart-proof via trace
// rehydration. PostgresSaver plus AppStateStore arrive only through
// apps/api/src/ports.ts (01-13, unmodified); boot fails fast when
// HARNESS_STATE_DATABASE_URL is absent and never falls back to MemorySaver.
//
// The createTracerApi slice below stays as the compatibility host for the
// pre-01-14 suites (its UUID thread shape and five-event stream are pinned
// by apps/api/test/tracer.test.ts, which this plan does not modify).

import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { buildRootGraph, runTracerGraph, type AgentState, type UcEntryHandler } from "@shared/agent";
import { createSpanEmitter } from "@shared/agent/telemetry";
import { dbToolError, type DbToolError } from "@shared/contracts";
import { createHostPorts, type HostPorts } from "./ports.js";
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
  emitSseEvent,
  failedPayload,
  intentPayload,
  interruptPayload,
  runningPayload,
  schemaPayload,
  sqlPayload,
} from "./sse.js";
import type { AppStateStore } from "./store/alertStore.js";

export const API_SHELL =
  "API host: Express SSE streaming with persona principals, injected persistence ports, and resume";

export type ApiShellError = DbToolError;

export interface ReindexResult {
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
}

/** Options for the full host. The checkpointer is already set up. */
export interface BuildAppOptions {
  /** Durable saver (PostgresSaver in prod via ports; MemorySaver in tests). */
  checkpointer: BaseCheckpointSaver;
  /** MCP gateway URL for per-call run identity. */
  mcpUrl: string;
  /** Trace directory shared with resume rehydration. */
  tracesDir?: string;
  /** Client registry; defaults to the server-side yaml file. */
  registry?: ClientRegistry;
  /** Env map for token resolution; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injected AppStateStore (UC-10 write-after-send path; ask/resume hold it, never call it). */
  store?: AppStateStore;
  /** Test seam: merged OVER the registry table (mirrors RootGraphDeps). */
  ucHandlers?: Record<string, UcEntryHandler>;
  /** Optional semantic re-index handler (defaults to calling the MCP gateway /reindex endpoint). */
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
      // Keep the default status message.
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

/** Per-run identity retained for resume on the same thread_id. */
interface StoredRun {
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

function previewTotal(preview: Record<string, unknown>[]): number {
  return preview.reduce((sum, row) => sum + Number(row["n"] ?? 0), 0);
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

export function buildApp(options: BuildAppOptions): express.Express {
  const tracesDir = options.tracesDir ?? "traces";
  const env = options.env ?? process.env;
  const registry = options.registry ?? loadRegistryFromFile();
  assertTokensPresent(registry, env);

  // Per-run identity scoped by runId, write-once (T-01-14-05: no shared
  // mutable registry without per-request scoping — entries are keyed by
  // runId and never overwritten, so concurrent asks cannot cross identity).
  const runs = new Map<string, StoredRun>();

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  function buildGraph(run: StoredRun, runId: string) {
    const emit = createSpanEmitter({
      runId,
      threadId: run.threadId,
      userId: run.userId,
      role: run.roleScope,
      tracesDir: run.tracesDir,
    });
    return {
      graph: buildRootGraph({
        checkpointer: options.checkpointer,
        emitSpan: emit,
        ...(options.ucHandlers ? { ucHandlers: options.ucHandlers } : {}),
      }),
      emit,
    };
  }

  function configurableFor(run: StoredRun, runId: string): Record<string, unknown> {
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

  /** Stream the five-event completion sequence for a finished run. */
  function streamCompletion(
    res: Response,
    runId: string,
    threadId: string,
    out: AgentState,
  ): void {
    const preview = (out.resultPreview ?? []) as Record<string, unknown>[];
    const tablesUsed = (out.tablesUsed ?? []) as string[];
    emitSseEvent(res, "intent_parsed", {
      runId,
      threadId,
      node: "understand",
      data: intentPayload({
        metric: out.intent?.metric ?? null,
        dimensions: [...(out.intent?.dimensions ?? [])],
        filters: [...(out.intent?.filters ?? [])],
        timeRange: out.intent?.timeRange ?? null,
      }),
    });
    emitSseEvent(res, "schema_retrieved", {
      runId,
      threadId,
      node: "describe",
      data: schemaPayload(tablesUsed),
    });
    emitSseEvent(res, "sql_generated", {
      runId,
      threadId,
      node: "run",
      data: sqlPayload(out.sql ?? null, tablesUsed),
    });
    emitSseEvent(res, "query_running", {
      runId,
      threadId,
      node: "run",
      data: runningPayload(preview.length),
    });
    emitSseEvent(res, "completed", {
      runId,
      threadId,
      node: "answer",
      data: completedPayload({
        status: out.status,
        answerText: out.answerText,
        toolsCalled: [...(out.toolsCalled ?? [])],
        total: previewTotal(preview),
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

    try {
      const { graph, emit } = buildGraph(run, runId);
      const out = (await graph.invoke(
        { question, ucId: "", runId, threadId },
        { configurable: configurableFor(run, runId) },
      )) as AgentState;
      if (interruptedOf(out)?.length) {
        emitSseEvent(res, "interrupt_waiting", {
          runId,
          threadId,
          node: "answer",
          data: interruptPayload({
            pendingClarification: out.pendingClarification,
          }),
        });
        return;
      }
      streamCompletion(res, runId, threadId, out);
      emit({ node: "answer", type: "run_done", durationMs: 0, attempt: 0 });
    } catch (error) {
      emitSseEvent(res, "failed", {
        runId,
        threadId,
        node: "answer",
        data: failedPayload({
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "unknown ask failure",
          retryable: true,
          repairable: false,
        }),
      });
    } finally {
      res.end();
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
    if (!isRecord(req.body)) {
      res.status(400).json(dbToolError("INVALID_PARAMS", "resume body must carry a value"));
      return;
    }
    const stored = runs.get(runId) ?? rehydrateRun(runId, registry, env, options.mcpUrl, tracesDir);
    if (!stored) {
      res.status(404).json(dbToolError("INVALID_PARAMS", `unknown runId '${runId}'`));
      return;
    }
    if (!runs.has(runId)) runs.set(runId, stored);

    res.writeHead(200, { ...SSE_HEADERS, "x-run-id": runId });

    try {
      const { graph, emit } = buildGraph(stored, runId);
      const out = (await graph.invoke(new Command({ resume: req.body["value"] }), {
        configurable: configurableFor(stored, runId),
      })) as AgentState;
      if (interruptedOf(out)?.length) {
        emitSseEvent(res, "interrupt_waiting", {
          runId,
          threadId: stored.threadId,
          node: "answer",
          data: interruptPayload({
            pendingClarification: out.pendingClarification,
          }),
        });
        return;
      }
      streamCompletion(res, runId, stored.threadId, out);
      emit({ node: "answer", type: "run_done", durationMs: 0, attempt: 0 });
    } catch (error) {
      emitSseEvent(res, "failed", {
        runId,
        threadId: stored.threadId,
        node: "answer",
        data: failedPayload({
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "unknown resume failure",
          retryable: true,
          repairable: false,
        }),
      });
    } finally {
      res.end();
    }
  });

  return app;
}

/**
 * Restart-proof rehydration (T-01-14-04): parse ONLY the header line of
 * traces/<runId>.jsonl for runId plus threadId with strict shape checks.
 * Malformed or mismatched lines are ignored and fall through to 404 — a
 * trace line can never inject identity.
 */
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

// ---------------------------------------------------------------------------
// Compatibility slice: the pre-01-14 thin host pinned by
// apps/api/test/tracer.test.ts (UUID thread shape, five-event stream).
// ---------------------------------------------------------------------------

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
        // Ignore close faults on an already-failing read path.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Compatibility slice: the pre-01-14 thin host pinned by
// apps/api/test/tracer.test.ts (UUID thread shape, five-event stream).
// ---------------------------------------------------------------------------

const PERSONAS: Record<string, { userId: string; roleScope: string }> = {
  sales_south: { userId: "demo-user", roleScope: "sales_south" },
  marketing: { userId: "demo-marketing", roleScope: "sales_south" },
  default: { userId: "demo-user", roleScope: "sales_south" },
};

export interface TracerApiOptions {
  mcpUrl: string;
  token: string;
  tracesDir?: string;
}

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createTracerApi(options: TracerApiOptions): express.Express {
  const tracesDir = options.tracesDir ?? "traces";
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.post("/api/ask", async (req: Request, res: Response) => {
    const question = req.body?.["question"];
    if (typeof question !== "string" || question.trim().length === 0) {
      res.status(400).json({
        code: "INVALID_PARAMS",
        message: "question must be a non-empty string",
        retryable: false,
        repairable: false,
      });
      return;
    }
    const persona =
      typeof req.body?.["persona"] === "string" ? req.body["persona"] : "default";
    const principal = PERSONAS[persona] ?? PERSONAS["default"];
    if (!principal) {
      res.status(400).json({
        code: "INVALID_PARAMS",
        message: `unknown persona '${persona}'`,
        retryable: false,
        repairable: false,
      });
      return;
    }

    const runId = randomUUID();
    const threadId = randomUUID();

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const base = { runId, threadId };
    try {
      sseSend(res, "intent_parsed", {
        ...base,
        node: "understand",
        data: {
          metric: "orders_per_status",
          dimensions: ["status"],
          filters: [],
          timeRange: null,
        },
      });

      const out = await runTracerGraph(question, {
        mcpUrl: options.mcpUrl,
        token: options.token,
        runId,
        userId: principal.userId,
        roleScope: principal.roleScope,
        threadId,
        tracesDir,
      });

      sseSend(res, "schema_retrieved", {
        ...base,
        node: "describe",
        data: { tables: ["customers", "orders"], tableCount: 2 },
      });
      sseSend(res, "sql_generated", {
        ...base,
        node: "run",
        data: { tablesUsed: ["orders"], statementType: "SELECT" },
      });
      const total = Number(
        /(\d+) orders/.exec(out.answerText)?.[1] ?? "0",
      );
      sseSend(res, "query_running", {
        ...base,
        node: "run",
        data: { statusGroups: out.toolsCalled.includes("run_query") ? 3 : 0 },
      });
      sseSend(res, "completed", {
        ...base,
        node: "answer",
        data: {
          status: out.status,
          answerText: out.answerText,
          toolsCalled: out.toolsCalled,
          total,
        },
      });
    } catch (err) {
      sseSend(res, "completed", {
        ...base,
        node: "answer",
        data: {
          status: "error",
          answerText: err instanceof Error ? err.message : "unknown error",
          toolsCalled: [],
          total: 0,
        },
      });
    } finally {
      res.end();
    }
  });

  return app;
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
  // Full host boot: persistence ports arrive only through the 01-13 ports
  // module, which throws fail-fast when HARNESS_STATE_DATABASE_URL is
  // absent — the host never falls back to MemorySaver.
  const ports: HostPorts = await createHostPorts();
  const registry = loadRegistryFromFile();
  assertTokensPresent(registry);
  const app = buildApp({
    checkpointer: ports.checkpointer,
    store: ports.store,
    mcpUrl,
    tracesDir,
    registry,
  });
  const server = app.listen(apiPort, () => {
    console.log(`[api] listening on 127.0.0.1:${apiPort}`);
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
}
