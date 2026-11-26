import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { CHECKPOINT_SCHEMA } from "../constants.js";

export { CHECKPOINT_SCHEMA } from "../constants.js";

export type Checkpointer = PostgresSaver;

export interface CreateCheckpointerOptions {
  readonly schema?: typeof CHECKPOINT_SCHEMA;
}

/**
 * Build a PostgresSaver as harness_state; fails fast at boot on setup() errors
 * or agent_ro URLs (never falls back to MemorySaver).
 */
export async function createCheckpointer(
  harnessStateConn: string,
  options: CreateCheckpointerOptions = {},
): Promise<Checkpointer> {
  if (typeof harnessStateConn !== "string" || harnessStateConn.length === 0) {
    throw new Error(
      "createCheckpointer: harnessStateConn must be a non-empty connection string " +
        "(HARNESS_STATE_DATABASE_URL); refusing to start without durable checkpoints.",
    );
  }
  rejectAgentRo(harnessStateConn);
  const saver = PostgresSaver.fromConnString(harnessStateConn, {
    schema: options.schema ?? CHECKPOINT_SCHEMA,
  });
  // Run setup() once at boot so failures surface immediately instead of retrying per request.
  await saver.setup();
  return saver;
}

// Reject read-only agent_ro URLs early; leave unparseable strings to PostgresSaver so driver errors are not masked.
function rejectAgentRo(connString: string): void {
  let username = "";
  try {
    username = decodeURIComponent(new URL(connString).username);
  } catch {
    return;
  }
  if (username === "agent_ro") {
    throw new Error(
      "createCheckpointer: refusing the agent_ro connection string — " +
        "checkpoints require the harness_state owner (HARNESS_STATE_DATABASE_URL).",
    );
  }
}
