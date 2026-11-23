// Tier-1 transient RAM store for the <= 1,000-row validation buffer
// (architecture §4.3 Tier 1). Kept strictly outside AgentState so
// PostgresSaver checkpoints never bloat beyond the 50-row resultPreview.

export interface TransientQueryBuffer {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const TRANSIENT_BUFFER_MAX_ROWS = 1000;
const MAX_ACTIVE_RUN_BUFFERS = 256;

const buffers = new Map<string, TransientQueryBuffer>();

/**
 * Store the transient <= 1,000-row query buffer for `runId`.
 * Ignores empty runIds and evicts the oldest entry when bounded capacity is reached.
 */
export function setTransientQueryBuffer(
  runId: string,
  buffer: TransientQueryBuffer,
): void {
  const key = runId.trim();
  if (!key) return;
  if (buffers.has(key)) {
    buffers.delete(key);
  } else if (buffers.size >= MAX_ACTIVE_RUN_BUFFERS) {
    const oldest = buffers.keys().next().value;
    if (oldest !== undefined) buffers.delete(oldest);
  }
  buffers.set(key, {
    columns: [...buffer.columns],
    rows: buffer.rows.slice(0, TRANSIENT_BUFFER_MAX_ROWS),
    truncated: Boolean(buffer.truncated),
  });
}

/**
 * Consume and remove the transient query buffer for `runId` (single-step lifecycle).
 */
export function takeTransientQueryBuffer(
  runId: string,
): TransientQueryBuffer | undefined {
  const key = runId.trim();
  if (!key) return undefined;
  const entry = buffers.get(key);
  if (entry) buffers.delete(key);
  return entry;
}
