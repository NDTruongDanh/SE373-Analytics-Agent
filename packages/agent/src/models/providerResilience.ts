import { createHash } from "node:crypto";

export interface SemanticCacheContext {
  analysisState: unknown;
  semanticChunks: readonly unknown[];
  role: string;
  /** `null` is the explicit full-row scope; `undefined` disables caching. */
  rowScope: unknown;
}

export function createSemanticCacheContext(args: {
  analysisState: unknown;
  semanticChunks: readonly unknown[];
  role: string | null | undefined;
  rowScope: unknown;
}): SemanticCacheContext | undefined {
  if (!args.role || args.rowScope === undefined) return undefined;
  return {
    analysisState: args.analysisState,
    semanticChunks: args.semanticChunks,
    role: args.role,
    rowScope: args.rowScope,
  };
}

export interface SecondaryProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ProviderFetchOptions {
  primaryBaseURL: string;
  secondary?: SecondaryProviderConfig;
  cacheContext?: SemanticCacheContext;
  opencodeSessionId?: () => string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const CIRCUIT_FAILURE_LIMIT = 3;
const CIRCUIT_RESET_MS = 30_000;
const SECONDARY_ATTEMPT_TIMEOUT_MS = 300_000;
const CACHE_MAX_ENTRIES = 256;
const CACHE_MAX_BYTES = 16_000_000;
const CACHE_MAX_RESPONSE_CHARS = 500_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

interface CachedResponse {
  text: string;
  status: number;
  statusText: string;
  contentType: string | null;
  expiresAt: number;
  size: number;
}

const semanticResponseCache = new Map<string, CachedResponse>();
let semanticResponseCacheBytes = 0;

type CircuitState = "closed" | "open" | "half_open";

class ProviderCircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(private readonly now: () => number) {}

  shouldUsePrimary(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.now() - this.openedAt < CIRCUIT_RESET_MS) return false;
      this.state = "half_open";
      this.probeInFlight = false;
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordPrimarySuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  recordPrimaryFailure(): void {
    if (this.state === "half_open") {
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_LIMIT) this.open();
  }

  cancelProbe(): void {
    if (this.state === "half_open") {
      this.state = "open";
      this.probeInFlight = false;
    }
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.probeInFlight = false;
  }
}

const circuitBreakers = new Map<string, ProviderCircuitBreaker>();

function stableValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.normalize("NFC").replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function exactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exactValue);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, exactValue(record[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cacheTtlMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.AGENT_MODEL_SEMANTIC_CACHE_TTL_MS);
  if (!Number.isFinite(configured)) return DEFAULT_CACHE_TTL_MS;
  return Math.max(0, Math.min(300_000, Math.floor(configured)));
}

function cacheKeyFor(
  bodyText: string,
  context: SemanticCacheContext,
  providerSignature: string,
): string | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>)["messages"]) ||
    (body as Record<string, unknown>)["stream"] === true
  ) {
    return null;
  }
  const normalizedDimensions = stableJson({
    analysisState: context.analysisState,
    corpusVersion: sha256(stableJson(context.semanticChunks)),
    request: sha256(bodyText),
    providerSignature,
  });
  // Preserve authorization values byte-for-byte; whitespace in a row-scope
  // value may distinguish two different database predicates.
  return sha256(
    `${normalizedDimensions}\u0000${JSON.stringify(context.role)}\u0000${JSON.stringify(exactValue(context.rowScope))}`,
  );
}

function getCachedResponse(key: string, now: number): Response | null {
  const cached = semanticResponseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    deleteCachedResponse(key);
    return null;
  }
  semanticResponseCache.delete(key);
  semanticResponseCache.set(key, cached);
  const headers = cached.contentType ? { "content-type": cached.contentType } : undefined;
  return new Response(cached.text, {
    status: cached.status,
    statusText: cached.statusText,
    ...(headers ? { headers } : {}),
  });
}

async function rememberResponse(
  key: string | null,
  response: Response,
  ttlMs: number,
  now: () => number,
): Promise<void> {
  if (!key || ttlMs <= 0 || !response.ok || response.status === 204 || response.status === 205) return;
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > CACHE_MAX_RESPONSE_CHARS) return;
  const text = await response.clone().text();
  if (text.length > CACHE_MAX_RESPONSE_CHARS) return;
  deleteCachedResponse(key);
  semanticResponseCache.set(key, {
    text,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    expiresAt: now() + ttlMs,
    size: text.length,
  });
  semanticResponseCacheBytes += text.length;
  while (
    semanticResponseCache.size > CACHE_MAX_ENTRIES ||
    semanticResponseCacheBytes > CACHE_MAX_BYTES
  ) {
    const oldest = semanticResponseCache.keys().next().value;
    if (oldest === undefined) break;
    deleteCachedResponse(oldest);
  }
}

function deleteCachedResponse(key: string): void {
  const cached = semanticResponseCache.get(key);
  if (!cached) return;
  semanticResponseCacheBytes = Math.max(0, semanticResponseCacheBytes - cached.size);
  semanticResponseCache.delete(key);
}

function resolvedBaseURL(value: string): URL {
  return new URL(value || "https://api.openai.com/v1");
}

function secondaryURLFor(requestURL: string, primaryBaseURL: string, secondaryBaseURL: string): string {
  const request = new URL(requestURL);
  const primary = resolvedBaseURL(primaryBaseURL);
  const secondary = resolvedBaseURL(secondaryBaseURL);
  const primaryPath = primary.pathname.replace(/\/+$/, "");
  const suffix = request.pathname === primaryPath
    ? "/"
    : request.pathname.startsWith(`${primaryPath}/`)
    ? request.pathname.slice(primaryPath.length)
    : request.pathname;
  secondary.pathname = `${secondary.pathname.replace(/\/+$/, "")}${suffix}` || "/";
  secondary.search = request.search;
  return secondary.toString();
}

function bodyWithModel(bodyText: string | null, model: string): string | undefined {
  if (bodyText === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), model });
    }
  } catch {
    // Keep non-JSON provider bodies unchanged; the provider will report its own error.
  }
  return bodyText;
}

function isTimeoutError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  if (typeof error === "object" && error !== null && "cause" in error) {
    candidates.push((error as { cause?: unknown }).cause);
  }
  return candidates.some((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const record = candidate as { name?: unknown; message?: unknown; code?: unknown };
    return (
      (typeof record.name === "string" && /timeout/i.test(record.name)) ||
      (typeof record.message === "string" && /timed?\s*out|timeout/i.test(record.message)) ||
      (typeof record.code === "string" &&
        ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(record.code))
    );
  });
}

function isTimedOutRequest(request: Request, error: unknown): boolean {
  if (isTimeoutError(error) || isTimeoutError(request.signal.reason)) return true;
  return isSdkTimeoutAbort(request);
}

function isSdkTimeoutAbort(request: Request): boolean {
  const reason = request.signal.reason;
  return Boolean(
    request.signal.aborted &&
      typeof reason === "object" &&
      reason !== null &&
      "name" in reason &&
      (reason as { name?: unknown }).name === "AbortError" &&
      !(reason instanceof Error && /model call aborted/i.test(reason.message)),
  );
}

function createSecondaryRequest(
  request: Request,
  bodyText: string | null,
  primaryBaseURL: string,
  secondary: SecondaryProviderConfig,
  opencodeSessionId?: () => string,
  signal: AbortSignal = request.signal,
): Request {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${secondary.apiKey}`);
  headers.delete("x-opencode-session");
  if (secondary.baseURL && isOpencodeGoUrl(secondary.baseURL)) {
    if (opencodeSessionId) headers.set("x-opencode-session", opencodeSessionId());
  }
  const body = bodyWithModel(bodyText, secondary.model);
  return new Request(secondaryURLFor(request.url, primaryBaseURL, secondary.baseURL), {
    method: request.method,
    headers,
    signal,
    ...(body !== undefined && request.method !== "GET" && request.method !== "HEAD"
      ? { body }
      : {}),
  });
}

export function createProviderFetch(options: ProviderFetchOptions): typeof fetch {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const secondary = options.secondary;
  const cacheContext = options.cacheContext;
  const cacheEnabled = Boolean(
    cacheContext &&
      cacheContext.role.trim().length > 0 &&
      cacheContext.rowScope !== undefined &&
      Object.hasOwn(cacheContext, "rowScope"),
  );
  const ttlMs = cacheTtlMs(env);
  const primaryURL = resolvedBaseURL(options.primaryBaseURL).toString().replace(/\/$/, "");
  const secondaryURL = secondary
    ? resolvedBaseURL(secondary.baseURL).toString().replace(/\/$/, "")
    : "";
  const providerSignature = sha256(`${primaryURL}|${secondaryURL}|${secondary?.model ?? ""}`);
  const breakerKey = `${primaryURL}|${secondaryURL}`;
  let breaker = circuitBreakers.get(breakerKey);
  if (secondary && !breaker) {
    breaker = new ProviderCircuitBreaker(now);
    circuitBreakers.set(breakerKey, breaker);
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const bodyText = request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.clone().text();
    const cacheKey = cacheEnabled && cacheContext && bodyText !== null
      ? cacheKeyFor(bodyText, cacheContext, providerSignature)
      : null;
    if (cacheKey) {
      const cached = getCachedResponse(cacheKey, now());
      if (cached) return cached;
    }

    const usePrimary = !secondary || !breaker || breaker.shouldUsePrimary();
    if (!usePrimary && secondary) {
      const response = await fetchImpl(
        createSecondaryRequest(request, bodyText, options.primaryBaseURL, secondary, options.opencodeSessionId),
      );
      await rememberResponse(cacheKey, response, ttlMs, now);
      return response;
    }

    let primaryResponse: Response;
    try {
      primaryResponse = await fetchImpl(request.clone());
    } catch (error) {
      const timeout = isTimedOutRequest(request, error);
      if (breaker && timeout) breaker.recordPrimaryFailure();
      const sdkTimedOut = isSdkTimeoutAbort(request);
      if (!secondary || (request.signal.aborted && !sdkTimedOut)) {
        breaker?.cancelProbe();
        throw error;
      }
      // The SDK's own timeout aborts its composite signal without a reason.
      // A fresh signal allows the secondary attempt; run-deadline timeouts
      // retain their explicit TimeoutError reason and never extend a run.
      const secondarySignal = sdkTimedOut
        ? AbortSignal.timeout(SECONDARY_ATTEMPT_TIMEOUT_MS)
        : request.signal;
      if (breaker && !timeout) breaker.cancelProbe();
      const response = await fetchImpl(
        createSecondaryRequest(request, bodyText, options.primaryBaseURL, secondary, options.opencodeSessionId, secondarySignal),
      );
      await rememberResponse(cacheKey, response, ttlMs, now);
      return response;
    }

    if ((primaryResponse.status === 408 || primaryResponse.status >= 500) && secondary && breaker) {
      breaker.recordPrimaryFailure();
      const response = await fetchImpl(
        createSecondaryRequest(request, bodyText, options.primaryBaseURL, secondary, options.opencodeSessionId),
      );
      await rememberResponse(cacheKey, response, ttlMs, now);
      return response;
    }
    if (breaker) breaker.recordPrimarySuccess();
    await rememberResponse(cacheKey, primaryResponse, ttlMs, now);
    return primaryResponse;
  };
}

export function resetProviderResilienceState(): void {
  semanticResponseCache.clear();
  semanticResponseCacheBytes = 0;
  circuitBreakers.clear();
}

function isOpencodeGoUrl(url: string): boolean {
  return url.includes("opencode.ai") || url.includes("inference/go") || url.includes("zen/go");
}
