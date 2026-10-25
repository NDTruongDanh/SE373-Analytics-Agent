/**
 * Node preload module (`--import`) that injects the mandatory
 * `x-opencode-session` header on every request to OpenCode Go.
 *
 * Background (researched 2026-10-25):
 * - OpenCode Go rejects requests without `x-opencode-session` with
 *   `HTTP 400 MissingSessionID` ("Request is missing x-opencode-session and
 *   cannot be routed efficiently").
 * - The header went from optional to mandatory; the official OpenCode client
 *   already sent it, so only third-party clients/proxies broke.
 * - It is NOT auth (the Bearer key is auth). It is a routing + prompt-cache
 *   hint: same conversation => same value, different conversations =>
 *   different values. Random-per-request passes the check but destroys cache
 *   reuse. Never put PII in it; the value is opaque (`ses_` + 32 hex chars).
 * - It is checked before model routing, so it applies to EVERY Go transport:
 *   `/chat/completions`, `/messages`, and `/responses`. Muse Spark 1.3
 *   Contributor is Responses-only, so this wrapper must cover `/responses`.
 * - OpenWiki (langchain-ai/openwiki) builds its ChatOpenAI client with only
 *   `{ baseURL }` for `openai` / `openai-compatible` + Responses API — no
 *   `defaultHeaders` hook — so without this patch every Go call 400s.
 *
 * Usage (local + CI):
 *   node --import ./scripts/openwiki-fetch-patch.mjs \
 *     ./node_modules/openwiki/dist/cli/cli.js code --update --print
 *
 * The session id is stable for the whole process (one CLI run = one
 * conversation, which is exactly the granularity Go wants for cache reuse):
 * - If `OPENWIKI_OPENCODE_SESSION_ID` is set and valid (`ses_` + 32 hex),
 *   it is reused (lets CI pin a value per run for traceability).
 * - Else if running in GitHub Actions, it is derived deterministically as
 *   `ses_<sha256(repo|run_id|sha|job)[0:32]>` — stable within the run,
 *   unique across runs, opaque (no PII).
 * - Else a random `ses_<32 hex>` is generated for this process.
 *
 * Existing headers are never overwritten (a proxy/router upstream value wins),
 * matching kRouter's pass-through behavior (>= v0.5.151).
 */

import { createHash, randomBytes } from "node:crypto";

const SESSION_HEADER = "x-opencode-session";
const SESSION_RE = /^ses_[0-9a-f]{32}$/;

function deriveCiSessionId() {
  const repo = process.env.GITHUB_REPOSITORY ?? "local";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const sha = process.env.GITHUB_SHA ?? "";
  const job = process.env.GITHUB_JOB ?? "openwiki";
  if (!runId) return null;
  const digest = createHash("sha256")
    .update(`openwiki|${repo}|${runId}|${sha}|${job}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ses_${digest}`;
}

function resolveSessionId() {
  const override = (process.env.OPENWIKI_OPENCODE_SESSION_ID ?? "").trim();
  if (override) {
    if (!SESSION_RE.test(override)) {
      throw new Error(
        "Invalid OPENWIKI_OPENCODE_SESSION_ID: expected `ses_` followed by 32 lowercase hex chars.",
      );
    }
    return override;
  }
  return (
    deriveCiSessionId() ?? `ses_${randomBytes(16).toString("hex").slice(0, 32)}`
  );
}

const SESSION_ID = resolveSessionId();

function isOpencodeGoUrl(url) {
  return (
    typeof url === "string" &&
    (url.includes("opencode.ai") ||
      url.includes("inference/go") ||
      url.includes("zen/go"))
  );
}

function getRequestUrl(input) {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === "string") return input.url;
  } catch {
    // fall through
  }
  return null;
}

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = getRequestUrl(input);
  if (url && isOpencodeGoUrl(url)) {
    // Collect headers without mutating the caller's objects.
    const baseHeaders =
      init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(baseHeaders);
    if (!headers.has(SESSION_HEADER)) {
      headers.set(SESSION_HEADER, SESSION_ID);
      if (input instanceof Request) {
        // Request headers are immutable — clone the request with the header.
        return originalFetch(new Request(input, { headers }), init);
      }
      return originalFetch(input, { ...init, headers });
    }
  }
  return originalFetch(input, init);
};

// One stderr line so runs are traceable (which session id fed Go's router).
// The id itself is opaque and safe to log; never log the API key here.
console.error(
  `[openwiki] x-opencode-session patch active (session ${SESSION_ID.slice(0, 12)}…, scope: opencode.ai requests only)`,
);

export { SESSION_ID, SESSION_HEADER };
