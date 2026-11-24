// Preload patch (--import) injecting x-opencode-session on OpenCode Go requests.
// OpenWiki omits defaultHeaders on its ChatOpenAI client, and Go rejects requests without a stable session id (HTTP 400).

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
  }
  return null;
}

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init) => {
  const url = getRequestUrl(input);
  if (url && isOpencodeGoUrl(url)) {
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

// Log only the opaque session prefix for routing traceability; never log the API key.
console.error(
  `[openwiki] x-opencode-session patch active (session ${SESSION_ID.slice(0, 12)}…, scope: opencode.ai requests only)`,
);

export { SESSION_ID, SESSION_HEADER };
