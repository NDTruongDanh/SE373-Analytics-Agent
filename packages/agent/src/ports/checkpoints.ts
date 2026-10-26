// PORT-01 PostgresSaver factory (01-13, wave 5).
//
// The host (01-14) builds its crash-safe checkpointer through
// createCheckpointer() and injects the result into the 01-10 root graph
// compile({ checkpointer }). Connection identity: the factory takes a
// connection STRING only (never a Pool/Client instance) so checkpoint state
// stays serializable, and the caller must pass HARNESS_STATE_DATABASE_URL.
//
// NEVER-RULES (pinned by unit legs in test/ports.test.ts):
// 1. Never catch-and-continue, never fall back to MemorySaver: setup()
//    failures (unreachable host, bad credentials, missing schema rights)
//    throw at factory time so the host fails fast at boot, not on first
//    invoke. MemorySaver is not imported here on purpose.
// 2. Never substitute the agent_ro connection string: agent_ro is read-only
//    (default_transaction_read_only=on, zero grants on langgraph.*), so
//    every checkpoint write would fail. The factory rejects agent_ro URLs
//    before touching the network.
//
// This module must never import pg or pg-cursor directly (ESLint ban holds:
// the driver arrives transitively inside
// @langchain/langgraph-checkpoint-postgres). This module must never import
// mcp-server internals: checkpoint rows carry plain JSON state only.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/** Postgres schema that PostgresSaver.setup() owns (harness_state). */
export const CHECKPOINT_SCHEMA = "langgraph" as const;

/**
 * Upper bound for thread_id length. PostgresSaver keys checkpoints on
 * thread_id text; keep ids strictly below 255 chars (arch §4.5, D-13).
 */
export const THREAD_ID_MAX_LENGTH = 255;

/** Concrete saver type returned by {@link createCheckpointer}. */
export type Checkpointer = PostgresSaver;

/**
 * Options accepted by {@link createCheckpointer}. The schema stays pinned
 * to {@link CHECKPOINT_SCHEMA}: callers may restate it explicitly, but the
 * type system rejects any other value so a host cannot silently point
 * checkpoints at the wrong schema.
 */
export interface CreateCheckpointerOptions {
  readonly schema?: typeof CHECKPOINT_SCHEMA;
}

/**
 * Build a crash-safe PostgresSaver as harness_state.
 *
 * Calls PostgresSaver.fromConnString(harnessStateConn, { schema:
 * "langgraph" }) then awaits setup() exactly once before returning, so the
 * four checkpoint tables (checkpoints, checkpoint_blobs, checkpoint_writes,
 * checkpoint_migrations) exist before the first invoke. Any setup() failure
 * throws to the caller (host boot fails fast).
 *
 * @param harnessStateConn HARNESS_STATE_DATABASE_URL value (env only; never
 * a credential literal, never the agent_ro URL).
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
  // Exactly once per factory call, at host boot — never per request, never
  // retried in a storm (T-01-13-05). A throw here is the fail-fast signal.
  await saver.setup();
  return saver;
}

/**
 * Fail fast when the read-only agent_ro identity is passed where the
 * harness_state owner is required. Parses only the URL userinfo; an
 * unparseable string is left for fromConnString/setup to reject so this
 * guard can never mask the real driver error.
 */
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

/**
 * Build a checkpoint thread_id for one conversation.
 * Format `chat:{userId}:{sessionId}` per the agent research anti-pattern
 * fix: a fresh thread_id per turn breaks multi-turn context, while a bare
 * userId leaks context across conversations. Throws fail-fast when the
 * composed id would reach {@link THREAD_ID_MAX_LENGTH} chars.
 */
export function buildThreadId(userId: string, sessionId: string): string {
  const threadId = `chat:${userId}:${sessionId}`;
  if (threadId.length >= THREAD_ID_MAX_LENGTH) {
    throw new Error(
      `buildThreadId: composed thread_id is ${threadId.length} chars, ` +
        `over the ${THREAD_ID_MAX_LENGTH - 1} limit; pass shorter ids.`,
    );
  }
  return threadId;
}
