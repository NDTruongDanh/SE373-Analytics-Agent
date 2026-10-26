# SE373-Analytics-Agent

Initial setup for main branch.

**Start here:** [`docs/architecture.md`](docs/architecture.md) — harness
architecture, package boundaries, shared contracts, and where each UC's code goes.
Team handoff guide (Vietnamese): [`docs/HUONG-DAN-NHOM.md`](docs/HUONG-DAN-NHOM.md).

## OpenWiki docs (pnpm + GitHub Actions + OpenCode Go)

Repository wiki lives in `openwiki/` and is maintained by
[langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) (`0.7.2`,
pinned in `package.json` + `pnpm-lock.yaml`). Runs use your OpenCode Go API
key (you paste it yourself — it is never committed).

### 1. Prerequisites

- Node.js `>=24.0.0` (latest major tested by upstream OpenWiki CI: 22 + 24),
  pnpm `>=10` (repo pins `pnpm@11.25.0` via `packageManager`; Corepack
  activates it: `corepack enable`).
- An OpenCode Go API key (subscribe in the
  [OpenCode Console](https://opencode.ai/console), Go or Go Plus).

### 2. Local runs

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # then fill in OPENAI_COMPATIBLE_API_KEY with your key
pnpm wiki:update:print # non-interactive; same command CI runs
```

Other scripts: `pnpm wiki:init` (first generation), `pnpm wiki:update`,
`pnpm wiki:dry-run`, `pnpm wiki:visualize`
(`openwiki visualize openwiki --export docs/openwiki-visualizer` for a static
site). The brief OpenWiki reads every run is `openwiki/INSTRUCTIONS.md`; the
read boundary is `.openwikiignore`.

### 3. Scheduled CI (auto-merge docs PRs)

`.github/workflows/openwiki-update.yml` runs daily (`08:00 UTC`) + on demand
(`workflow_dispatch`) on Node 24, installs with `pnpm/action-setup` +
`actions/setup-node` (pnpm cache), runs OpenWiki, and opens
a docs-only PR (`openwiki`, `AGENTS.md`, `CLAUDE.md`) with auto-merge enabled
on success. Workflow-file changes are excluded from the PR so auto-merge never
touches executable CI.

Create two Actions secrets (Settings → Secrets and variables → Actions):

| Secret | Value | Why a dedicated token |
|---|---|---|
| `OPENCODE_GO_API_KEY` | your OpenCode Go key | mapped to `OPENAI_COMPATIBLE_API_KEY` for the `openai-compatible` provider |
| `OPENWIKI_PR_TOKEN` | fine-grained PAT or GitHub App token, this repo only, `Contents: read+write`, `Pull requests: read+write` | PRs opened with default `GITHUB_TOKEN` don't trigger most `pull_request` workflows, so required checks would never run |

Also enable **Allow auto-merge** in repo pull-request settings and add branch
protection/ruleset for the default branch (this repo already protects `main`).

### 4. Provider + session-header caveat (researched)

- Provider: `OPENWIKI_PROVIDER=openai-compatible`,
  `OPENAI_COMPATIBLE_BASE_URL=https://opencode.ai/inference/go/openai/v1`,
  `OPENWIKI_MODEL_ID=muse-spark-1.3-contributor`,
  `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true`. Go serves this model
  **only** on the Responses API (`POST {base}/responses`); `false` routes to
  `/chat/completions` and Go answers `ModelProtocolUnsupported` (surfaced as
  HTTP 401, looks like bad auth).
- OpenCode Go **requires** `x-opencode-session` on every request (else
  `400 MissingSessionID`). OpenWiki sends no such header, so
  `scripts/openwiki-fetch-patch.mjs` (Node `--import` preload, used by every
  `pnpm wiki:*` script and the workflow) injects a stable opaque
  `ses_<32 hex>` value for `opencode.ai` requests only: deterministic per
  GitHub run (`repo|run_id|sha|job` hash), random per process locally, never
  overwriting an existing value, never containing PII. Same conversation →
  same value (cache reuse); different runs → different values.
