// PR architecture review via OpenCode Go (OpenAI-compatible Responses API).
// Reuses the OpenWiki key setup: OPENCODE_GO_API_KEY (CI secret) or
// OPENAI_COMPATIBLE_API_KEY (local .env). No new secret needed.
//
// Model is Responses-only: POST {base}/responses with
// { model, instructions, input, reasoning: { effort: "xhigh" }, store: false }.
// The mandatory `x-opencode-session` header mirrors
// scripts/openwiki-fetch-patch.mjs (deterministic per CI run, random locally).
//
// Usage:
//   node scripts/pr-review.mjs [--dry-run] [--base origin/main]
//     [--max-diff-chars 90000] [--max-output-tokens 16000]
//     [--model muse-spark-1.3-contributor] [--effort xhigh] [--pr 123]
//     [--effort xhigh] [--pr 123]
//
// Advisory only: missing key, fork PRs, or API failures exit 0 with a skip
// notice so this never blocks the `gate` branch-protection context.
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const DEFAULT_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const DEFAULT_MODEL = "muse-spark-1.3-contributor";
const DEFAULT_EFFORT = "xhigh";
const SESSION_RE = /^ses_[0-9a-f]{32}$/;

// Diff paths that waste review tokens; still listed as skipped.
const EXCLUDED_DIFF = [
  "pnpm-lock.yaml",
  "package-lock.yaml",
  "openwiki/",
  "/dist/",
  "/coverage/",
  ".log",
];

function parseArgs(argv) {
  const out = {
    dryRun: false,
    base: process.env.PR_REVIEW_BASE || "origin/main",
    maxDiffChars: Number(process.env.PR_REVIEW_MAX_DIFF_CHARS || "90000"),
    maxOutputTokens: Number(process.env.PR_REVIEW_MAX_OUTPUT_TOKENS || "16000"),
    model: process.env.PR_REVIEW_MODEL || DEFAULT_MODEL,
    effort: process.env.PR_REVIEW_EFFORT || DEFAULT_EFFORT,
    pr: process.env.PR_NUMBER || "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--base") out.base = argv[(i += 1)] || out.base;
    else if (a === "--max-diff-chars")
      out.maxDiffChars = Number(argv[(i += 1)] || out.maxDiffChars);
    else if (a === "--max-output-tokens")
      out.maxOutputTokens = Number(argv[(i += 1)] || out.maxOutputTokens);
    else if (a === "--model") out.model = argv[(i += 1)] || out.model;
    else if (a === "--effort") out.effort = argv[(i += 1)] || out.effort;
    else if (a === "--pr") out.pr = argv[(i += 1)] || out.pr;
  }
  return out;
}

function isExcluded(path) {
  return EXCLUDED_DIFF.some((pat) =>
    pat.endsWith("/")
      ? path.startsWith(pat) || path.includes(pat)
      : path === pat ||
        path.endsWith(pat) ||
        path.endsWith(`/${pat}`) ||
        path.includes(`/${pat}`),
  );
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

function resolveSessionId() {
  const override = (process.env.OPENWIKI_OPENCODE_SESSION_ID || "").trim();
  if (override) {
    if (!SESSION_RE.test(override)) {
      throw new Error(
        "Invalid OPENWIKI_OPENCODE_SESSION_ID: expected ses_ + 32 lowercase hex.",
      );
    }
    return override;
  }
  const runId = process.env.GITHUB_RUN_ID || "";
  if (runId) {
    const repo = process.env.GITHUB_REPOSITORY || "local";
    const sha = process.env.GITHUB_SHA || "";
    const pr =
      process.env.PR_NUMBER ||
      process.env.GITHUB_REF ||
      "pr-review";
    const digest = createHash("sha256")
      .update(`pr-review|${repo}|${runId}|${sha}|${pr}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    return `ses_${digest}`;
  }
  return `ses_${randomBytes(16).toString("hex").slice(0, 32)}`;
}

function readEventPayload() {
  try {
    const p = process.env.GITHUB_EVENT_PATH;
    if (p && existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // Fall through to gh-based metadata.
  }
  return null;
}

function buildInstructions() {
  return [
    "You are a senior staff reviewer for the SE373 Analytics Agent monorepo.",
    "docs/architecture.md is the SOLE source of truth for structure, boundaries, and invariants.",
    "Be direct and technical, no flattery. Cite file paths with line numbers.",
    "",
    "Enforce in order:",
    "1. Five non-negotiable harness invariants (§1.2): single MCP data gateway (agent never imports pg/pg-cursor or mcp-server/src), 3-layer defense (sqlGuard + agent_ro read-only + AccessPolicy/PII), untrusted-data separation with zero-tools synthesis, K7 pre-response verification (citations/chart/numeric ≤1%/attribution ≤5%), contract-first camelCase Zod + runId/principal propagation.",
    "2. Package boundaries (§5.2, enforced by eslint): agent/access-policy/api(non-store) never import pg/pg-cursor or mcp-server/src; web imports workspace types from @shared/contracts only; contracts imports zod only; access-policy is pure (no DB/network/fs).",
    "3. Server order (§2.3/§3.10): auth → scope → zod → sqlGuard → AccessPolicy → executor (agent_ro, 30s timeout, cursor ≤1000) → PII scan → audit. Every agent SQL query must go through ValidatedQueryExecutor (selective describe → local pre-check → run_query → ≤3 repairs); synthesis nodes bind zero tools.",
    "4. Contracts evolution (§5/§7.1): additive needs 1 owner review + regenerated docs/mcp_interface.md (never hand-edit); breaking renames/removals/type-tightening/error-code changes need a CONTRACTS_VERSION major bump + all affected UC owners.",
    "5. Per-UC rules (§7): own files only, no cross-UC rewrites; ≥5 eval cases per UC (UC-01 ≥30 benchmark) + shared safety attacks + ≥1 redacted trace; traces/logs carry no raw PII or secrets.",
    "",
    "Output Markdown exactly:",
    "## Verdict",
    "One line: Approve | Request changes | Comment (advisory). Request changes ONLY for invariant/boundary violations, exploitable safety gaps, breaking contracts without a major bump, hand-edited docs/mcp_interface.md, or leaked secrets/PII.",
    "## Summary",
    "2-4 sentences on what the PR changes and whether it fits the harness.",
    "## Architecture compliance",
    "Table with one row per invariant/boundary checked: | Check (§ref) | Pass/Fail/N-A | Evidence |. Every Fail must point at diff lines.",
    "## Issues",
    "Numbered list, else 'None'. Each: `path:line` — severity (blocker/major/minor) — violated § — why — concrete fix. Never invent files or line numbers outside the diff.",
    "## Minor nits (optional)",
    "Style/tests/docs suggestions that are NOT merge-blocking.",
    "## What looks good",
    "1-3 bullets only for genuinely correct harness usage (e.g. proper ValidatedQueryExecutor path, correct error routing).",
    "",
    "Rules: review ONLY the diff below. Do not restate the diff. Keep the whole review under ~150 lines. Flag secret/PII additions as blockers.",
  ].join("\n");
}

function unwrapResponse(data) {
  if (!data || typeof data !== "object") return data;
  // Some gateways nest the Responses payload one level deep.
  if (data.response && typeof data.response === "object") return data.response;
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data))
    return data.data;
  return data;
}

function describeResponse(data) {
  // Small, PII-free shape summary for logs (status, item types, usage only).
  try {
    const r = unwrapResponse(data);
    const output = Array.isArray(r?.output) ? r.output : [];
    const types = output.map((it) => it?.type).filter(Boolean);
    const usage = r?.usage;
    const usageStr =
      usage && typeof usage === "object"
        ? ` input=${usage.input_tokens ?? usage.prompt_tokens ?? "?"} output=${usage.output_tokens ?? usage.completion_tokens ?? "?"} reasoning=${usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? "?"}`
        : "";
    const reason =
      r?.incomplete_details?.reason || r?.incomplete_reason || "";
    return `status=${r?.status || "?"} outputItems=${output.length} types=[${types.join(",")}]${reason ? ` incompleteReason=${reason}` : ""}${usageStr}`;
  } catch {
    return "status=? (undescribable)";
  }
}

function extractResponseText(data) {
  const r = unwrapResponse(data);
  if (!r || typeof r !== "object") return "";
  if (typeof r.output_text === "string" && r.output_text.trim())
    return r.output_text;
  if (
    Array.isArray(r.output_text) &&
    r.output_text.some((s) => typeof s === "string" && s.trim())
  )
    return r.output_text.filter((s) => typeof s === "string").join("\n\n");
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (
      (node.type === "output_text" || node.type === "text") &&
      typeof node.text === "string"
    ) {
      out.push(node.text);
      return;
    }
    if (typeof node.text === "string" && node.type?.includes("text")) {
      out.push(node.text);
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(r.output ?? r.content ?? r.outputs ?? []);
  if (out.length > 0) return out.join("\n\n");
  const choice = r.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice.trim()) return choice;
  if (typeof r.message?.content === "string") return r.message.content;
  return "";
}

function isTokenBudgetExhausted(data) {
  const r = unwrapResponse(data);
  if (!r || typeof r !== "object") return false;
  const reason = r.incomplete_details?.reason || r.incomplete_reason || "";
  return (
    r.status === "incomplete" &&
    String(reason).toLowerCase().includes("max_output_tokens")
  );
}

async function requestReview({ baseUrl, apiKey, sessionId, model, effort, instructions, input, maxOutputTokens }) {
  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      store: false,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${text.slice(0, 200)})`);
  }
  console.error(`[pr-review] ${describeResponse(data)} (budget=${maxOutputTokens})`);
  return data;
}

async function main() {
  const opts = parseArgs(process.argv);
  const archPath = join(root, "docs/architecture.md");
  if (!existsSync(archPath)) {
    console.error("FAIL: docs/architecture.md not found");
    process.exit(1);
  }
  const architecture = readFileSync(archPath, "utf8");

  // --- Collect diff (three-dot, fall back to two-dot) ---
  let files = [];
  let diff = "";
  try {
    let names = "";
    try {
      names = await git(["diff", "--name-only", `${opts.base}...HEAD`]);
    } catch {
      names = await git(["diff", "--name-only", `${opts.base}..HEAD`]);
    }
    files = names.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    console.error(`FAIL: git diff --name-only failed: ${err.message}`);
    process.exit(1);
  }
  const reviewFiles = files.filter((f) => !isExcluded(f));
  const skipped = files.filter((f) => isExcluded(f));
  if (reviewFiles.length > 0) {
    const args = [
      "diff",
      "--unified=3",
      "--no-color",
      `${opts.base}...HEAD`,
      "--",
      ...reviewFiles,
    ];
    try {
      diff = await git(args);
    } catch {
      diff = await git([
        "diff",
        "--unified=3",
        "--no-color",
        `${opts.base}..HEAD`,
        "--",
        ...reviewFiles,
      ]);
    }
  }
  let truncated = false;
  if (diff.length > opts.maxDiffChars) {
    diff = `${diff.slice(0, opts.maxDiffChars)}\n\n... [TRUNCATED: diff exceeded ${opts.maxDiffChars} chars; ${reviewFiles.length} files, showing the first ${opts.maxDiffChars} chars]`;
    truncated = true;
  }

  // --- PR metadata (event payload preferred, gh best-effort) ---
  const event = readEventPayload();
  const prFromEvent =
    event?.pull_request?.number || event?.number || opts.pr || "";
  let prMeta = {
    number: String(prFromEvent || ""),
    title: event?.pull_request?.title || "",
    body: (event?.pull_request?.body || "").slice(0, 4000),
    base: event?.pull_request?.base?.ref || "main",
    head: event?.pull_request?.head?.ref || "",
  };
  if (!prMeta.title && prMeta.number) {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "view", String(prMeta.number), "--json", "title,body,baseRefName,headRefName"],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      );
      const j = JSON.parse(stdout);
      prMeta = {
        number: String(prMeta.number),
        title: j.title || "",
        body: String(j.body || "").slice(0, 4000),
        base: j.baseRefName || "main",
        head: j.headRefName || "",
      };
    } catch {
      // Metadata is nice-to-have; the diff is the review target.
    }
  }
  if (!opts.pr && prMeta.number) opts.pr = prMeta.number;
  // Stamp every review with the exact commit it reviewed so pushes are
  // visibly re-reviewed: the living PR comment is updated in place.
  let headSha = event?.pull_request?.head?.sha || "";
  if (!headSha) {
    try {
      headSha = await git(["rev-parse", "HEAD"]);
    } catch {
      headSha = "";
    }
  }
  opts.headSha = headSha;
  opts.reviewedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const header = [
    `PR: #${prMeta.number || "?"} ${prMeta.title || "(title unavailable)"}`,
    `Base → Head: ${prMeta.base} → ${prMeta.head || "HEAD"} (base ref ${opts.base})`,
    `Files: ${reviewFiles.length} reviewed${skipped.length ? `, ${skipped.length} skipped (generated/vendor: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", …" : ""})` : ""}${truncated ? " — DIFF TRUNCATED" : ""}`,
    prMeta.body ? `PR description (first 4k chars):\n${prMeta.body}` : "PR description: (unavailable)",
  ].join("\n");

  const input = [
    "ARCHITECTURE (source of truth — docs/architecture.md):",
    "```markdown",
    architecture,
    "```",
    "",
    header,
    "",
    reviewFiles.length === 0
      ? "DIFF: (empty — no reviewable files changed; reply that there is nothing to review against the architecture.)"
      : "DIFF (unified=3, excluded paths removed):",
    reviewFiles.length === 0 ? "" : "```diff",
    reviewFiles.length === 0 ? "" : diff,
    reviewFiles.length === 0 ? "" : "```",
    "",
    "Review the diff against the architecture. Follow the output format exactly.",
  ].join("\n");

  if (opts.dryRun) {
    console.log(
      `[pr-review] dry-run: model=${opts.model} effort=${opts.effort} base=${opts.base}`,
    );
    console.log(
      `[pr-review] files=${files.length} reviewed=${reviewFiles.length} skipped=${skipped.length} diffChars=${diff.length} archChars=${architecture.length} inputChars=${input.length}`,
    );
    console.log("---INPUT HEAD---");
    console.log(input.slice(0, 3000));
    return;
  }

  if (reviewFiles.length === 0) {
    const body = [
      "<!-- opencode-pr-review -->",
      `## Opencode review (${opts.model} · ${opts.effort})`,
      "",
      "No reviewable files changed (only generated/vendor paths or an empty diff). Nothing to check against `docs/architecture.md`.",
    ].join("\n");
    await postComment(body, opts);
    return;
  }

  const apiKey =
    process.env.OPENCODE_GO_API_KEY ||
    process.env.OPENAI_COMPATIBLE_API_KEY ||
    "";
  if (!apiKey) {
    const body = [
      "<!-- opencode-pr-review -->",
      `## Opencode review (${opts.model} · ${opts.effort}) — skipped`,
      "",
      "No `OPENCODE_GO_API_KEY` available in this run (expected for fork PRs or local runs without `.env`).",
      "Add the same secret used by OpenWiki (`Settings → Secrets and variables → Actions → OPENCODE_GO_API_KEY`) to enable architecture reviews.",
    ].join("\n");
    console.error("[pr-review] missing OPENCODE_GO_API_KEY — posting skip notice");
    await postComment(body, opts);
    return;
  }

  const baseUrl = (
    process.env.OPENAI_COMPATIBLE_BASE_URL || DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const sessionId = resolveSessionId();
  console.error(
    `[pr-review] requesting ${opts.model} effort=${opts.effort} (session ${sessionId.slice(0, 12)}…)`,
  );
  let review = "";
  try {
    // xhigh reasoning on a ~130k-char input can burn the whole output budget
    // on reasoning tokens, returning status=incomplete with no message item.
    // Retry once with a doubled budget (capped) before giving up.
    let budget = opts.maxOutputTokens;
    let data = await requestReview({
      baseUrl,
      apiKey,
      sessionId,
      model: opts.model,
      effort: opts.effort,
      instructions: buildInstructions(),
      input,
      maxOutputTokens: budget,
    });
    if (isTokenBudgetExhausted(data) && budget < 64000) {
      budget = Math.min(budget * 2, 64000);
      console.error(`[pr-review] output budget exhausted, retrying once with ${budget}`);
      data = await requestReview({
        baseUrl,
        apiKey,
        sessionId,
        model: opts.model,
        effort: opts.effort,
        instructions: buildInstructions(),
        input,
        maxOutputTokens: budget,
      });
    }
    review = extractResponseText(data);
    if (!review.trim())
      throw new Error(`empty model response (${describeResponse(data)})`);
  } catch (err) {
    const body = [
      "<!-- opencode-pr-review -->",
      `## Opencode review (${opts.model} · ${opts.effort}) — error`,
      "",
      `The reviewer call failed and is advisory only (never blocks \`gate\`): \`${String(err?.message || err).slice(0, 300)}\`.`,
      "Re-run the workflow or push a new commit to retry.",
    ].join("\n");
    console.error(`[pr-review] API call failed: ${err?.message || err}`);
    await postComment(body, opts);
    return;
  }

  const stamp = opts.headSha
    ? `_Reviewed commit \`${opts.headSha.slice(0, 12)}\` · ${opts.reviewedAt || ""} — this comment is updated on every push._`
    : "_This comment is updated on every push._";
  const body = [
    "<!-- opencode-pr-review -->",
    `## Opencode review (\`${opts.model}\` · ${opts.effort} · vs \`docs/architecture.md\`)`,
    "",
    stamp,
    "",
    review.trim(),
    "",
    "---",
    "_Advisory architecture review — non-blocking. Source of truth: `docs/architecture.md`. Model: `muse-spark-1.3-contributor` @ `xhigh` via OpenCode Go Responses API._",
  ].join("\n");
  await postComment(body, opts);
}

const REVIEW_MARKER = "<!-- opencode-pr-review -->";

function pickReviewCommentId(comments) {
  // Pure helper (unit-tested below via --self-test): newest marker comment,
  // preferring the github-actions bot's own so a user quote can't hijack it.
  if (!Array.isArray(comments)) return 0;
  const marked = comments.filter(
    (c) => typeof c?.body === "string" && c.body.includes(REVIEW_MARKER),
  );
  if (marked.length === 0) return 0;
  const bot = marked.filter((c) => c?.user?.login === "github-actions[bot]");
  const pool = bot.length > 0 ? bot : marked;
  let best = pool[0];
  for (const c of pool) {
    if (Date.parse(c.updated_at || c.created_at || 0) > Date.parse(best.updated_at || best.created_at || 0)) best = c;
  }
  return best.id || 0;
}

async function postComment(body, opts) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      writeFileSync(summaryFile, `${body.slice(0, 20000)}\n`, { flag: "a" });
    } catch {
      // Summary is best-effort.
    }
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const pr = opts.pr || process.env.PR_NUMBER || "";
  if (!pr || !token) {
    console.log("---REVIEW BODY (no PR token/number; not posting)---");
    console.log(body);
    return;
  }
  const env = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  const gh = (args, extra = {}) =>
    execFileAsync("gh", args, { cwd: root, env, maxBuffer: 4 * 1024 * 1024, ...extra });
  // Every push re-reviews: update the living marker comment in place instead
  // of stacking a new comment per run, so the visible review always matches
  // the latest pushed commit.
  try {
    let repo = process.env.GITHUB_REPOSITORY || "";
    if (!repo) {
      const { stdout } = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
      repo = stdout.trim();
    }
    const { stdout } = await gh([
      "api",
      `repos/${repo}/issues/${pr}/comments`,
      "--paginate",
    ]);
    const id = pickReviewCommentId(JSON.parse(stdout));
    if (id) {
      await gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "-f", `body=${body}`]);
      console.error(`[pr-review] updated review comment ${id} on PR #${pr}`);
      return;
    }
  } catch (err) {
    console.error(`[pr-review] comment lookup/update failed, falling back to new comment: ${err.message}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "opencode-pr-review-"));
  const file = join(dir, "review.md");
  writeFileSync(file, body);
  try {
    await gh(["pr", "comment", String(pr), "--body-file", file]);
    console.error(`[pr-review] posted review to PR #${pr}`);
  } catch (err) {
    console.error(`[pr-review] gh comment failed (advisory): ${err.message}`);
    console.log("---REVIEW BODY (post failed)---");
    console.log(body);
  }
}

await main();
