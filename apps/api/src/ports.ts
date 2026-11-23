import { createCheckpointer, type Checkpointer } from "@shared/agent/ports";
import { AppStateStore } from "./store/alertStore.js";

export interface HostPorts {
  checkpointer: Checkpointer;
  store: AppStateStore;
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
  return { checkpointer, store };
}
