// PORT-01/DB-05/DB-06 live role-proof plus checkpoint round-trip (01-13).
//
// Every leg runs inside describe.skipIf(!HARNESS_STATE_DATABASE_URL) per
// D-21 so the suite skips green without DB URLs. Docker is only touched via
// `sg docker -c` from the shell (D-16); this file opens no containers.
//
// No pg import in this package (ESLint ban holds): the raw-SQL probes run
// on the saver's own harness_state pool — the exact client the host uses —
// reached through a minimal structural type, never through the pg package.

import { describe, expect, it } from "vitest";
import {
  StateGraph,
  StateSchema,
  START,
  END,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import * as z from "zod";
import { createCheckpointer } from "../src/ports/index.js";
import { CHECKPOINT_SCHEMA } from "../src/constants.js";
import { makeThreadId, resumeDecision } from "../src/hitl.js";
import { AgentStateSchema, type AgentState } from "../src/state.js";
import { createRcaRuntime } from "../src/subgraphs/rootCauseAnalysis.js";
import type { PlanStep } from "@shared/contracts";
import path from "node:path";
import fs from "node:fs";

if (!process.env["HARNESS_STATE_DATABASE_URL"]) {
  const rootEnv = path.resolve(import.meta.dirname, "../../../.env");
  if (fs.existsSync(rootEnv)) {
    try {
      process.loadEnvFile?.(rootEnv);
    } catch {
      // .env unreadable, continue
    }
  }
}

const LIVE_URL = process.env["HARNESS_STATE_DATABASE_URL"];
const describeLive = describe.skipIf(!LIVE_URL);

const EXPECTED_TABLES = [
  "checkpoint_blobs",
  "checkpoint_migrations",
  "checkpoint_writes",
  "checkpoints",
] as const;

/** Minimal structural handle on the saver's own pool (no pg import). */
interface SaverPool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function saverPool(saver: unknown): SaverPool {
  return (saver as unknown as { pool: SaverPool }).pool;
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

const RoundTripState = new StateSchema({
  marker: z.string().nullable().default(null),
});

function hasNoFunctions(value: unknown): boolean {
  if (typeof value === "function") return false;
  if (Array.isArray(value)) return value.every(hasNoFunctions);
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(hasNoFunctions);
  }
  return true;
}

describeLive("ports live (requires HARNESS_STATE_DATABASE_URL)", () => {
  it("setup-as-harness_state creates the four checkpoint tables", async () => {
    const saver = await createCheckpointer(LIVE_URL as string);
    try {
      const { rows } = await saverPool(saver).query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
        [CHECKPOINT_SCHEMA],
      );
      const names = rows.map((r) => r["table_name"]);
      for (const table of EXPECTED_TABLES) {
        expect(names).toContain(table);
      }
    } finally {
      await saver.end();
    }
  }, 30000);

  it("harness_state owns langgraph/app_state and is denied on public.*", async () => {
    const saver = await createCheckpointer(LIVE_URL as string);
    try {
      const pool = saverPool(saver);
      const { rows } = await pool.query(
        "SELECT schemaname, tablename, tableowner FROM pg_tables " +
          "WHERE schemaname IN ('langgraph', 'app_state') ORDER BY 1, 2",
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row["tableowner"]).toBe("harness_state");
      }
      const qualified = rows.map((r) => `${r["schemaname"]}.${r["tablename"]}`);
      for (const table of EXPECTED_TABLES) {
        expect(qualified).toContain(`langgraph.${table}`);
      }
      expect(qualified).toContain("app_state.alert_history");
      // Zero grants on public.*: the saver client itself is denied.
      const denied = await pool
        .query("SELECT count(*) FROM public.orders")
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(pgCode(denied)).toBe("42501");
    } finally {
      await saver.end();
    }
  }, 30000);

  it("checkpoint survives full saver and graph re-instantiation", async () => {
    const threadId = makeThreadId("ports-live", "roundtrip");
    const counts = { a: 0, b: 0 };
    const build = (saver: unknown) =>
      new StateGraph(RoundTripState)
        .addNode("a", () => {
          counts.a += 1;
          return { marker: "a" };
        })
        .addNode("b", () => {
          counts.b += 1;
          return { marker: "b" };
        })
        .addEdge(START, "a")
        .addEdge("a", "b")
        .addEdge("b", END)
        .compile({
          // PostgresSaver extends BaseCheckpointSaver (verified in the
          // package .d.ts): this is the 01-10 root-graph plug point.
          checkpointer: saver as unknown as BaseCheckpointSaver,
        });

    const saver1 = await createCheckpointer(LIVE_URL as string);
    const first = await build(saver1).invoke(
      {},
      { configurable: { thread_id: threadId } },
    );
    expect(counts).toEqual({ a: 1, b: 1 });
    expect((first as { marker: string | null }).marker).toBe("b");
    await saver1.end();

    // Drop both instances entirely, then re-create from the factory.
    const saver2 = await createCheckpointer(LIVE_URL as string);
    try {
      const resumed = await build(saver2).getState({
        configurable: { thread_id: threadId },
      });
      expect(resumed.values).toEqual(first);
      // Plain JSON only in checkpoint payloads (T-01-13-02).
      expect(JSON.parse(JSON.stringify(resumed.values))).toEqual(first);
      expect(hasNoFunctions(resumed.values)).toBe(true);
      // Read-back ran no node.
      expect(counts).toEqual({ a: 1, b: 1 });
    } finally {
      await saver2.end();
    }
  }, 30000);

  it("UC-05 pauses at HITL plan review and resumes on PostgresSaver across process restart", async () => {
    let baselineQueryCalls = 0;
    const executedStepIds: string[] = [];
    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) => {
        baselineQueryCalls++;
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
      fetchStepMetrics: async (step: PlanStep) => {
        executedStepIds.push(step.stepId);
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
    };

    const threadId = makeThreadId("u_rca_live", `s_${Date.now()}`);

    // Build graph 1 with saver1
    const saver1 = await createCheckpointer(LIVE_URL as string);
    const rcaRuntime1 = createRcaRuntime(deps);
    const graph1 = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime1.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: saver1 as unknown as BaseCheckpointSaver });

    // 1. Initial run: runs baseline, generates plan, pauses at interrupt
    const initialRun = await graph1.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );
    expect((initialRun as { __interrupt__?: unknown[] }).__interrupt__).toBeDefined();
    expect(baselineQueryCalls).toBe(2);
    expect(executedStepIds).toHaveLength(0);

    // Simulate process shutdown
    await saver1.end();

    // 2. Simulate process restart: fresh saver, fresh runtime, fresh graph
    const saver2 = await createCheckpointer(LIVE_URL as string);
    try {
      const rcaRuntime2 = createRcaRuntime(deps);
      const graph2 = new StateGraph(AgentStateSchema)
        .addNode("rca", rcaRuntime2.entry)
        .addEdge(START, "rca")
        .addEdge("rca", END)
        .compile({ checkpointer: saver2 as unknown as BaseCheckpointSaver });

      const resumed = (await graph2.invoke(
        resumeDecision({ action: "APPROVE" }),
        { configurable: { thread_id: threadId } },
      )) as AgentState;

      expect(resumed.status).toBe("ok");
      expect(resumed.analysisPlan).not.toBeNull();
      // Baseline was NOT re-run! Still exactly 2 calls from before shutdown
      expect(baselineQueryCalls).toBe(2);
      // Steps executed successfully
      expect(executedStepIds.length).toBeGreaterThan(0);
      expect(resumed.answerText).toContain("Đã hoàn thành phân tích bóc tách");
    } finally {
      await saver2.end();
    }
  }, 30000);

  it("UC-05 step progress checkpoints to PostgresSaver and survives crash mid-execution", async () => {
    let baselineQueryCalls = 0;
    const executedStepIds: string[] = [];
    let shouldCrashAfterStep1 = true;

    const deps = {
      fetchBaseline: async (_m: string, _t: "additive" | "ratio", period: { start: string }) => {
        baselineQueryCalls++;
        return period.start.includes("08") ? 2_500_000_000 : 2_040_000_000;
      },
      fetchStepMetrics: async (step: PlanStep) => {
        executedStepIds.push(step.stepId);
        return { baselineVal: 500_000_000, currentVal: 400_000_000 };
      },
      onStepExecuted: async (step: PlanStep) => {
        if (shouldCrashAfterStep1 && step.stepId.includes("north")) {
          throw new Error("Simulated host process crash after step 1 checkpoint to Postgres");
        }
      },
    };

    const threadId = makeThreadId("u_rca_live_step", `s_${Date.now()}`);

    // Build graph 1 with saver1
    const saver1 = await createCheckpointer(LIVE_URL as string);
    const rcaRuntime1 = createRcaRuntime(deps);
    const graph1 = new StateGraph(AgentStateSchema)
      .addNode("rca", rcaRuntime1.entry)
      .addEdge(START, "rca")
      .addEdge("rca", END)
      .compile({ checkpointer: saver1 as unknown as BaseCheckpointSaver });

    // 1. Initial run: runs baseline, pauses at interrupt
    await graph1.invoke(
      { question: "Vì sao doanh thu thuần tháng 09/2026 giảm 18.4% so với tháng 08/2026?" },
      { configurable: { thread_id: threadId } },
    );

    // 2. Resume graph 1: step 1 completes, checkpoints to Postgres, then crashes
    await expect(
      graph1.invoke(
        resumeDecision({ action: "APPROVE" }),
        { configurable: { thread_id: threadId } },
      ),
    ).rejects.toThrow("Simulated host process crash after step 1 checkpoint to Postgres");

    // Simulate process shutdown
    await saver1.end();

    // 3. Process restarts: fresh PostgresSaver connects to real Postgres tables
    const saver2 = await createCheckpointer(LIVE_URL as string);
    try {
      shouldCrashAfterStep1 = false;
      const rcaRuntime2 = createRcaRuntime(deps);
      const graph2 = new StateGraph(AgentStateSchema)
        .addNode("rca", rcaRuntime2.entry)
        .addEdge(START, "rca")
        .addEdge("rca", END)
        .compile({ checkpointer: saver2 as unknown as BaseCheckpointSaver });

      const step1CallsBeforeRestart = executedStepIds.filter((id) => id.includes("north")).length;
      expect(step1CallsBeforeRestart).toBe(1);

      const resumed = (await graph2.invoke(
        resumeDecision({ action: "APPROVE" }),
        { configurable: { thread_id: threadId } },
      )) as AgentState;

      expect(resumed.status).toBe("ok");
      // Step 1 was checkpointed in Postgres, so on restart it was skipped and NOT re-executed!
      const step1CallsAfterRestart = executedStepIds.filter((id) => id.includes("north")).length;
      expect(step1CallsAfterRestart).toBe(1); // Exactly 1 call across entire process lifecycle!
      expect(baselineQueryCalls).toBe(2); // Baseline was NOT re-run!
    } finally {
      await saver2.end();
    }
  }, 30000);
});
