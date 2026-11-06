// PII-safe LangSmith export (Phase 3, plan 03-02, D-02..D-05).
//
// The JSONL sink stays authoritative (D-01); this module is the ONLY path
// that may construct a LangSmith `Client` or `LangChainTracer` in product
// code. Every run payload crosses `piiSafeProcessor` before upload: query
// result row arrays are dropped (only rowCount, column names, truncated,
// and maskedColumns survive) and the remainder is scanned with the shared
// `redactPII` / `redactRow` from `@shared/access-policy`. No new redactor
// lives here. Any processor failure closes fail-safe to `{}` — nothing
// raw is ever sent.
//
// Enablement (D-04): the tracer exists only when ALL of
// LANGSMITH_TRACING=true, LANGSMITH_API_KEY, and LANGSMITH_PROJECT are set.
// LangChain/LangGraph auto-tracing from env alone uses a bare singleton
// client with no anonymizer, so every graph.invoke MUST carry our tracer
// explicitly in RunnableConfig `callbacks` (the handler name
// "langchain_tracer" suppresses the bare auto-tracer copy-safely).
import { Client } from "langsmith";
import {
  LangChainTracer,
  OVERRIDABLE_LANGSMITH_INHERITABLE_METADATA_KEYS,
} from "@langchain/core/tracers/tracer_langchain";
import { redactPII, redactRow } from "@shared/access-policy";

/** Owner-chosen LangSmith project (D-05); separate from the OpenWiki project. */
export const LANGSMITH_PROJECT_DEFAULT = "se373-analytics-agent";

/**
 * Every tracing flag LangChain/LangGraph reads for auto-tracing. Our gate
 * only honors LANGSMITH_TRACING, but eval/tests must scrub ALL four so no
 * un-anonymized auto-tracer can fire in-process.
 */
export const LANGSMITH_ENV_FLAGS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

/** Delete every tracing flag in-process (eval + test guardrail, D-04). */
export function scrubLangSmithEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const flag of LANGSMITH_ENV_FLAGS) {
    delete env[flag];
  }
}

/**
 * True only when ALL of LANGSMITH_TRACING=true, LANGSMITH_API_KEY, and
 * LANGSMITH_PROJECT are set (D-04). Default OFF everywhere else.
 */
export function isLangSmithEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env["LANGSMITH_TRACING"] === "true" &&
    (env["LANGSMITH_API_KEY"] ?? "").length > 0 &&
    (env["LANGSMITH_PROJECT"] ?? "").length > 0
  );
}

/**
 * Object keys whose array values are query result rows. Dropped to `[]`
 * before upload; sibling `rowCount` / `columns` / `truncated` /
 * `maskedColumns` survive untouched (same rule as the JSONL sink: counts
 * and column names, never cell values).
 */
const ROW_ARRAY_KEYS = new Set([
  "rows",
  "resultPreview",
  "preview",
  "resultRows",
  "sampleRows",
]);

/**
 * Deep-clone `value`, dropping row arrays under ROW_ARRAY_KEYS and masking
 * direct string fields of every plain object via the shared `redactRow`.
 * Circular references collapse to "[Circular]" so the later stringify scan
 * cannot throw on them. Never mutates the input.
 */
function stripRowArrays(value: unknown, path: Set<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripRowArrays(item, path));
  }
  if (typeof value === "object" && value !== null) {
    if (path.has(value)) return "[Circular]";
    path.add(value);
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] =
        ROW_ARRAY_KEYS.has(key) && Array.isArray(entry)
          ? []
          : stripRowArrays(entry, path);
    }
    path.delete(value);
    // Shared redactor over this level's string cells (defense in depth;
    // the JSON stringify-scan below is the backstop for bare strings in
    // arrays and any nesting this walk does not cover).
    redactRow(clone);
    return clone;
  }
  return value;
}

export type AnonymizerValues = Record<string, unknown>;

/**
 * The single `anonymizer` covering LangSmith inputs, outputs, and metadata
 * on both create and update paths: drop row arrays, keep counts/columns,
 * then redactPII-scan the serialized remainder. Fail-closed: ANY failure
 * (stringify, redact, parse) yields `{}` so the client sends no payload
 * rather than a raw one.
 */
export function piiSafeProcessor(values: AnonymizerValues): AnonymizerValues {
  try {
    const stripped = stripRowArrays(values, new Set());
    const text = JSON.stringify(stripped);
    if (typeof text !== "string") return {};
    const { redacted } = redactPII(text);
    const parsed: unknown = JSON.parse(redacted);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AnonymizerValues;
  } catch {
    return {};
  }
}

export interface CreateTracerOptions {
  /** Stub transport for tests (never a live key or network in suites). */
  fetchImplementation?: typeof fetch;
  /** API key override; defaults to LANGSMITH_API_KEY from env. */
  apiKey?: string;
  /** API URL override; defaults to the client default. */
  apiUrl?: string;
  /** Project override; defaults to LANGSMITH_PROJECT from env. */
  projectName?: string;
}

const liveClients = new Set<Client>();

/**
 * Process-wide client cache (one entry per apiKey/apiUrl/transport triple):
 * every tracer for the same LangSmith endpoint shares a single Client, so
 * per-run tracer construction cannot grow `liveClients` without bound. The
 * fetchImplementation is part of the key by reference so a test injecting a
 * different stub transport still gets its own client.
 */
const cachedClients: {
  apiKey: string;
  apiUrl: string | undefined;
  fetchImplementation: typeof fetch | undefined;
  client: Client;
}[] = [];

function getSharedClient(
  apiKey: string | undefined,
  apiUrl: string | undefined,
  fetchImplementation: typeof fetch | undefined,
): Client {
  const key = apiKey ?? "";
  const found = cachedClients.find(
    (entry) =>
      entry.apiKey === key &&
      entry.apiUrl === apiUrl &&
      entry.fetchImplementation === fetchImplementation,
  );
  if (found) return found.client;
  const client = new Client({
    apiKey,
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    anonymizer: piiSafeProcessor,
    omitTracedRuntimeInfo: true,
    ...(fetchImplementation !== undefined
      ? { fetchImplementation }
      : {}),
  });
  cachedClients.push({ apiKey: key, apiUrl, fetchImplementation, client });
  return client;
}

/**
 * Scrub a LangChain `serialized` model blob the SDK uploads WITHOUT
 * passing it through the client anonymizer: drop `kwargs.configuration`
 * structurally (ChatOpenAI embeds the live API key there in plaintext and
 * its `lc_secrets` aliasing does not cover it), then run the shared
 * piiSafeProcessor over the rest (covers fake-model canned responses and
 * any PII strings). Fail-closed to `{}`. No new redactor: structural drop
 * plus the shared redactPII/redactRow only.
 */
export function scrubSerialized(serialized: unknown): AnonymizerValues {
  try {
    if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) {
      return {};
    }
    const clone: AnonymizerValues = { ...(serialized as AnonymizerValues) };
    const kwargs = clone["kwargs"];
    if (typeof kwargs === "object" && kwargs !== null && !Array.isArray(kwargs)) {
      const kwargsClone: AnonymizerValues = { ...(kwargs as AnonymizerValues) };
      delete kwargsClone["configuration"];
      clone["kwargs"] = kwargsClone;
    }
    return piiSafeProcessor(clone);
  } catch {
    return {};
  }
}

/** Scrub run `events` entries (the SDK only strips streaming token kwargs). */
function scrubEvents(
  events: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(events)) return events;
  return events.map((event) =>
    typeof event === "object" && event !== null && !Array.isArray(event)
      ? piiSafeProcessor(event as AnonymizerValues)
      : event,
  );
}

type TracerRun = Parameters<LangChainTracer["onRunCreate"]>[0] & {
  serialized?: unknown;
  events?: unknown;
};

/**
 * LangChainTracer whose run TREES are scrubbed BEFORE the RunTree posts or
 * patches: the SDK anonymizer never sees `serialized` or `events`, so
 * without this override the model blob (live API key, fake responses,
 * canary text) uploads raw. Note the `run` argument to onRunCreate is a
 * converted plain copy — the post reads the tree in `runTreeMap`, so the
 * scrub targets `getRun(id)`. Keeps the inherited handler name
 * "langchain_tracer" so bare env auto-tracing stays suppressed. The
 * `copyWithTracingConfig` override below keeps this scrub alive across the
 * per-invoke tracer copy chat models always build (they pass
 * `tracerInheritableMetadata`).
 */
export class PiiSafeLangChainTracer extends LangChainTracer {
  override async onRunCreate(run: TracerRun): Promise<void> {
    this.scrubTree(run.id);
    await super.onRunCreate(run as Parameters<LangChainTracer["onRunCreate"]>[0]);
  }

  override async onRunUpdate(run: TracerRun): Promise<void> {
    this.scrubTree(run.id);
    await super.onRunUpdate(run as Parameters<LangChainTracer["onRunUpdate"]>[0]);
  }

  private scrubTree(id: string): void {
    const tree = this.getRun(id) as unknown as
      | { serialized?: unknown; events?: unknown }
      | undefined;
    if (!tree) return;
    try {
      tree.serialized = scrubSerialized(tree.serialized);
      if (Array.isArray(tree.events)) {
        tree.events = scrubEvents(
          tree.events as Record<string, unknown>[],
        );
      }
    } catch {
      tree.serialized = {};
    }
  }

  /**
   * Preserve the scrub across LangChain's per-invoke tracer copy: chat
   * models always pass `tracerInheritableMetadata`, which rebuilds the
   * handler via this method — the base version hardcodes a base
   * `LangChainTracer` and would silently drop the override above for
   * every model.invoke. Merge semantics mirror the base exactly; only
   * the constructed class differs.
   */
  override copyWithTracingConfig(opts: {
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): PiiSafeLangChainTracer {
    let mergedMetadata: Record<string, unknown> | undefined;
    if (opts.metadata === undefined) {
      mergedMetadata = this.tracingMetadata ? { ...this.tracingMetadata } : undefined;
    } else if (this.tracingMetadata === undefined) {
      mergedMetadata = { ...opts.metadata };
    } else {
      mergedMetadata = { ...this.tracingMetadata };
      for (const [key, value] of Object.entries(opts.metadata)) {
        if (
          !Object.hasOwn(mergedMetadata, key) ||
          OVERRIDABLE_LANGSMITH_INHERITABLE_METADATA_KEYS.has(key)
        ) {
          mergedMetadata[key] = value;
        }
      }
    }
    const mergedTags = opts.tags
      ? Array.from(new Set([...this.tracingTags, ...opts.tags]))
      : [...this.tracingTags];
    const copied = new PiiSafeLangChainTracer({
      ...this.fields,
      metadata: mergedMetadata,
      tags: mergedTags,
    });
    copied.runMap = this.runMap;
    copied.runTreeMap = this.runTreeMap;
    return copied;
  }
}

/**
 * Build our anonymizing tracer, or `undefined` when the three-var gate is
 * closed (callers pass `callbacks: tracer ? [tracer] : undefined`). The
 * client sets `omitTracedRuntimeInfo` as defense in depth. The underlying
 * Client is shared per process (one per endpoint/transport), so every
 * created client is tracked and `flushLangSmith` can drain the tail.
 */
export function createLangSmithTracer(
  env: NodeJS.ProcessEnv = process.env,
  opts: CreateTracerOptions = {},
): PiiSafeLangChainTracer | undefined {
  if (!isLangSmithEnabled(env)) return undefined;
  const client = getSharedClient(
    opts.apiKey ?? env["LANGSMITH_API_KEY"],
    opts.apiUrl,
    opts.fetchImplementation,
  );
  liveClients.add(client);
  return new PiiSafeLangChainTracer({
    client,
    projectName:
      opts.projectName ?? env["LANGSMITH_PROJECT"] ?? LANGSMITH_PROJECT_DEFAULT,
  });
}

/**
 * Await every tracked client's pending batches. Call after each served run
 * and on server shutdown — auto-batching otherwise loses the tail on exit.
 * The drain never rejects (a failed tail must not fail the run) and accepts
 * a timeout bound: late batches are abandoned, never awaited unbounded.
 */
export async function flushLangSmith(
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const pending = (async (): Promise<void> => {
    try {
      await Promise.all(
        [...liveClients].map((client) => client.awaitPendingTraceBatches()),
      );
    } catch {
      // Swallowed: flush is best-effort on every path that calls it.
    }
  })();
  if (opts.timeoutMs === undefined) {
    await pending;
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), opts.timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test seam: drop tracked clients so suites stay isolated. */
export function resetLangSmithForTests(): void {
  liveClients.clear();
  cachedClients.length = 0;
}

/** Test seam: number of tracked clients (proves the per-process sharing). */
export function langSmithClientCountForTests(): number {
  return liveClients.size;
}

/** Run identity attached to every traced invoke for UI filtering (D-05). */
export interface LangSmithRunMeta {
  runId: string;
  threadId: string;
  userId: string;
  role: string;
  ucId: string;
  /** Column names only — never values. */
  maskedColumns?: string[];
}

export interface LangSmithRunConfig {
  /** UUID equal to the JSONL runId: one logical run, one root run. */
  runId: string;
  callbacks: LangChainTracer[];
  tags: string[];
  metadata: Record<string, unknown>;
}

/**
 * RunnableConfig fragment for ask AND resume: the same shape on both, so
 * one logical run stays correlatable by threadId metadata. Pass
 * `callbacks` explicitly so the bare env auto-tracer is suppressed.
 */
export function buildLangSmithRunConfig(
  tracer: LangChainTracer,
  meta: LangSmithRunMeta,
): LangSmithRunConfig {
  return {
    runId: meta.runId,
    callbacks: [tracer],
    tags: ["se373", `uc:${meta.ucId === "" ? "tracer" : meta.ucId}`],
    metadata: {
      runId: meta.runId,
      threadId: meta.threadId,
      userId: meta.userId,
      role: meta.role,
      ucId: meta.ucId,
      maskedColumns: [...(meta.maskedColumns ?? [])],
    },
  };
}
