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
import { CHECKPOINT_SCHEMA, createCheckpointer } from "../src/ports/index.js";
import { makeThreadId } from "../src/hitl.js";

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
});
