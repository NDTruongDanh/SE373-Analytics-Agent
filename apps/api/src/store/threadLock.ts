import { Command } from "@langchain/langgraph";
import { Pool } from "pg";

export interface ThreadLockHandle {
  acquired: boolean;
  release: () => Promise<void>;
}

export interface AdvisoryLockClientLike {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(destroy?: boolean | Error): void;
}

export interface AdvisoryLockPoolLike {
  connect(): Promise<AdvisoryLockClientLike>;
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export type ThreadLockAcquirer = (threadId: string) => Promise<ThreadLockHandle>;

export function createLockPool(connString: string): AdvisoryLockPoolLike {
  return new Pool({
    connectionString: connString,
    max: 10,
  }) as unknown as AdvisoryLockPoolLike;
}

// Native 64-bit PG advisory lock per threadId; discards the physical client on any
// acquire or unlock error so a broken or still-locked session never returns to the pool.
export function createThreadLockAcquirer(
  pool: AdvisoryLockPoolLike,
): ThreadLockAcquirer {
  return async (threadId: string): Promise<ThreadLockHandle> => {
    const client = await pool.connect();
    try {
      const res = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [`thread:${threadId}`],
      );
      const acquired = Boolean(res.rows[0]?.["acquired"]);
      if (!acquired) {
        client.release();
        return { acquired: false, release: async () => {} };
      }
      let released = false;
      return {
        acquired: true,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
              [`thread:${threadId}`],
            );
            client.release();
          } catch {
            client.release(true);
          }
        },
      };
    } catch (err) {
      client.release(true);
      throw err;
    }
  };
}

export interface CheckpointGraphLike {
  getState(config: { configurable: { thread_id: string } }): Promise<{
    next?: unknown[];
    tasks?: Array<{ interrupts?: unknown[] }>;
  }>;
  invoke(
    input: unknown,
    config: { configurable: { thread_id: string } },
  ): Promise<unknown>;
}

export async function expirePendingCheckpoints(options: {
  pool: Pick<AdvisoryLockPoolLike, "query">;
  graph: CheckpointGraphLike;
  acquireThreadLock: ThreadLockAcquirer;
  maxAgeDays?: number;
  now?: Date;
}): Promise<{ expired: string[]; skippedLocked: string[] }> {
  const maxAgeDays = options.maxAgeDays ?? 7;
  const cutoffIso = new Date(
    (options.now ?? new Date()).getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const res = await options.pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (thread_id, checkpoint_ns)
         thread_id, checkpoint_ns, checkpoint_id, checkpoint
       FROM langgraph.checkpoints
       ORDER BY thread_id, checkpoint_ns, checkpoint_id DESC
     )
     SELECT DISTINCT l.thread_id
     FROM latest l
     JOIN langgraph.checkpoint_writes w
       ON l.thread_id = w.thread_id
      AND l.checkpoint_ns = w.checkpoint_ns
      AND l.checkpoint_id = w.checkpoint_id
     WHERE w.channel = '__interrupt__'
       AND (l.checkpoint->>'ts')::timestamptz < $1::timestamptz`,
    [cutoffIso],
  );
  const expired: string[] = [];
  const skippedLocked: string[] = [];
  for (const row of res.rows) {
    const threadId = String(row["thread_id"] ?? "");
    if (!threadId) continue;
    const lock = await options.acquireThreadLock(threadId);
    if (!lock.acquired) {
      skippedLocked.push(threadId);
      continue;
    }
    try {
      const state = await options.graph.getState({
        configurable: { thread_id: threadId },
      });
      const hasInterrupt =
        Array.isArray(state.tasks) &&
        state.tasks.some(
          (t) => Array.isArray(t.interrupts) && t.interrupts.length > 0,
        );
      if (!hasInterrupt) continue;
      await options.graph.invoke(
        new Command({
          resume: { action: "timeout", reason: "HITL_APPROVAL_TIMEOUT" },
        }),
        { configurable: { thread_id: threadId } },
      );
      expired.push(threadId);
    } finally {
      await lock.release();
    }
  }
  return { expired, skippedLocked };
}

export async function pruneCompletedCheckpoints(options: {
  pool: Pick<AdvisoryLockPoolLike, "query" | "connect">;
  graph?: Pick<CheckpointGraphLike, "getState">;
  acquireThreadLock: ThreadLockAcquirer;
  retentionDays?: number;
  now?: Date;
}): Promise<{ pruned: string[]; skippedLocked: string[] }> {
  const retentionDays = options.retentionDays ?? 30;
  const cutoffIso = new Date(
    (options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const res = await options.pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (thread_id, checkpoint_ns)
         thread_id, checkpoint_ns, checkpoint_id, checkpoint
       FROM langgraph.checkpoints
       ORDER BY thread_id, checkpoint_ns, checkpoint_id DESC
     )
     SELECT l.thread_id
     FROM latest l
     GROUP BY l.thread_id
     HAVING MAX((l.checkpoint->>'ts')::timestamptz) < $1::timestamptz
       AND NOT EXISTS (
         SELECT 1
         FROM latest l2
         JOIN langgraph.checkpoint_writes w
           ON l2.thread_id = w.thread_id
          AND l2.checkpoint_ns = w.checkpoint_ns
          AND l2.checkpoint_id = w.checkpoint_id
         WHERE l2.thread_id = l.thread_id
           AND w.channel = '__interrupt__'
       )`,
    [cutoffIso],
  );
  const pruned: string[] = [];
  const skippedLocked: string[] = [];
  for (const row of res.rows) {
    const threadId = String(row["thread_id"] ?? "");
    if (!threadId) continue;
    const lock = await options.acquireThreadLock(threadId);
    if (!lock.acquired) {
      skippedLocked.push(threadId);
      continue;
    }
    try {
      if (options.graph) {
        const state = await options.graph.getState({
          configurable: { thread_id: threadId },
        });
        if (Array.isArray(state.next) && state.next.length > 0) {
          continue;
        }
      }
      const client = await options.pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM langgraph.checkpoint_writes WHERE thread_id = $1",
          [threadId],
        );
        await client.query(
          "DELETE FROM langgraph.checkpoint_blobs WHERE thread_id = $1",
          [threadId],
        );
        await client.query(
          "DELETE FROM langgraph.checkpoints WHERE thread_id = $1",
          [threadId],
        );
        await client.query("COMMIT");
        pruned.push(threadId);
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
        throw err;
      } finally {
        client.release(broken || undefined);
      }
    } finally {
      await lock.release();
    }
  }
  return { pruned, skippedLocked };
}

export const DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface CheckpointLifecycleSchedulerOptions {
  pool: Pick<AdvisoryLockPoolLike, "query" | "connect">;
  graph: CheckpointGraphLike;
  acquireThreadLock: ThreadLockAcquirer;
  intervalMs?: number;
  maxAgeDays?: number;
  retentionDays?: number;
  onError?: (error: unknown) => void;
}

export interface CheckpointLifecycleScheduler {
  runOnce: () => Promise<{
    expired: string[];
    pruned: string[];
    skippedLocked: string[];
  }>;
  stop: () => void;
}

export function startCheckpointLifecycleScheduler(
  options: CheckpointLifecycleSchedulerOptions,
): CheckpointLifecycleScheduler {
  const intervalMs = Math.max(
    1,
    options.intervalMs ?? DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
  );
  let stopped = false;
  let running = false;

  const runOnce = async () => {
    if (stopped || running) {
      return { expired: [], pruned: [], skippedLocked: [] };
    }
    running = true;
    try {
      const expiredRes = await expirePendingCheckpoints({
        pool: options.pool,
        graph: options.graph,
        acquireThreadLock: options.acquireThreadLock,
        ...(options.maxAgeDays !== undefined
          ? { maxAgeDays: options.maxAgeDays }
          : {}),
      });
      const prunedRes = await pruneCompletedCheckpoints({
        pool: options.pool,
        graph: options.graph,
        acquireThreadLock: options.acquireThreadLock,
        ...(options.retentionDays !== undefined
          ? { retentionDays: options.retentionDays }
          : {}),
      });
      return {
        expired: expiredRes.expired,
        pruned: prunedRes.pruned,
        skippedLocked: [
          ...new Set([
            ...expiredRes.skippedLocked,
            ...prunedRes.skippedLocked,
          ]),
        ],
      };
    } catch (error) {
      options.onError?.(error);
      return { expired: [], pruned: [], skippedLocked: [] };
    } finally {
      running = false;
    }
  };

  void runOnce();
  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    runOnce,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
