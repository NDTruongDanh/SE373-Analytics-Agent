import { Client } from "langsmith";
import {
  LangChainTracer,
  OVERRIDABLE_LANGSMITH_INHERITABLE_METADATA_KEYS,
} from "@langchain/core/tracers/tracer_langchain";
import { redactPII, redactRow } from "@shared/access-policy";
import { estimateCostBreakdownUsd } from "./pricing.js";

export const LANGSMITH_PROJECT_DEFAULT = "se373-analytics-agent";

/** Scrub all four LangChain/LangGraph env flags so un-anonymized auto-tracing cannot fire in-process. */
export const LANGSMITH_ENV_FLAGS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

export function scrubLangSmithEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const flag of LANGSMITH_ENV_FLAGS) {
    delete env[flag];
  }
}

export function isLangSmithEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env["LANGSMITH_TRACING"] === "true" &&
    (env["LANGSMITH_API_KEY"] ?? "").length > 0 &&
    (env["LANGSMITH_PROJECT"] ?? "").length > 0
  );
}

const ROW_ARRAY_KEYS = new Set([
  "rows",
  "resultPreview",
  "preview",
  "resultRows",
  "sampleRows",
]);

/** Deep-clone without mutating input; circular refs collapse to "[Circular]" so JSON.stringify cannot throw. */
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
    // Redact string fields per object; piiSafeProcessor's JSON scan covers nested array strings.
    redactRow(clone);
    return clone;
  }
  return value;
}

export type AnonymizerValues = Record<string, unknown>;

/** Fail-closed LangSmith anonymizer: drops row arrays, runs redactPII, and returns {} on any failure. */
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
  fetchImplementation?: typeof fetch;
  apiKey?: string;
  apiUrl?: string;
  projectName?: string;
}

const liveClients = new Set<Client>();

/** Keyed by endpoint and fetchImplementation so shared clients avoid unbounded growth while isolating test stubs. */
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

/** SDK uploads serialized without the client anonymizer; strip kwargs.configuration (plaintext API key) and redact fail-closed to {}. */
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

interface LlmRunLike {
  outputs?: { generations?: unknown };
  extra?: { metadata?: Record<string, unknown> };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function llmRunModel(run: LlmRunLike): string | undefined {
  const batches = run.outputs?.generations;
  if (Array.isArray(batches)) {
    for (const batch of batches) {
      if (!Array.isArray(batch)) continue;
      for (const generation of batch) {
        const meta = asObject(asObject(asObject(generation)?.["message"])?.["response_metadata"]);
        for (const key of ["model", "model_name"]) {
          const value = meta?.[key];
          if (typeof value === "string" && value.length > 0) return value;
        }
      }
    }
  }
  const lsModel = run.extra?.metadata?.["ls_model_name"];
  return typeof lsModel === "string" && lsModel.length > 0 ? lsModel : undefined;
}

export function attachUsageCost(run: LlmRunLike): void {
  const usage = asObject(run.extra?.metadata?.["usage_metadata"]);
  if (usage === undefined) return;
  const input = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
  const output = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
  const cost = estimateCostBreakdownUsd(llmRunModel(run), input, output);
  if (!cost.pricingKnown) return;
  usage["input_cost"] = cost.inputCostUsd;
  usage["output_cost"] = cost.outputCostUsd;
  usage["total_cost"] = cost.inputCostUsd + cost.outputCostUsd;
}

type TracerRun = Parameters<LangChainTracer["onRunCreate"]>[0] & {
  serialized?: unknown;
  events?: unknown;
};

/**
 * Scrubs runTreeMap entries (SDK anonymizer skips serialized/events, and onRunCreate receives a copy);
 * keeps handler name "langchain_tracer" so env auto-tracing stays suppressed.
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

  /** Populate usage_metadata cost fields from local pricing because LangSmith lacks pricing for our custom models. */
  override onLLMEnd(run: Parameters<LangChainTracer["onLLMEnd"]>[0]): void {
    super.onLLMEnd(run);
    try {
      attachUsageCost(run as unknown as LlmRunLike);
    } catch {
      // Cost is display-only; never fail the model call over it.
    }
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

  /** Base copyWithTracingConfig hardcodes LangChainTracer and would silently drop our scrub overrides on model.invoke. */
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

/** Drain pending auto-batched traces before exit; never rejects so tail errors cannot fail served runs. */
export async function flushLangSmith(
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const pending = (async (): Promise<void> => {
    try {
      await Promise.all(
        [...liveClients].map((client) => client.awaitPendingTraceBatches()),
      );
    } catch {
      /* flush is best-effort */
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

export function resetLangSmithForTests(): void {
  liveClients.clear();
  cachedClients.length = 0;
}

export function langSmithClientCountForTests(): number {
  return liveClients.size;
}

export interface LangSmithRunMeta {
  runId: string;
  threadId: string;
  userId: string;
  role: string;
  route: string;
  /** Column names only — never values. */
  maskedColumns?: string[];
}

export interface LangSmithRunConfig {
  runId: string;
  callbacks: LangChainTracer[];
  tags: string[];
  metadata: Record<string, unknown>;
}

/** Explicit callbacks suppress the bare env auto-tracer; threadId metadata correlates ask and resume. */
export function buildLangSmithRunConfig(
  tracer: LangChainTracer,
  meta: LangSmithRunMeta,
): LangSmithRunConfig {
  return {
    runId: meta.runId,
    callbacks: [tracer],
    tags: ["se373", `route:${meta.route}`],
    metadata: {
      runId: meta.runId,
      threadId: meta.threadId,
      userId: meta.userId,
      role: meta.role,
      route: meta.route,
      maskedColumns: [...(meta.maskedColumns ?? [])],
    },
  };
}
