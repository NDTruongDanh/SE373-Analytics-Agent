// Host-side persistence port construction (01-13, wave 5).
//
// Builds both 01-14 host ports from HARNESS_STATE_DATABASE_URL (env only,
// never a credential literal): the PostgresSaver through the agent ports
// barrel (mandatory setup() fail-fast lives there) and the AppStateStore
// DAO. Throws fail-fast when the env var is absent so the host cannot boot
// without durable checkpoints.
//
// This file holds no Express code (01-14 owns index.ts) and no persona
// mapping (01-14 owns principals.ts).
//
// WRITE-AFTER-SEND HANDOFF for 01-14: call store.recordSent(row) ONLY
// after send_alert succeeds — never speculatively, never inside the send
// path itself. Check store.hasFingerprint(fp) before sending (24h dedup).

import { createCheckpointer, type Checkpointer } from "@shared/agent/ports";
import { AppStateStore } from "./store/alertStore.js";

/** Both persistence ports injected into the graph host. */
export interface HostPorts {
  checkpointer: Checkpointer;
  store: AppStateStore;
}

/**
 * Construct both ports. The `env` parameter exists for tests; production
 * passes process.env (the default).
 */
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
  return { checkpointer, store };
}
