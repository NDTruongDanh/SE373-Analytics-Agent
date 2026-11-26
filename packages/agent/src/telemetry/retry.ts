import { dbToolError, type DbToolError } from "@shared/contracts";
import {
  checkBudget,
  recordLlmCall,
  type BudgetState,
  type BudgetTripReason,
} from "../queryExecutor/budgets.js";

export const MODEL_RETRY_DEFAULTS = {
  maxRetries: 3,
  baseMs: 1000,
  maxWaitMs: 30000,
} as const;

export const MODEL_RETRY_BOUNDS = {
  maxRetriesMin: 0,
  maxRetriesMax: 10,
  baseMsMin: 50,
  baseMsMax: 60000,
  maxWaitMsMin: 0,
  maxWaitMsMax: 120000,
} as const;

export interface ModelRetryConfig {
  maxRetries: number;
  baseMs: number;
  maxWaitMs: number;
}

export interface ModelRetryOverrides {
  maxRetries?: number;
  baseMs?: number;
  maxWaitMs?: number;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  if (value < min) return value < 0 ? fallback : min;
  return Math.min(max, value);
}

export function resolveModelRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ModelRetryOverrides = {},
): ModelRetryConfig {
  const maxRetries =
    typeof overrides.maxRetries === "number" &&
    Number.isFinite(overrides.maxRetries) &&
    Number.isInteger(overrides.maxRetries) &&
    overrides.maxRetries >= 0
      ? Math.min(MODEL_RETRY_BOUNDS.maxRetriesMax, overrides.maxRetries)
      : parseBoundedInt(
          env["AGENT_MODEL_MAX_RETRIES"],
          MODEL_RETRY_DEFAULTS.maxRetries,
          MODEL_RETRY_BOUNDS.maxRetriesMin,
          MODEL_RETRY_BOUNDS.maxRetriesMax,
        );

  const baseMs =
    typeof overrides.baseMs === "number" &&
    Number.isFinite(overrides.baseMs) &&
    overrides.baseMs >= 0
      ? Math.min(MODEL_RETRY_BOUNDS.baseMsMax, Math.floor(overrides.baseMs))
      : parseBoundedInt(
          env["AGENT_MODEL_RETRY_BASE_MS"],
          MODEL_RETRY_DEFAULTS.baseMs,
          MODEL_RETRY_BOUNDS.baseMsMin,
          MODEL_RETRY_BOUNDS.baseMsMax,
        );

  const maxWaitMs =
    typeof overrides.maxWaitMs === "number" &&
    Number.isFinite(overrides.maxWaitMs) &&
    overrides.maxWaitMs >= 0
      ? Math.min(MODEL_RETRY_BOUNDS.maxWaitMsMax, Math.floor(overrides.maxWaitMs))
      : parseBoundedInt(
          env["AGENT_MODEL_RETRY_MAX_WAIT_MS"],
          MODEL_RETRY_DEFAULTS.maxWaitMs,
          MODEL_RETRY_BOUNDS.maxWaitMsMin,
          MODEL_RETRY_BOUNDS.maxWaitMsMax,
        );

  return { maxRetries, baseMs, maxWaitMs };
}

export type ModelErrorKind = "rate_limit" | "non_retryable";

export interface ModelErrorClassification {
  kind: ModelErrorKind;
  retryable: boolean;
  code?: "RATE_LIMITED";
  status?: number;
  retryAfterMs?: number;
  reason: string;
}

const NON_RETRYABLE_HTTP_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 407, 409, 413, 422,
]);

const NON_RETRYABLE_LC_CODES = new Set([
  "MODEL_AUTHENTICATION",
  "MODEL_NOT_FOUND",
  "INVALID_TOOL_RESULTS",
  "CONTEXT_OVERFLOW",
  "OUTPUT_PARSING_FAILURE",
]);

const NON_RETRYABLE_DB_CODES = new Set([
  "UNAUTHORIZED",
  "SCOPE_DENIED",
  "INVALID_PARAMS",
  "INVALID_SQL",
  "FORBIDDEN_STATEMENT",
  "FORBIDDEN_FUNCTION",
  "UNKNOWN_TABLE",
  "SENSITIVE_COLUMN_DENIED",
  "SQL_EXECUTION_ERROR",
  "TIMEOUT",
  "INTERNAL_ERROR",
]);

const QUOTA_EXHAUSTED_PATTERNS = [
  /insufficient[_ -]?quota/i,
  /exceeded (?:your|the current|the available).+quota/i,
  /usage quota/i,
  /quota (?:has been )?exhausted/i,
  /\bbilling\b/i,
  /credit balance/i,
  /out of credits/i,
];

const RATE_LIMIT_TEXT_RE =
  /(?:^\s*429(?:\b|$)|\bHTTP\s*429\b|\bstatus(?:\s+code)?\s*[:=]?\s*429\b|\b429\s+too\s+many\s+requests\b|\btoo\s+many\s+requests\b|\brate[_ -]?limit(?:ed|ing| exceeded| reached)?\b|\btokens? per minute\b|\brequests? per minute\b|\bTPM\b|\bRPM\b)/i;

const OVERLOAD_503_TEXT_RE =
  /(?:^\s*503(?:\b|$)|\bHTTP\s*503\b|\bstatus(?:\s+code)?\s*[:=]?\s*503\b|\b503\s+service\s+unavailable\b|\bservice\s+unavailable\b|\boverloaded_error\b|\b(?:engine|server|model|provider)\s+(?:is\s+)?(?:currently\s+)?overloaded\b)/i;

// Message hints require an explicit unit so ambiguous unitless text (e.g.
// "try again in 5") never guesses ms vs s vs m.
const COMPOUND_HINT_RE =
  /(?:try again in|retry(?: after| in)?|wait)\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i;

const SINGLE_HINT_RE =
  /(?:try again in|retry(?: after| in)?|wait)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectErrorChain(error: unknown, maxDepth = 4): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let i = 0; i < maxDepth; i += 1) {
    const rec = asRecord(current);
    if (!rec || seen.has(rec)) break;
    seen.add(rec);
    out.push(rec);
    current = rec["cause"] ?? rec["originalError"] ?? rec["error"];
  }
  return out;
}

function readHttpStatus(chain: readonly Record<string, unknown>[]): number | undefined {
  for (const node of chain) {
    for (const key of ["status", "statusCode", "httpStatus"] as const) {
      const val = node[key];
      if (typeof val === "number" && Number.isInteger(val) && val >= 100 && val <= 599) {
        return val;
      }
    }
    const response = asRecord(node["response"]);
    if (response) {
      for (const key of ["status", "statusCode"] as const) {
        const val = response[key];
        if (typeof val === "number" && Number.isInteger(val) && val >= 100 && val <= 599) {
          return val;
        }
      }
    }
  }
  return undefined;
}

function readStringProp(
  chain: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const node of chain) {
    const val = node[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}

function readHeaderValue(headers: unknown, targetName: string): string | undefined {
  const rec = asRecord(headers);
  if (!rec) return undefined;
  const targetLower = targetName.toLowerCase();
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      const val = (headers as { get(name: string): string | null }).get(targetName);
      if (typeof val === "string" && val.trim().length > 0) return val;
    } catch {
      // Fall back to own-property scan below if a custom object throws on .get().
    }
  }
  for (const [key, raw] of Object.entries(rec)) {
    if (key.toLowerCase() !== targetLower) continue;
    if (typeof raw === "string" && raw.trim().length > 0) return raw;
    if (Array.isArray(raw)) {
      const first = raw.find(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      if (first !== undefined) return first;
    }
  }
  return undefined;
}

function findHeader(
  chain: readonly Record<string, unknown>[],
  targetName: string,
): string | undefined {
  for (const node of chain) {
    const direct = readHeaderValue(node["headers"], targetName);
    if (direct !== undefined) return direct;
    const response = asRecord(node["response"]);
    if (response) {
      const respHeader = readHeaderValue(response["headers"], targetName);
      if (respHeader !== undefined) return respHeader;
    }
  }
  return undefined;
}

/** Past HTTP-dates return 0 so exponential backoff applies; invalid or negative values return undefined. */
export function parseRetryAfterHeaderMs(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof headerValue !== "string") return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.ceil(seconds * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return undefined;
  const delta = parsedDate - nowMs;
  return delta > 0 ? Math.ceil(delta) : 0;
}

function parseRetryAfterMsHeader(headerValue: string | null | undefined): number | undefined {
  if (typeof headerValue !== "string") return undefined;
  const trimmed = headerValue.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const ms = Number(trimmed);
  return Number.isFinite(ms) && ms >= 0 ? Math.ceil(ms) : undefined;
}

function unitMultiplierMs(unit: string): number | undefined {
  const lower = unit.toLowerCase();
  if (lower === "ms" || lower.startsWith("millisecond")) return 1;
  if (lower === "s" || lower.startsWith("sec")) return 1000;
  if (lower === "m" || lower.startsWith("min")) return 60_000;
  if (lower === "h" || lower.startsWith("hr") || lower.startsWith("hour")) return 3_600_000;
  return undefined;
}

export function parseRetryAfterMessageMs(message: string | null | undefined): number | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;
  const compound = COMPOUND_HINT_RE.exec(message);
  if (compound) {
    const mins = Number(compound[1]);
    const secs = Number(compound[2]);
    if (Number.isFinite(mins) && Number.isFinite(secs) && mins >= 0 && secs >= 0) {
      return Math.ceil(mins * 60_000 + secs * 1000);
    }
  }
  const single = SINGLE_HINT_RE.exec(message);
  if (!single) return undefined;
  const value = Number(single[1]);
  const multiplier = unitMultiplierMs(single[2] ?? "");
  if (!Number.isFinite(value) || value < 0 || multiplier === undefined) return undefined;
  return Math.ceil(value * multiplier);
}

function extractRetryAfterMs(
  chain: readonly Record<string, unknown>[],
  nowMs: number,
): number | undefined {
  const candidates: number[] = [];
  const headerMs = parseRetryAfterMsHeader(findHeader(chain, "retry-after-ms"));
  if (headerMs !== undefined) candidates.push(headerMs);
  const headerRetryAfter = parseRetryAfterHeaderMs(findHeader(chain, "retry-after"), nowMs);
  if (headerRetryAfter !== undefined) candidates.push(headerRetryAfter);
  for (const node of chain) {
    const directMs = node["retryAfterMs"];
    if (typeof directMs === "number" && Number.isFinite(directMs) && directMs >= 0) {
      candidates.push(Math.ceil(directMs));
    }
    const msg = node["message"];
    if (typeof msg === "string") {
      const parsed = parseRetryAfterMessageMs(msg);
      if (parsed !== undefined) candidates.push(parsed);
    }
  }
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates);
}

function hasZodIssues(error: unknown): boolean {
  const rec = asRecord(error);
  return Boolean(rec && rec["name"] === "ZodError" && Array.isArray(rec["issues"]));
}

function isNonRetryableShape(
  error: unknown,
  chain: readonly Record<string, unknown>[],
): string | undefined {
  if (error instanceof SyntaxError) return "syntax_error";
  if (hasZodIssues(error)) return "zod_error";
  const name = readStringProp(chain, "name");
  if (name === "AbortError") return "aborted";
  if (name === "TimeoutError") return "timeout";
  if (name === "ContextOverflowError") return "context_overflow";
  const lcCode = readStringProp(chain, "lc_error_code");
  if (lcCode && NON_RETRYABLE_LC_CODES.has(lcCode)) {
    return lcCode.toLowerCase();
  }
  const code = readStringProp(chain, "code");
  if (code && NON_RETRYABLE_DB_CODES.has(code)) {
    return `contract_${code.toLowerCase()}`;
  }
  const msg = readStringProp(chain, "message") ?? "";
  if (name === "OutputParserException" || /not valid json/i.test(msg)) {
    return "output_parse_error";
  }
  return undefined;
}

export function classifyModelError(
  error: unknown,
  nowMs: number = Date.now(),
): ModelErrorClassification {
  if (error instanceof ModelRetryError) {
    return {
      kind: "rate_limit",
      retryable: false,
      code: "RATE_LIMITED",
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      reason: error.reason,
    };
  }

  const chain = collectErrorChain(error);
  const nonRetryableReason = isNonRetryableShape(error, chain);
  if (nonRetryableReason !== undefined) {
    return {
      kind: "non_retryable",
      retryable: false,
      reason: nonRetryableReason,
    };
  }

  const status = readHttpStatus(chain);
  if (status !== undefined && NON_RETRYABLE_HTTP_STATUSES.has(status)) {
    return {
      kind: "non_retryable",
      retryable: false,
      status,
      reason: `http_${status}`,
    };
  }

  const lcCode = readStringProp(chain, "lc_error_code");
  const code = readStringProp(chain, "code");
  const name = readStringProp(chain, "name");
  const allMessages = chain
    .map((node) => node["message"])
    .filter((m): m is string => typeof m === "string")
    .join(" ");

  if (code === "insufficient_quota" || QUOTA_EXHAUSTED_PATTERNS.some((re) => re.test(allMessages))) {
    return {
      kind: "rate_limit",
      retryable: false,
      code: "RATE_LIMITED",
      ...(status !== undefined ? { status } : { status: 429 }),
      reason: "insufficient_quota",
    };
  }

  if (
    status === 429 ||
    lcCode === "MODEL_RATE_LIMIT" ||
    code === "RATE_LIMITED" ||
    code === "rate_limit_exceeded" ||
    name === "RateLimitError" ||
    name === "RateLimitCapacityError"
  ) {
    const retryAfterMs = extractRetryAfterMs(chain, nowMs);
    return {
      kind: "rate_limit",
      retryable: true,
      code: "RATE_LIMITED",
      ...(status !== undefined ? { status } : { status: 429 }),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      reason: "rate_limit_429",
    };
  }

  if (status === 503) {
    const retryAfterMs = extractRetryAfterMs(chain, nowMs);
    return {
      kind: "rate_limit",
      retryable: true,
      code: "RATE_LIMITED",
      status: 503,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      reason: "overload_503",
    };
  }

  if (status === undefined && allMessages.length > 0) {
    if (RATE_LIMIT_TEXT_RE.test(allMessages)) {
      const retryAfterMs = extractRetryAfterMs(chain, nowMs);
      return {
        kind: "rate_limit",
        retryable: true,
        code: "RATE_LIMITED",
        status: 429,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        reason: "rate_limit_429",
      };
    }
    if (OVERLOAD_503_TEXT_RE.test(allMessages)) {
      const retryAfterMs = extractRetryAfterMs(chain, nowMs);
      return {
        kind: "rate_limit",
        retryable: true,
        code: "RATE_LIMITED",
        status: 503,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        reason: "overload_503",
      };
    }
  }

  return {
    kind: "non_retryable",
    retryable: false,
    ...(status !== undefined ? { status } : {}),
    reason: "unclassified",
  };
}

export class ModelRetryError extends Error {
  readonly code = "RATE_LIMITED" as const;
  readonly retryable = true as const;
  readonly repairable = false as const;
  readonly status?: number;
  readonly attempts: number;
  readonly reason: string;
  readonly retryAfterMs?: number;
  readonly budgetTripped?: boolean;
  readonly tripReason?: BudgetTripReason;

  constructor(opts: {
    message: string;
    status?: number;
    attempts: number;
    reason: string;
    retryAfterMs?: number;
    budgetTripped?: boolean;
    tripReason?: BudgetTripReason;
  }) {
    super(opts.message);
    this.name = "ModelRetryError";
    this.status = opts.status;
    this.attempts = opts.attempts;
    this.reason = opts.reason;
    this.retryAfterMs = opts.retryAfterMs;
    this.budgetTripped = opts.budgetTripped;
    this.tripReason = opts.tripReason;
  }

  toDbToolError(): DbToolError {
    return dbToolError("RATE_LIMITED", this.message.slice(0, 500));
  }
}

export function isRateLimitFailure(error: unknown): boolean {
  if (error instanceof ModelRetryError) return true;
  return classifyModelError(error).code === "RATE_LIMITED";
}

export type ModelReaskReason =
  | { code: "syntax_error" | "zod_error" | "output_parse_error"; formatFailure: true }
  | { code: "provider_5xx"; formatFailure: false; status: number };

export function classifyModelReaskFailure(error: unknown): ModelReaskReason | null {
  if (error instanceof ModelRetryError) return null;
  const chain = collectErrorChain(error);
  const status = readHttpStatus(chain);
  if (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 408 ||
    status === 503
  ) {
    return null;
  }

  const cls = classifyModelError(error);
  if (cls.code === "RATE_LIMITED") return null;
  if (cls.reason === "aborted" || cls.reason === "timeout" || cls.reason === "context_overflow") {
    return null;
  }

  const shape = isNonRetryableShape(error, chain);
  if (shape === "syntax_error" || shape === "zod_error" || shape === "output_parse_error") {
    return { code: shape, formatFailure: true };
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { code: "provider_5xx", formatFailure: false, status };
  }
  return null;
}

export function isReaskableModelFailure(error: unknown): boolean {
  return classifyModelReaskFailure(error) !== null;
}

export function toModelDbToolError(
  error: unknown,
  prefix = "Model call failed",
): DbToolError {
  if (error instanceof ModelRetryError) {
    return error.toDbToolError();
  }
  const cls = classifyModelError(error);
  if (cls.code === "RATE_LIMITED") {
    const detail =
      cls.status !== undefined ? `provider HTTP ${cls.status}` : cls.reason;
    return dbToolError(
      "RATE_LIMITED",
      `RATE_LIMITED: ${prefix} (${detail})`.slice(0, 500),
    );
  }
  const raw = error instanceof Error ? error.message : String(error);
  return dbToolError("INTERNAL_ERROR", `${prefix}: ${raw}`.slice(0, 500));
}

export interface RetryDelayInput {
  retryIndex: number;
  retryAfterMs?: number;
  baseMs: number;
  maxWaitMs: number;
  deadlineMs?: number;
  nowMs: number;
  random?: () => number;
}

export type RetryDelayPlan =
  | { shouldRetry: true; delayMs: number }
  | {
      shouldRetry: false;
      stopReason:
        | "retry_after_exceeds_max_wait"
        | "retry_after_exceeds_deadline"
        | "deadline_exceeded";
    };

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value >= 1) return 0.999999;
  return value;
}

export function planRetryDelay(input: RetryDelayInput): RetryDelayPlan {
  const { retryIndex, retryAfterMs, baseMs, maxWaitMs, deadlineMs, nowMs } = input;
  if (retryAfterMs !== undefined && retryAfterMs > maxWaitMs) {
    return { shouldRetry: false, stopReason: "retry_after_exceeds_max_wait" };
  }

  let remainingMs: number | undefined;
  if (deadlineMs !== undefined && deadlineMs > 0) {
    remainingMs = deadlineMs - nowMs;
    if (remainingMs <= 0) {
      return { shouldRetry: false, stopReason: "deadline_exceeded" };
    }
    if (retryAfterMs !== undefined && retryAfterMs >= remainingMs) {
      return { shouldRetry: false, stopReason: "retry_after_exceeds_deadline" };
    }
  }

  const exponent = Math.max(0, retryIndex - 1);
  const rawExp = baseMs * 2 ** exponent;
  const cappedExp = Math.min(rawExp, maxWaitMs);
  const r = clamp01(input.random?.() ?? Math.random());
  const backoffMs = Math.round(cappedExp * (0.5 + 0.5 * r));
  const delayMs =
    retryAfterMs !== undefined ? Math.max(backoffMs, retryAfterMs) : backoffMs;

  if (remainingMs !== undefined && delayMs >= remainingMs) {
    return { shouldRetry: false, stopReason: "deadline_exceeded" };
  }
  return { shouldRetry: true, delayMs };
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : abortError("Aborted"),
    );
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason instanceof Error ? signal.reason : abortError("Aborted"),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function timeoutError(message: string): Error {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

export interface AttemptAbortHandle {
  controller: AbortController;
  abortFailure: Promise<never>;
  armIdle: () => void;
  cleanup: () => void;
}

export function createAttemptAbort(opts: {
  totalMs?: number;
  idleMs?: number;
  signal?: AbortSignal;
  idleMessage?: string;
  totalMessage?: string;
}): AttemptAbortHandle {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => {
    controller.abort(
      opts.signal?.reason instanceof Error
        ? opts.signal.reason
        : abortError("Model call aborted"),
    );
  };

  if (opts.signal?.aborted) {
    onExternalAbort();
  } else if (opts.signal) {
    opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const armIdle = () => {
    if (opts.idleMs === undefined) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort(
        timeoutError(
          opts.idleMessage ?? `Model stream stalled: no tokens for ${opts.idleMs}ms`,
        ),
      );
    }, opts.idleMs);
  };

  if (opts.totalMs !== undefined && Number.isFinite(opts.totalMs)) {
    const bound = Math.max(0, opts.totalMs);
    totalTimer = setTimeout(() => {
      controller.abort(
        timeoutError(opts.totalMessage ?? `Model call exceeded ${bound}ms`),
      );
    }, bound);
  }

  const abortFailure = new Promise<never>((_resolve, reject) => {
    const reason = () =>
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : timeoutError("Model call aborted");
    if (controller.signal.aborted) {
      reject(reason());
      return;
    }
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(reason());
      },
      { once: true },
    );
  });
  // Avoid unhandled rejections when the caller wins the race.
  abortFailure.catch(() => {});

  const cleanup = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  };

  return { controller, abortFailure, armIdle, cleanup };
}

export type RetrySpanEmit = (event: {
  node: string;
  type: string;
  durationMs: number;
  attempt?: number;
  payload?: unknown;
}) => string;

export interface RetryModelCallOptions {
  node: string;
  modelName?: string;
  config?: ModelRetryConfig;
  budget?: BudgetState;
  deadlineMs?: number;
  signal?: AbortSignal;
  emit?: RetrySpanEmit;
  outerAttempt?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RetryModelCallResult<T> {
  value: T;
  attempts: number;
  failedAttempts: number;
}

export interface RetryAttemptContext {
  attemptIndex: number;
  attemptNumber: number;
  remainingMs?: number;
  signal?: AbortSignal;
}

function buildRateLimitMessage(opts: {
  status?: number;
  attempts: number;
  reason: string;
  retryAfterMs?: number;
  maxWaitMs?: number;
}): string {
  const statusTag = opts.status !== undefined ? `HTTP ${opts.status}` : opts.reason;
  if (opts.reason === "retry_after_exceeds_max_wait" && opts.retryAfterMs !== undefined) {
    return `RATE_LIMITED: provider requested Retry-After ${opts.retryAfterMs}ms exceeding maxWaitMs (${opts.maxWaitMs ?? 0}ms) after ${opts.attempts} attempt(s)`;
  }
  if (
    opts.reason === "retry_after_exceeds_deadline" ||
    opts.reason === "deadline_exceeded"
  ) {
    return `RATE_LIMITED: stopped retrying (${statusTag}, ${opts.reason}) within run deadline after ${opts.attempts} attempt(s)`;
  }
  return `RATE_LIMITED: model provider rate limit or overload (${statusTag}) after ${opts.attempts} attempt(s)`;
}

export async function retryModelCall<T>(
  fn: (ctx: RetryAttemptContext) => Promise<T>,
  opts: RetryModelCallOptions,
): Promise<RetryModelCallResult<T>> {
  const now = opts.now ?? Date.now;
  const sleepFn = opts.sleep ?? sleepWithAbort;
  const cfg = opts.config ?? resolveModelRetryConfig();
  const effectiveDeadlineMs =
    opts.deadlineMs !== undefined && opts.deadlineMs > 0
      ? opts.deadlineMs
      : opts.budget?.deadlineMs !== undefined && opts.budget.deadlineMs > 0
        ? opts.budget.deadlineMs
        : undefined;

  if (opts.signal?.aborted) {
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : abortError("Model call aborted");
  }

  let lastRateLimitStatus: number | undefined;
  let lastRetryAfterMs: number | undefined;

  for (let retryAttempt = 0; ; retryAttempt += 1) {
    const attemptsSoFar = retryAttempt + 1;
    const spanAttempt = opts.outerAttempt ?? attemptsSoFar;

    if (opts.budget) {
      const check = checkBudget(opts.budget, now());
      if (check.tripped) {
        if (retryAttempt > 0) {
          throw new ModelRetryError({
            message: buildRateLimitMessage({
              status: lastRateLimitStatus,
              attempts: retryAttempt,
              reason:
                check.reason === "deadline"
                  ? "deadline_exceeded"
                  : `budget_${check.reason}`,
            }),
            status: lastRateLimitStatus,
            attempts: retryAttempt,
            reason:
              check.reason === "deadline"
                ? "deadline_exceeded"
                : `budget_${check.reason}`,
            retryAfterMs: lastRetryAfterMs,
            budgetTripped: true,
            tripReason: check.reason,
          });
        }
        throw new Error(`Run budget exceeded (${check.reason})`);
      }
    }

    const remainingMs =
      effectiveDeadlineMs !== undefined
        ? effectiveDeadlineMs - now()
        : undefined;
    if (remainingMs !== undefined && remainingMs <= 0) {
      if (retryAttempt > 0) {
        throw new ModelRetryError({
          message: buildRateLimitMessage({
            status: lastRateLimitStatus,
            attempts: retryAttempt,
            reason: "deadline_exceeded",
          }),
          status: lastRateLimitStatus,
          attempts: retryAttempt,
          reason: "deadline_exceeded",
          retryAfterMs: lastRetryAfterMs,
        });
      }
      const err = new Error("Model call exceeded run deadline");
      err.name = "TimeoutError";
      throw err;
    }

    const attemptStarted = now();
    try {
      const value = await fn({
        attemptIndex: retryAttempt,
        attemptNumber: attemptsSoFar,
        remainingMs,
        signal: opts.signal,
      });
      return {
        value,
        attempts: attemptsSoFar,
        failedAttempts: retryAttempt,
      };
    } catch (error) {
      const attemptDurationMs = Math.max(0, now() - attemptStarted);
      const cls = classifyModelError(error, now());

      if (opts.signal?.aborted) {
        if (opts.budget) recordLlmCall(opts.budget, 0);
        throw error;
      }

      // Preserve RATE_LIMITED semantics if a deadline aborts an in-flight retry after a rate limit.
      if (
        retryAttempt > 0 &&
        (cls.reason === "timeout" || cls.reason === "aborted") &&
        effectiveDeadlineMs !== undefined &&
        now() >= effectiveDeadlineMs
      ) {
        if (opts.budget) recordLlmCall(opts.budget, 0);
        opts.emit?.({
          node: opts.node,
          type: "llm_call",
          durationMs: attemptDurationMs,
          attempt: spanAttempt,
          payload: {
            ok: false,
            model: opts.modelName ?? "unknown",
            code: "RATE_LIMITED",
            ...(lastRateLimitStatus !== undefined
              ? { status: lastRateLimitStatus }
              : {}),
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            pricingKnown: false,
            retryAttempt,
          },
        });
        throw new ModelRetryError({
          message: buildRateLimitMessage({
            status: lastRateLimitStatus,
            attempts: attemptsSoFar,
            reason: "deadline_exceeded",
          }),
          status: lastRateLimitStatus,
          attempts: attemptsSoFar,
          reason: "deadline_exceeded",
          retryAfterMs: lastRetryAfterMs,
        });
      }

      if (opts.budget) {
        recordLlmCall(opts.budget, 0);
      }

      if (cls.kind === "rate_limit") {
        lastRateLimitStatus = cls.status;
        lastRetryAfterMs = cls.retryAfterMs;
        opts.emit?.({
          node: opts.node,
          type: "llm_call",
          durationMs: attemptDurationMs,
          attempt: spanAttempt,
          payload: {
            ok: false,
            model: opts.modelName ?? "unknown",
            code: "RATE_LIMITED",
            ...(cls.status !== undefined ? { status: cls.status } : {}),
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
            pricingKnown: false,
            retryAttempt,
          },
        });
      }

      if (cls.kind !== "rate_limit" || !cls.retryable) {
        if (cls.code === "RATE_LIMITED") {
          throw new ModelRetryError({
            message: buildRateLimitMessage({
              status: cls.status,
              attempts: attemptsSoFar,
              reason: cls.reason,
            }),
            status: cls.status,
            attempts: attemptsSoFar,
            reason: cls.reason,
            retryAfterMs: cls.retryAfterMs,
          });
        }
        throw error;
      }

      if (retryAttempt >= cfg.maxRetries) {
        throw new ModelRetryError({
          message: buildRateLimitMessage({
            status: cls.status,
            attempts: attemptsSoFar,
            reason: "max_retries_exhausted",
          }),
          status: cls.status,
          attempts: attemptsSoFar,
          reason: "max_retries_exhausted",
          retryAfterMs: cls.retryAfterMs,
        });
      }

      if (opts.budget) {
        const postCheck = checkBudget(opts.budget, now());
        if (postCheck.tripped) {
          throw new ModelRetryError({
            message: buildRateLimitMessage({
              status: cls.status,
              attempts: attemptsSoFar,
              reason:
                postCheck.reason === "deadline"
                  ? "deadline_exceeded"
                  : `budget_${postCheck.reason}`,
            }),
            status: cls.status,
            attempts: attemptsSoFar,
            reason:
              postCheck.reason === "deadline"
                ? "deadline_exceeded"
                : `budget_${postCheck.reason}`,
            retryAfterMs: cls.retryAfterMs,
            budgetTripped: true,
            tripReason: postCheck.reason,
          });
        }
      }

      const plan = planRetryDelay({
        retryIndex: retryAttempt + 1,
        retryAfterMs: cls.retryAfterMs,
        baseMs: cfg.baseMs,
        maxWaitMs: cfg.maxWaitMs,
        deadlineMs: effectiveDeadlineMs,
        nowMs: now(),
        random: opts.random,
      });

      if (!plan.shouldRetry) {
        throw new ModelRetryError({
          message: buildRateLimitMessage({
            status: cls.status,
            attempts: attemptsSoFar,
            reason: plan.stopReason,
            retryAfterMs: cls.retryAfterMs,
            maxWaitMs: cfg.maxWaitMs,
          }),
          status: cls.status,
          attempts: attemptsSoFar,
          reason: plan.stopReason,
          retryAfterMs: cls.retryAfterMs,
        });
      }

      opts.emit?.({
        node: opts.node,
        type: "retry",
        durationMs: plan.delayMs,
        attempt: spanAttempt,
        payload: {
          target: "llm",
          code: "RATE_LIMITED",
          ...(cls.status !== undefined ? { status: cls.status } : {}),
          reason: cls.reason,
          attempt: attemptsSoFar,
          nextAttempt: attemptsSoFar + 1,
          waitMs: plan.delayMs,
          ...(cls.retryAfterMs !== undefined
            ? { retryAfterMs: cls.retryAfterMs }
            : {}),
        },
      });

      await sleepFn(plan.delayMs, opts.signal);

      if (effectiveDeadlineMs !== undefined && now() >= effectiveDeadlineMs) {
        throw new ModelRetryError({
          message: buildRateLimitMessage({
            status: cls.status,
            attempts: attemptsSoFar,
            reason: "deadline_exceeded",
          }),
          status: cls.status,
          attempts: attemptsSoFar,
          reason: "deadline_exceeded",
          retryAfterMs: cls.retryAfterMs,
        });
      }
    }
  }
}
