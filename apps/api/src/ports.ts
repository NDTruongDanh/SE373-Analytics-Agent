import { createCheckpointer, type Checkpointer } from "@shared/agent/ports";
import { AppStateStore } from "./store/alertStore.js";
import {
  createLockPool,
  createThreadLockAcquirer,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
  expirePendingCheckpoints,
  pruneCompletedCheckpoints,
  startCheckpointLifecycleScheduler,
  type AdvisoryLockClientLike,
  type AdvisoryLockPoolLike,
  type CheckpointGraphLike,
  type CheckpointLifecycleScheduler,
  type CheckpointLifecycleSchedulerOptions,
  type ThreadLockAcquirer,
  type ThreadLockHandle,
} from "./store/threadLock.js";

export {
  createLockPool,
  createThreadLockAcquirer,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
  expirePendingCheckpoints,
  pruneCompletedCheckpoints,
  startCheckpointLifecycleScheduler,
  type AdvisoryLockClientLike,
  type AdvisoryLockPoolLike,
  type CheckpointGraphLike,
  type CheckpointLifecycleScheduler,
  type CheckpointLifecycleSchedulerOptions,
  type ThreadLockAcquirer,
  type ThreadLockHandle,
};

export interface HostPorts {
  checkpointer: Checkpointer;
  store: AppStateStore;
  lockPool: AdvisoryLockPoolLike;
  acquireThreadLock: ThreadLockAcquirer;
}

export async function createHostPorts(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HostPorts> {
  const conn = env["HARNESS_STATE_DATABASE_URL"];
  if (typeof conn !== "string" || conn.length === 0) {
    throw new Error(
      "createHostPorts: HARNESS_STATE_DATABASE_URL is not set; refusing to " +
        "boot without the harness_state persistence ports.",
    );
  }
  const checkpointer = await createCheckpointer(conn);
  const store = new AppStateStore(conn);
  const lockPool = createLockPool(conn);
  return {
    checkpointer,
    store,
    lockPool,
    acquireThreadLock: createThreadLockAcquirer(lockPool),
  };
}
