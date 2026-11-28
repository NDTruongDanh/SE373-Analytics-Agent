import { Router, type Request, type Response } from "express";
import { Overwrite } from "@langchain/langgraph";
import {
  BUDGET_DEFAULTS,
  compactTurnCheckpoint,
  routeQuestion,
  type AgentState,
} from "@shared/agent";
import {
  buildLangSmithRunConfig,
  createLangSmithTracer,
  createSpanEmitter,
  flushLangSmith,
} from "@shared/agent/telemetry";
import { dbToolError } from "@shared/contracts";
import { resolveRequestPersona } from "../middleware/persona.js";
import { SSE_HEADERS } from "../middleware/security.js";
import { InvalidThreadError, mintRunContext } from "../principals.js";
import { interruptedOf } from "../runtime/approvals.js";
import {
  buildRunGraph,
  configurableForRun,
  emitInterruptWaiting,
  LANGSMITH_FLUSH_TIMEOUT_MS,
  streamCompletion,
  toFailedSseData,
} from "../runtime/execution.js";
import { emitSseEvent } from "../sse.js";
import type { AppContext, StoredRun } from "../types.js";

export function createAskRouter(ctx: AppContext): Router {
  const router = Router();

  router.post("/ask", async (req: Request, res: Response) => {
    const question = req.body?.["question"];
    if (typeof question !== "string" || question.trim().length === 0) {
      res
        .status(400)
        .json(dbToolError("INVALID_PARAMS", "question must be a non-empty string"));
      return;
    }

    const resolved = resolveRequestPersona(req, res, ctx.registry, ctx.env);
    if (!resolved) return;
    const { principal, token } = resolved;

    let runId: string;
    let threadId: string;
    try {
      const minted = mintRunContext(
        principal.userId,
        typeof req.body?.["threadId"] === "string" ? req.body["threadId"] : undefined,
      );
      runId = minted.runId;
      threadId = minted.threadId;
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

    let lock: Awaited<ReturnType<AppContext["acquireThreadLock"]>>;
    try {
      lock = await ctx.acquireThreadLock(threadId);
    } catch {
      res.status(500).json(dbToolError("INTERNAL_ERROR", "failed to acquire thread lock"));
      return;
    }
    if (!lock.acquired) {
      res.status(409).json({
        code: "CONFLICT",
        message: `thread '${threadId}' is already locked by an active operation`,
      });
      return;
    }

    let emit: ReturnType<typeof createSpanEmitter> | undefined;
    try {
      const run: StoredRun = {
        threadId,
        userId: principal.userId,
        roleScope: principal.role,
        ...(principal.rowScope ? { rowScope: { ...principal.rowScope } } : {}),
        token,
        mcpUrl: ctx.options.mcpUrl,
        tracesDir: ctx.tracesDir,
      };
      if (!ctx.runs.has(runId)) ctx.runs.set(runId, run);

      res.writeHead(200, { ...SSE_HEADERS, "x-run-id": runId });
      emitSseEvent(res, "intent_parsed", { runId, threadId, node: "understand", data: { phase: "starting" } });

      const built = buildRunGraph(ctx.options, run, runId, res);
      emit = built.emit;
      const graph = built.graph;
      // Reuse runId as LangSmith runId for 1:1 JSONL correlation; custom tracer suppresses env auto-tracing.
      const tracer = createLangSmithTracer(ctx.env);
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
      const invokeConfig = {
        runId,
        callbacks: ls?.callbacks,
        tags: ls?.tags,
        metadata: ls?.metadata,
        configurable: configurableForRun(run, runId),
      };
      const out = (await graph.invoke(
        {
          question, runId, threadId,
          // A new question reuses the thread, but not the previous run's outputs or budgets.
          status: "no_data", errorCode: null, answerText: "", sql: null, tablesUsed: [],
          semanticChunks: [], catalogTables: [], catalogStatus: "unloaded",
          semanticQuery: null, semanticRetrieveStatus: "unloaded", semanticErrorCode: null,
          resultPreview: [], columns: [], toolsCalled: [],
          resultTruncated: false, rowCount: null, budgetExceeded: false,
          clarificationAttempts: 0, analysisTopicChanged: false, caveats: [], governed: undefined,
          vizSpec: null, pendingClarification: null, analysisPlan: null, rootCauseAnswer: null,
          budget: new Overwrite({ llmCalls: 0, tokensUsed: 0, maxLlmCalls: BUDGET_DEFAULTS.maxLlmCalls, maxTokens: BUDGET_DEFAULTS.maxTokens, deadlineMs: 0 }),
          telemetry: new Overwrite({ promptTokens: 0, completionTokens: 0, latencyMs: 0 }),
        },
        invokeConfig,
      )) as AgentState;
      const interrupts = interruptedOf(out);
      if (interrupts?.length) {
        await emitInterruptWaiting({
          checkpointer: ctx.options.checkpointer,
          res,
          emit,
          runId,
          threadId,
          interrupts,
          out,
        });
        return;
      }
      streamCompletion(res, runId, threadId, out);
      try {
        await compactTurnCheckpoint(graph, invokeConfig);
      } catch {
        emit?.({ node: "answer", type: "checkpoint_compaction_failed", durationMs: 0 });
      }
      emit.emitRunDone(out.status);
    } catch (error) {
      emit?.emitRunDone("error");
      if (!res.headersSent) {
        res.status(500).json(dbToolError("INTERNAL_ERROR", "failed to process ask request"));
      } else {
        emitSseEvent(res, "failed", {
          runId,
          threadId,
          node: "answer",
          data: toFailedSseData(error, "unknown ask failure"),
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

  return router;
}
