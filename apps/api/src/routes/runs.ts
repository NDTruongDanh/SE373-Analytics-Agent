import { Router, type Request, type Response } from "express";
import { Command } from "@langchain/langgraph";
import {
  compactTurnCheckpoint,
  RCA_ROUTE,
  TEXT_TO_SQL_ROUTE,
  type AgentState,
} from "@shared/agent";
import {
  buildLangSmithRunConfig,
  createLangSmithTracer,
  createSpanEmitter,
  flushLangSmith,
} from "@shared/agent/telemetry";
import { dbToolError } from "@shared/contracts";
import { SSE_HEADERS } from "../middleware/security.js";
import {
  approvalDecision,
  interruptedOf,
  readLastApprovalRequest,
} from "../runtime/approvals.js";
import {
  buildResumeInvokeOptions,
  buildRunGraph,
  configurableForRun,
  emitInterruptWaiting,
  isRecord,
  LANGSMITH_FLUSH_TIMEOUT_MS,
  readCheckpointId,
  streamCompletion,
  toFailedSseData,
} from "../runtime/execution.js";
import { rehydrateRun } from "../runtime/rehydrate.js";
import { emitSseEvent } from "../sse.js";
import type { AppContext } from "../types.js";

export function createRunsRouter(ctx: AppContext): Router {
  const router = Router();

  router.post("/runs/:runId/resume", async (req: Request, res: Response) => {
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
    const stored =
      ctx.runs.get(runId) ??
      rehydrateRun(runId, ctx.registry, ctx.env, ctx.options.mcpUrl, ctx.tracesDir);
    if (!stored) {
      res.status(404).json(dbToolError("INVALID_PARAMS", `unknown runId '${runId}'`));
      return;
    }
    if (!ctx.runs.has(runId)) ctx.runs.set(runId, stored);

    let lock: Awaited<ReturnType<AppContext["acquireThreadLock"]>>;
    try {
      lock = await ctx.acquireThreadLock(stored.threadId);
    } catch {
      res.status(500).json(dbToolError("INTERNAL_ERROR", "failed to acquire thread lock"));
      return;
    }
    if (!lock.acquired) {
      res.status(409).json({
        code: "CONFLICT",
        message: `thread '${stored.threadId}' is already locked by an active operation`,
      });
      return;
    }

    let emit: ReturnType<typeof createSpanEmitter> | undefined;
    try {
      const built = buildRunGraph(ctx.options, stored, runId, res);
      emit = built.emit;
      const graph = built.graph;
      const saved = await graph.getState({ configurable: configurableForRun(stored, runId) });
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
      const activeCheckpointId = await readCheckpointId(ctx.options.checkpointer, stored.threadId);
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
      const tracer = createLangSmithTracer(ctx.env);
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
      const invokeConfig = buildResumeInvokeOptions({ langsmith: ls, run: stored, runId });
      const out = (await graph.invoke(new Command({ resume: req.body["value"] }), invokeConfig)) as AgentState;
      const resumeInterrupts = interruptedOf(out);
      if (resumeInterrupts?.length) {
        await emitInterruptWaiting({
          checkpointer: ctx.options.checkpointer,
          res,
          emit,
          runId,
          threadId: stored.threadId,
          interrupts: resumeInterrupts,
          out,
        });
        return;
      }
      streamCompletion(res, runId, stored.threadId, out);
      try {
        await compactTurnCheckpoint(graph, invokeConfig);
      } catch {
        emit({ node: "answer", type: "checkpoint_compaction_failed", durationMs: 0 });
      }
      emit.emitRunDone(out.status);
    } catch (error) {
      emit?.emitRunDone("error");
      if (!res.headersSent) {
        res.status(500).json(dbToolError("INTERNAL_ERROR", "failed to resume run"));
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

  return router;
}
