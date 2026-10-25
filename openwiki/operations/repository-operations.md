---
type: operations-guide
title: Repository operations and wiki automation
description: Build and runtime entrypoints, provider and session-header configuration, scheduled wiki CI, and submission layout for the Analytics Agent repository.
tags: [operations, repository, openwiki-automation, configuration, ci]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-25T12:53:57.503Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
generated: { by: "openwiki/0.7.2", at: "2026-10-25T12:53:57.503Z" }
---

# Repository operations and wiki automation

This repository is the SE373 Analytics Agent course project in initial setup: wiki tooling, product requirements, and use-case plans exist, but no agent, database loader, or eval code has landed yet (see [Quickstart](../quickstart.md)). This page owns the operational layer coding agents must not break: toolchain, `pnpm wiki:*` entrypoints, inference-provider configuration, the fetch-patch session header, scheduled wiki CI, and the expected submission layout.

## 1. Toolchain

- Node.js `>=24.0.0` and pnpm `>=10`; the repository pins `pnpm@11.25.0` through `packageManager` and activates it with Corepack (`package.json:8-12`, `README.md:14-16`).
- Local activation sequence is `corepack enable`, `corepack prepare pnpm@11.25.0 --activate`, then `pnpm install --frozen-lockfile` (`README.md:22-28`).
- Wiki engine is [`openwiki`](https://github.com/langchain-ai/openwiki) `0.7.2`, pinned in `package.json:23` plus `pnpm-lock.yaml` (`README.md:7-10`).
- CI runs on Node `24` with `pnpm/action-setup` version `11.25.0` and `actions/setup-node` with the pnpm cache (`.github/workflows/openwiki-update.yml:30-41`).
- `pnpm-workspace.yaml:1-3` records the pnpm v11 build approval for `better-sqlite3`; it is not a second package definition.

## 2. Build and runtime entrypoints

Every `wiki:*` script preloads the session-header patch with Node `--import` before invoking the OpenWiki CLI (`package.json:14-18`):

| Command | Invocation | Purpose |
|---|---|---|
| `pnpm wiki:init` | `node --import ./scripts/openwiki-fetch-patch.mjs ./node_modules/openwiki/dist/cli/cli.js code --init` | First wiki generation (`package.json:14`, `README.md:30`) |
| `pnpm wiki:update` | `... cli.js code --update` | Interactive wiki update (`package.json:15`, `README.md:30`) |
| `pnpm wiki:update:print` | `... cli.js code --update --print` | Non-interactive update; the same command CI runs (`package.json:16`, `README.md:27`) |
| `pnpm wiki:dry-run` | `... cli.js --dry-run` | Validate without writing (`package.json:17`, `README.md:30-31`) |
| `pnpm wiki:visualize` | `... cli.js visualize` | Static-site export under `docs/openwiki-visualizer` (`package.json:18`, `README.md:31-33`) |

The canonical local run is copy `.env.example` to `.env`, fill in the API key variable, then run `pnpm wiki:update:print` (`README.md:22-28`). The brief every OpenWiki run reads is [`openwiki/INSTRUCTIONS.md`](../INSTRUCTIONS.md); the read boundary is [`.openwikiignore`](../../.openwikiignore) (`README.md:33-34`).

## 3. Environment and provider configuration

The template is [`.env.example`](../../.env.example); the real `.env` is never committed (`.env.example:1-3`, [`.gitignore`](../../.gitignore):5-7). In CI the same values come from Actions secrets, not from a committed file (`.env.example:1-3`).

Required inference settings:

- `OPENWIKI_PROVIDER=openai-compatible` (`.env.example:6`, `.github/workflows/openwiki-update.yml:66`).
- `OPENAI_COMPATIBLE_BASE_URL=https://opencode.ai/inference/go/openai/v1` (`.env.example:15`, `.github/workflows/openwiki-update.yml:68`).
- `OPENWIKI_MODEL_ID=muse-spark-1.3-contributor` (`.env.example:17`, `.github/workflows/openwiki-update.yml:69`).
- `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true` (`.env.example:21`, `.github/workflows/openwiki-update.yml:70`).

The flag must stay `true`: OpenCode Go serves this model only on the Responses API at `POST {base}/responses`; `false` routes to `/chat/completions` and Go answers `ModelProtocolUnsupported`, surfaced as HTTP 401 that looks like bad auth (`.env.example:18-21`, `README.md:57-63`, `.github/workflows/openwiki-update.yml:59-60`).

CI additionally sets `OPENWIKI_OPENAI_COMPATIBLE_REASONING_EFFORT_SUPPORTED=true` and `OPENWIKI_REASONING_EFFORT=xhigh` to select the xhigh reasoning variant; a `#xhigh` model-ID suffix is not used because `#` fails OpenWiki model-ID validation (`.github/workflows/openwiki-update.yml:61-72`). Optional LangSmith tracing (`LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`) and the telemetry opt-out (`OPENWIKI_TELEMETRY_DISABLED=1`) are documented in `.env.example:30-36`; the workflow leaves telemetry enabled with a commented opt-out (`.github/workflows/openwiki-update.yml:55-57`).

Two Actions secrets are required (`README.md:45-50`):

| Secret | Mapped to | Purpose |
|---|---|---|
| `OPENCODE_GO_API_KEY` | `OPENAI_COMPATIBLE_API_KEY` | OpenCode Go key for the `openai-compatible` provider |
| `OPENWIKI_PR_TOKEN` | `token` for PR creation and `GH_TOKEN` for merging | Fine-grained PAT or GitHub App token, this repository only, `Contents: read+write` and `Pull requests: read+write`; PRs opened with the default `GITHUB_TOKEN` do not trigger most `pull_request` workflows, so required checks would never run |

Also enable **Allow auto-merge** in repository pull-request settings; the default branch is already protected (`README.md:52-53`, `ruleset-main.json:23-41` requires one code-owner review).

## 4. Fetch-patch session header

OpenCode Go requires `x-opencode-session` on every request, otherwise it returns `400 MissingSessionID`. OpenWiki builds its client with only `{ baseURL }` and sends no such header, so [`scripts/openwiki-fetch-patch.mjs`](../../scripts/openwiki-fetch-patch.mjs) patches global `fetch` via Node `--import` preload (`README.md:64-66`, `scripts/openwiki-fetch-patch.mjs:1-20`, `.github/workflows/openwiki-update.yml:49-53`).

Behavior contract (`README.md:64-71`, `scripts/openwiki-fetch-patch.mjs:26-36`):

- Scope is `opencode.ai` requests only; other hosts pass through unchanged (`scripts/openwiki-fetch-patch.mjs:74-81`, `scripts/openwiki-fetch-patch.mjs:96-113`).
- Value shape is opaque `ses_` plus 32 lowercase hex characters; it never contains PII (`scripts/openwiki-fetch-patch.mjs:11-14`, `scripts/openwiki-fetch-patch.mjs:41-42`).
- Resolution order: reuse a valid `OPENWIKI_OPENCODE_SESSION_ID` override when set (invalid values throw); otherwise derive deterministically in GitHub Actions as `ses_<sha256(openwiki|repo|run_id|sha|job)[0:32]>`, stable within the run and unique across runs; otherwise generate a random per-process value locally (`scripts/openwiki-fetch-patch.mjs:44-70`, `.env.example:24-28`).
- One CLI run uses one process-wide value, matching Go's routing plus prompt-cache granularity: same conversation reuses the value, different runs get different values (`scripts/openwiki-fetch-patch.mjs:26-33`).
- Existing header values are never overwritten, matching upstream pass-through behavior (`scripts/openwiki-fetch-patch.mjs:35-36`, `scripts/openwiki-fetch-patch.mjs:103-110`).
- The module logs one opaque stderr prefix for traceability and never logs the API key (`scripts/openwiki-fetch-patch.mjs:115-119`).

Failure modes: missing or bypassed preload causes every Go call to 400; a `false` Responses-API flag causes 401 `ModelProtocolUnsupported`; a malformed override fails fast before any request (`scripts/openwiki-fetch-patch.mjs:57-70`, `.env.example:18-21`).

## 5. Scheduled wiki CI

Workflow file: [`.github/workflows/openwiki-update.yml`](../../.github/workflows/openwiki-update.yml).

- Triggers: daily schedule `0 8 * * *` (08:00 UTC) plus `workflow_dispatch` for on-demand runs (`.github/workflows/openwiki-update.yml:3-7`, `README.md:38-39`).
- Concurrency group `openwiki-update` with `cancel-in-progress: false` (`.github/workflows/openwiki-update.yml:13-15`).
- Checkout uses full history (`fetch-depth: 0`) so `openwiki code --update` can diff `HEAD` against the commit it last documented; a shallow clone would run against an empty change summary (`.github/workflows/openwiki-update.yml:21-28`).
- Install and run steps: pnpm setup, Node 24 setup with pnpm cache, `pnpm install --frozen-lockfile`, then `node --import ./scripts/openwiki-fetch-patch.mjs ./node_modules/openwiki/dist/cli/cli.js code --update --print` (`.github/workflows/openwiki-update.yml:30-53`). The run step uses `continue-on-error: true` so later steps can still open a PR preserving pages completed before a failure (`.github/workflows/openwiki-update.yml:45-47`, `.github/workflows/openwiki-update.yml:108-114`).
- Docs-only PR scope: the workflow checks out any change to itself (`git checkout -- .github/workflows/openwiki-update.yml`) so auto-merge never touches executable CI, removes transient `openwiki/.run.json`, then stages only `openwiki,AGENTS.md` plus `CLAUDE.md` when that file exists (`.github/workflows/openwiki-update.yml:74-92`, `README.md:41-43`). Missing-path handling matters because `git add` fails on a missing path.
- Creation and merge: `peter-evans/create-pull-request` opens branch `openwiki/update` with the dedicated `OPENWIKI_PR_TOKEN` (`.github/workflows/openwiki-update.yml:94-115`). On success the workflow merges immediately with `gh pr merge --squash --admin --delete-branch`; `--admin` is needed because the token identity is a ruleset bypass actor and `gh pr merge --auto` would wait on the one code-owner review forever (`.github/workflows/openwiki-update.yml:116-128`). On failure it disables auto-merge, annotates the PR URL, and propagates the failure with `exit 1` (`.github/workflows/openwiki-update.yml:130-145`).

## 6. Expected repository and submission layout

The PRD submission contract (`docs/prd.md:589-604`) defines the layout future agent code must grow into; this operations page does not duplicate per-UC design:

- Repository must contain source code, `README` with setup, dataset source and license, and load instructions, plus `.env.example`, `AGENTS.md`, `data/` loader and transform scripts (no large re-downloadable data files), `semantic/` data dictionary and event log, `policies/` RBAC and masking rules, `skills/`, `evals/` questions and EX grader plus runner, and `docs/` architecture diagrams (`docs/prd.md:591`).
- Technical report must cover the `agent = model + harness` architecture, database source and Vietnamesization plus seeded data, submitted-UC list with the K1–K8 coverage table, per-UC design, failure-mode mitigations, eval and regression results, safety analysis, limitations, and AI-use transparency (`docs/prd.md:592-601`).
- Remaining deliverables are the ownership table, a demo video of at most 15 minutes covering every submitted UC, and at least one successful sample trace per UC (`docs/prd.md:602-604`).
- Current repository evidence for these paths is [`README.md`](../../README.md), [`package.json`](../../package.json), [`docs/prd.md`](../../docs/prd.md), [`docs/UC-plan/`](../../docs/UC-plan/), [`openwiki/INSTRUCTIONS.md`](../INSTRUCTIONS.md), [`.openwikiignore`](../../.openwikiignore), and the workflow file above; the agent, database, semantic, policy, skill, and eval directories do not exist yet (see [Quickstart](../quickstart.md)).

Future agent implementation constraint: use Python (recommended) or TypeScript for agent code, and LangGraph for the workflow (recommended) or an equivalent framework with a written justification (`docs/prd.md:56-65`). Per-UC plans already assume this shape, for example TypeScript plus LangGraph with `pgvector` and BM25 (`docs/UC-plan/UC02.md:14`), LangGraph state and checkpointer resume (`docs/UC-plan/UC05.md:72-74`), and a shared interrupt and checkpointer across UCs (`docs/UC-plan/UC10.md:12-14`).

## 7. Coding-agent operating rules

- Audience and scope: this wiki is code documentation for coding agents that build and modify the repository; optimize for entrypoints, commands, paths, and invariants, covering the LangGraph workflow, read-only guards, semantic index, memory, guardrails, eval runner, and traces (`openwiki/INSTRUCTIONS.md:3-10`).
- Taxonomy: organize by system and workflow such as `agent/`, `data/`, `use-cases/`, and `evals/`, not by mirroring source directories; keep [Quickstart](../quickstart.md) as the task-routing map (`openwiki/INSTRUCTIONS.md:25-30`).
- Grounding: ground material claims in inspected source with `repo://` evidence and `file:line` citations; document loader scripts and schema files, never ignored data dumps such as `data/*.csv|*.parquet|*.db|*.sqlite|*.duckdb`; never reproduce secrets or generated run state (`openwiki/INSTRUCTIONS.md:39-44`). Language is English only, including for concepts sourced from Vietnamese PRD and UC-plan documents (`openwiki/INSTRUCTIONS.md:46-47`).
- Read boundary: [`.openwikiignore`](../../.openwikiignore) excludes `.env` files except `.env.example`, generated wiki state (`openwiki/.run.json`, `openwiki/.page-manifest.json`), dependencies and build output, and data dumps (`.openwikiignore:6-29`). [`.gitignore`](../../.gitignore) likewise excludes `.env` and `openwiki/.run.json` (`.gitignore:5-10`).
- [`AGENTS.md`](../../AGENTS.md) marks the generated `openwiki/` index as optional just-in-time context, directs retrieval use, treats source and tests as authoritative, and forbids hand-editing generated pages unless explicitly asked in favor of updating source and letting OpenWiki regenerate (`AGENTS.md:5-14`).

## Related pages

- [Quickstart](../quickstart.md): one-command setup, command table, and task-routing map.
- [Workflow architecture](../agent/workflow-architecture.md): future LangGraph loop, state, and harness ownership.
- [Eval and safety harness](../evals/eval-and-safety-harness.md): one-command eval runs, EX scoring, regression, and safety cases.
