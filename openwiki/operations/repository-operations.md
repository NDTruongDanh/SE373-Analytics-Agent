---
type: operations-guide
title: Repository operations and wiki automation
description: Toolchain, build and test entrypoints, provider and session-header
  configuration, scheduled wiki CI, and submission layout for the Analytics
  Agent monorepo.
tags: [operations, repository, openwiki-automation, configuration, ci]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-28T04:50:00.189Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-5be27729131e30130689f927
    resource: repo://docker/docker-compose.yml
  - id: openwiki-source-959b64ff54cd1f30f8828ba2
    resource: repo://docs/mcp_interface.md
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-2fda883e9b76745f69f487f7
    resource: repo://eslint.config.mjs
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-a62851a006529d8fbf774ab5
    resource: repo://packages/contracts/package.json
  - id: openwiki-source-3c3de4bf966593db2e75c054
    resource: repo://packages/data/src/load.ts
  - id: openwiki-source-7ae5af35817186c47c4b6e4d
    resource: repo://packages/data/src/verify.ts
  - id: openwiki-source-40275cb92c3610938f16ade3
    resource: repo://pnpm-workspace.yaml
  - id: openwiki-source-239b7c4787e6faba4ea0bd52
    resource: repo://policies/mcp_clients.yaml
  - id: openwiki-source-b7ac2104581a67282056d573
    resource: repo://policies/sensitive_columns.yaml
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-1d017c2ee320a152b05389a3
    resource: repo://scripts/check-workspace.mjs
  - id: openwiki-source-0414973c1f692e417872f6fc
    resource: repo://scripts/demo-tracer.ts
  - id: openwiki-source-448c9d8aa919e800fae5eedb
    resource: repo://scripts/generate-interface.mjs
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
  - id: openwiki-source-e7483dfec98b06f6039f2f12
    resource: repo://scripts/skills-check.ts
  - id: openwiki-source-4fd3e19fe0c023887ba08260
    resource: repo://semantic/data_dictionary.md
  - id: openwiki-source-df1e4d0dc0a35c64fd0e652b
    resource: repo://tsconfig.base.json
  - id: openwiki-source-98d5ddb014a0fd4d678f6f2a
    resource: repo://tsconfig.json
  - id: openwiki-source-b6f224d26b4ec604e90101e3
    resource: repo://vitest.workspace.ts
generated: { by: "openwiki/0.7.2", at: "2026-10-28T04:50:00.189Z" }
---

# Repository operations and wiki automation

This page owns the operational layer coding agents must not break: toolchain,
`pnpm` entrypoints for the harness and the wiki, inference-provider and fetch-patch
session-header configuration, scheduled wiki CI, and the expected submission
layout. It is a TypeScript monorepo (`packages/*`, `apps/*`) implementing the
`agent = model + harness` thesis: the LLM proposes, deterministic code disposes
through policy, validation, and audit (see [Workflow architecture](../agent/workflow-architecture.md)).
Start with [Quickstart](../quickstart.md) for the task-routing map.

## 1. Toolchain

- Node.js `>=24.0.0` and pnpm `>=10`; the repository pins `pnpm@11.25.0` through
  `packageManager` and activates it with Corepack (`package.json:8-12`).
- Local activation sequence is `corepack enable`,
  `corepack prepare pnpm@11.25.0 --activate`, then
  `pnpm install --frozen-lockfile` (`README.md:13-16`).
- Wiki engine is [`openwiki`](https://github.com/langchain-ai/openwiki) `0.7.2`,
  pinned in `package.json:42` plus `pnpm-lock.yaml` (`README.md:40-43`).
- Wiki CI runs on Node `24` with `pnpm/action-setup` version `11.25.0` and
  `actions/setup-node` with the pnpm cache
  (`.github/workflows/openwiki-update.yml:30-40`).
- General CI uses a shared `setup-js` composite action for checkout plus install
  and then splits gates into `typecheck`, `lint`, `policy`, `test`, `docs`,
  `db`, and `secrets` jobs behind one required `gate` check
  (`.github/workflows/ci.yml:19-33`, `.github/workflows/ci.yml:177-195`).
- `pnpm-workspace.yaml:11-13` defines the workspace globs `apps/*` and
  `packages/*`; it is not a second package definition. Build approvals live in
  `allowBuilds` for `better-sqlite3`, `esbuild`, and `@launchql/protobufjs`
  (`pnpm-workspace.yaml:1-9`). Shared dependency versions live in the `catalog:`
  section so workspace packages reference them with `catalog:` instead of
  repeating ranges (`pnpm-workspace.yaml:15-29`).

## 2. Build and runtime entrypoints

### 2.1 Harness operator scripts

The canonical operator loop is defined in `README.md:13-27` and implemented in
`package.json:14-21`:

| Command | What it does |
|---|---|
| `pnpm db:up` | Start Postgres 16 plus pgvector on `127.0.0.1:5433` from `docker/docker-compose.yml` (`package.json:14`, `docker/docker-compose.yml:27-41`) |
| `pnpm db:reset` | Drop the volume and restart the loopback database (`package.json:15`) |
| `pnpm data:load` | Full Olist-VN seed, about one million `order_items` in a few minutes (`package.json:18`, `packages/data/src/load.ts:21-27`) |
| `pnpm data:load --scale=small` | CI-speed seed with the same foreign-key graph and seed scenarios, smaller volumes (`packages/data/src/load.ts:21-27`, `.github/workflows/ci.yml:137-138`) |
| `pnpm data:verify` | Pin the loaded volume to `data/seed_manifest.json`; with `--scale=small` pin to `data/seed_manifest.small.json` (`packages/data/src/verify.ts:1-7`, `packages/data/src/load.ts:25-27`) |
| `pnpm demo:tracer` | End-to-end proof: gateway plus host, seven PII-clean trace events (`package.json:16`, `scripts/demo-tracer.ts:1-15`) |
| `pnpm eval --uc uc09` or `--all` | Live harness evaluation; needs the database plus gateway environment (`README.md:25`) |
| `pnpm skills:check` | Declarative-skills invariant: no runnable scripts, no credentials (`package.json:21`, `scripts/skills-check.ts:1-7`) |
| `pnpm external-client` | External MCP client probe over Streamable HTTP (`package.json:17`) |

The loader owns writes through owner transactions and `COPY`; the verifier
connects as owner and runs `SELECT`/`COUNT` only with zero DDL. Schema DDL lives
in `docker/initdb`, not in the loader (`packages/data/src/load.ts:1-15`,
`packages/data/src/verify.ts:1-7`). Document the loader and schema files;
never document ignored data dumps such as `data/*.csv`, `*.parquet`, `*.db`,
`*.sqlite`, or `*.duckdb` (`.openwikiignore:23-29`).

External MCP clients connect to the gateway over Streamable HTTP with a
per-role bearer token whose value stays in `.env` and whose env-var name is
resolved through `policies/mcp_clients.yaml` (`README.md:29-31`,
`policies/mcp_clients.yaml:1-4`).

Dataset attribution: the seeded business data derives from the Olist Brazilian
E-commerce dataset, localized to Vietnamese with synthetic `vi_VN` PII, used
under the CC BY-NC-SA license for non-commercial course use (`README.md:33-36`).

### 2.2 Wiki scripts

Every `wiki:*` script preloads the session-header patch with Node `--import`
before invoking the OpenWiki CLI (`package.json:22-26`):

| Command | Invocation | Purpose |
|---|---|---|
| `pnpm wiki:init` | `node --import ./scripts/openwiki-fetch-patch.mjs ./node_modules/openwiki/dist/cli/cli.js code --init` | First wiki generation (`package.json:22`, `README.md:63-64`) |
| `pnpm wiki:update` | `... cli.js code --update` | Interactive wiki update (`package.json:23`, `README.md:63-64`) |
| `pnpm wiki:update:print` | `... cli.js code --update --print` | Non-interactive update; the same command CI runs (`package.json:24`, `README.md:55-60`) |
| `pnpm wiki:dry-run` | `... cli.js --dry-run` | Validate without writing (`package.json:25`, `README.md:63-64`) |
| `pnpm wiki:visualize` | `... cli.js visualize` | Static-site export under `docs/openwiki-visualizer` (`package.json:26`, `README.md:63-67`) |

The canonical local run is copy `.env.example` to `.env`, fill in the API key
variable, then run `pnpm wiki:update:print` (`README.md:55-60`). The brief every
OpenWiki run reads is `openwiki/INSTRUCTIONS.md`; the read boundary is
`.openwikiignore` (`README.md:66-67`).

### 2.3 Quality, workspace, and interface scripts

| Command | Invocation | Purpose |
|---|---|---|
| `pnpm typecheck` | `tsc -b` | Typecheck all project references in `tsconfig.json:4` against the strict ESM `nodenext` base in `tsconfig.base.json:2-15` (`package.json:27`) |
| `pnpm build` | `tsc -b` | Emit project-reference builds (`package.json:28`) |
| `pnpm clean` | `tsc -b --clean` | Remove project-reference outputs (`package.json:29`) |
| `pnpm lint` | `eslint .` | Lint with `eslint.config.mjs:4-5` ignores for `node_modules/`, `**/dist/`, and `coverage/` (`package.json:31`) |
| `pnpm test` | `tsc -b && vitest run` | Typecheck then run the Vitest workspace (`package.json:32`, `vitest.workspace.ts:2-10`) |
| `pnpm check:workspace` | `node scripts/check-workspace.mjs` | Verify `workspace:*` links, `exports` entrypoints, `CONTRACTS_VERSION`, symlinks, and project references (`package.json:30`, `scripts/check-workspace.mjs:1-9`) |
| `pnpm docs:interface` | `tsx scripts/generate-interface.mjs` | Regenerate [`docs/mcp_interface.md`](../../docs/mcp_interface.md) from the frozen Zod schemas in `packages/contracts`; never hand-edit the output (`package.json:33`, `docs/mcp_interface.md:1-3`, `scripts/generate-interface.mjs:73-78`) |

The root gate is `pnpm typecheck && pnpm lint && pnpm test`; scoped iteration
uses `pnpm --filter @shared/<pkg> test`, and contracts changes must include a
regenerated `docs/mcp_interface.md` (`AGENTS.md:40-44`, `AGENTS.md:124-130`).
CI runs the same gates as separate jobs plus interface-drift, live-database,
workspace, skills, and secrets checks behind one `gate` status check
(`.github/workflows/ci.yml:19-102`, `.github/workflows/ci.yml:104-195`).

## 3. Type, lint, and test boundaries

- `tsconfig.base.json:2-15` selects strict TypeScript on `ES2022` with ESM
  `nodenext` module and module resolution, plus `esModuleInterop`,
  `skipLibCheck`, declarations, source maps, `resolveJsonModule`, and
  `isolatedModules`. `tsconfig.json:1-4` extends that base and references the
  seven workspace projects: `contracts`, `agent`, `mcp-server`, `access-policy`,
  `data`, `api`, and `web`.
- `vitest.workspace.ts:2-10` runs one project per package: `packages/contracts`,
  `packages/agent`, `packages/mcp-server`, `packages/access-policy`,
  `packages/data`, `apps/api`, and `apps/web`. CI's `test` job runs
  `pnpm exec vitest run` directly because the separate `typecheck` job already
  covers `tsc -b` (`.github/workflows/ci.yml:80-84`).
- `eslint.config.mjs:22-58` bans `agent`, `access-policy`, and `api` code from
  importing the `pg` driver, the `pg-cursor` driver, and `mcp-server`
  internals, with a carve-out for the `apps/api` AppStateStore DAO and its test
  (`eslint.config.mjs:15-27`). This enforces the architecture rule that only
  the MCP gateway, the operator data loader, and the AppStateStore host own the
  driver while agent, policy, and API code reach data through the MCP client or
  injected ports.
- `eslint.config.mjs:68-119` gives `apps/web` the driver ban plus the MCP-server
  ban plus the contracts-only workspace rule: the UI must take shared types
  from `@shared/contracts` only and must not import `@shared/agent`,
  `@shared/mcp-server`, `@shared/access-policy`, `@shared/api`, or
  `@shared/data`. The rule is intentionally enumerated deny-by-default so a new
  workspace package cannot slip through silently; adding a workspace package
  means extending the web `paths` list and the shared catalog
  (`eslint.config.mjs:61-67`, `pnpm-workspace.yaml:15-29`).
- `scripts/check-workspace.mjs:34-71` enforces the pnpm linking contract: every
  intra-`@shared` dependency must be `workspace:*`, every `packages/*` library
  with `src/index.ts` must expose `exports["."].default` as `./dist/index.js`,
  and every direct workspace dependency must be covered by a `tsconfig`
  project reference. It also pins `CONTRACTS_VERSION` to
  `packages/contracts/package.json` and verifies per-consumer
  `node_modules/@shared/*` symlinks resolve
  (`scripts/check-workspace.mjs:74-110`).
- `scripts/skills-check.ts:77-94` enforces the declarative-skills invariant:
  any executable file under `skills/` fails the gate, and while no `SKILL.md`
  exists it exits zero with a no-skills-yet message. When skills exist it
  rejects key blocks, URLs, and DSN connection strings and validates the eight
  canonical D-14 headings (`scripts/skills-check.ts:17-30`).
- `pnpm docs:interface` resolves Zod through the contracts package so it never
  depends on root hoisting, reads the frozen schemas from
  `packages/contracts/src/index.ts`, and writes `docs/mcp_interface.md` with a
  do-not-hand-edit header (`scripts/generate-interface.mjs:13-18`,
  `scripts/generate-interface.mjs:141-144`, `docs/mcp_interface.md:1-3`).
  CI regenerates the interface and fails on drift with
  `git diff --exit-code -- docs/mcp_interface.md`
  (`.github/workflows/ci.yml:98-102`).

## 4. Environment and provider configuration

The template is [`.env.example`](../../.env.example); the real `.env` is never
committed (`.env.example:1-3`, [`.gitignore`](../../.gitignore):5-10). In CI the
same values come from Actions secrets, not from a committed file
(`.env.example:1-3`).

Required inference settings:

- `OPENWIKI_PROVIDER=openai-compatible` (`.env.example:6`,
  `.github/workflows/openwiki-update.yml:66`).
- `OPENAI_COMPATIBLE_BASE_URL=https://opencode.ai/inference/go/openai/v1`
  (`.env.example:15`, `.github/workflows/openwiki-update.yml:68`).
- `OPENWIKI_MODEL_ID=muse-spark-1.3-contributor` (`.env.example:17`,
  `.github/workflows/openwiki-update.yml:69`).
- `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true` (`.env.example:21`,
  `.github/workflows/openwiki-update.yml:70`).

The flag must stay `true`: OpenCode Go serves this model only on the Responses
API at `POST {base}/responses`; `false` routes to `/chat/completions` and Go
answers `ModelProtocolUnsupported`, surfaced as HTTP 401 that looks like bad
auth (`.env.example:18-21`, `README.md:69-77`,
`.github/workflows/openwiki-update.yml:59-60`).

CI additionally sets
`OPENWIKI_OPENAI_COMPATIBLE_REASONING_EFFORT_SUPPORTED=true` and
`OPENWIKI_REASONING_EFFORT=xhigh` to select the xhigh reasoning variant; a
`#xhigh` model-ID suffix is not used because `#` fails OpenWiki model-ID
validation (`.github/workflows/openwiki-update.yml:61-72`). Optional LangSmith
tracing (`LANGSMITH_API_KEY`, `LANGCHAIN_PROJECT`, `LANGCHAIN_TRACING_V2`) and
the telemetry opt-out (`OPENWIKI_TELEMETRY_DISABLED=1`) are documented in
`.env.example:30-36`; the workflow leaves telemetry enabled with a commented
opt-out (`.github/workflows/openwiki-update.yml:55-57`).

Harness runtime configuration lives in the same template but is separate from
wiki inference (`.env.example:38-88`):

- Postgres loopback URLs: `DATABASE_URL` for owner work and
  `AGENT_RO_DATABASE_URL` for the read-only gateway role on
  `127.0.0.1:5433` (`.env.example:44-47`). Compose provides dev-default
  passwords for `postgres`, `owner`, `agent_ro`, `indexer`, and
  `harness_state`; those literals must match `docker/initdb/01_roles.sql` and
  must never be reused outside loopback development
  (`docker/docker-compose.yml:10-19`).
- Ports are loopback-only: `MCP_PORT=8081`, `API_PORT=3001`
  (`.env.example:49-51`).
- Bearer-token principals: static gateway tokens live only in the environment
  under names resolved by `policies/mcp_clients.yaml` (for example
  `MCP_TOKEN_SALES_SOUTH`, `MCP_TOKEN_MARKETING`, `MCP_TOKEN_HR`,
  `MCP_TOKEN_ADMIN`); the YAML file records scopes and row-scope predicates but
  never token values (`.env.example:53-74`,
  `policies/mcp_clients.yaml:1-4`).
- Two Actions secrets are required for wiki automation: `OPENCODE_GO_API_KEY`
  mapped to `OPENAI_COMPATIBLE_API_KEY`, and `OPENWIKI_PR_TOKEN` for PR
  creation and merging (`.env.example:7-11`,
  `.github/workflows/openwiki-update.yml:67`,
  `.github/workflows/openwiki-update.yml:99-103`).

## 5. Fetch-patch session header

OpenCode Go requires `x-opencode-session` on every request, otherwise it returns
`400 MissingSessionID`. OpenWiki builds its client with only `{ baseURL }` and
sends no such header, so [`scripts/openwiki-fetch-patch.mjs`](../../scripts/openwiki-fetch-patch.mjs)
patches global `fetch` via Node `--import` preload (`README.md:78-80`,
`scripts/openwiki-fetch-patch.mjs:1-20`,
`.github/workflows/openwiki-update.yml:49-53`).

Behavior contract (`README.md:78-85`,
`scripts/openwiki-fetch-patch.mjs:26-36`):

- Scope is `opencode.ai` requests only; other hosts pass through unchanged
  (`scripts/openwiki-fetch-patch.mjs:74-81`,
  `scripts/openwiki-fetch-patch.mjs:96-113`).
- Value shape is opaque `ses_` plus 32 lowercase hex characters; it never
  contains PII (`scripts/openwiki-fetch-patch.mjs:11-14`,
  `scripts/openwiki-fetch-patch.mjs:41-42`).
- Resolution order: reuse a valid `OPENWIKI_OPENCODE_SESSION_ID` override when
  set (invalid values throw); otherwise derive deterministically in GitHub
  Actions as `ses_<sha256(openwiki|repo|run_id|sha|job)[0:32]>`, stable within
  the run and unique across runs; otherwise generate a random per-process value
  locally (`scripts/openwiki-fetch-patch.mjs:44-70`,
  `.env.example:23-28`).
- One CLI run uses one process-wide value, matching Go's routing plus
  prompt-cache granularity: same conversation reuses the value, different runs
  get different values (`scripts/openwiki-fetch-patch.mjs:26-33`).
- Existing header values are never overwritten, matching upstream pass-through
  behavior (`scripts/openwiki-fetch-patch.mjs:35-36`,
  `scripts/openwiki-fetch-patch.mjs:103-110`).
- The module logs one opaque stderr prefix for traceability and never logs the
  API key (`scripts/openwiki-fetch-patch.mjs:115-119`).

Failure modes: missing or bypassed preload causes every Go call to 400; a
`false` Responses-API flag causes 401 `ModelProtocolUnsupported`; a malformed
override fails fast before any request (`scripts/openwiki-fetch-patch.mjs:57-70`,
`.env.example:18-21`).

## 6. Scheduled wiki CI

Workflow file: [`.github/workflows/openwiki-update.yml`](../../.github/workflows/openwiki-update.yml).

- Triggers: daily schedule `0 8 * * *` (08:00 UTC) plus `workflow_dispatch` for
  on-demand runs (`.github/workflows/openwiki-update.yml:3-7`).
- Permissions are `contents: write` and `pull-requests: write`
  (`.github/workflows/openwiki-update.yml:9-11`). Concurrency group
  `openwiki-update` with `cancel-in-progress: false`
  (`.github/workflows/openwiki-update.yml:13-15`).
- Checkout uses full history (`fetch-depth: 0`) so `openwiki code --update` can
  diff `HEAD` against the commit it last documented; a shallow clone would run
  against an empty change summary
  (`.github/workflows/openwiki-update.yml:21-28`).
- Install and run steps: pnpm setup, Node 24 setup with pnpm cache,
  `pnpm install --frozen-lockfile`, then
  `node --import ./scripts/openwiki-fetch-patch.mjs ./node_modules/openwiki/dist/cli/cli.js code --update --print`
  (`.github/workflows/openwiki-update.yml:30-53`). The run step uses
  `continue-on-error: true` so later steps can still open a PR preserving pages
  completed before a failure (`.github/workflows/openwiki-update.yml:45-47`,
  `.github/workflows/openwiki-update.yml:108-114`).
- Docs-only PR scope: the workflow checks out any change to itself
  (`git checkout -- .github/workflows/openwiki-update.yml`) so auto-merge never
  touches executable CI, removes transient `openwiki/.run.json`, then stages
  only `openwiki,AGENTS.md` plus `CLAUDE.md` when that file exists
  (`.github/workflows/openwiki-update.yml:74-92`). Missing-path handling
  matters because `git add` fails on a missing path.
- Creation and merge: `peter-evans/create-pull-request` opens branch
  `openwiki/update` with the dedicated `OPENWIKI_PR_TOKEN`
  (`.github/workflows/openwiki-update.yml:94-115`). On success the workflow
  merges immediately with `gh pr merge --squash --admin --delete-branch`;
  `--admin` is needed because the token identity is a ruleset bypass actor and
  `gh pr merge --auto` would wait on the one code-owner review forever
  (`.github/workflows/openwiki-update.yml:116-128`). On failure it disables
  auto-merge, annotates the PR URL, and propagates the failure with `exit 1`
  (`.github/workflows/openwiki-update.yml:130-145`).
- Also enable **Allow auto-merge** in repository pull-request settings; the
  default branch is protected and requires one code-owner review plus the `gate`
  status check (`ruleset-main.json:31-47`).

## 7. Configuration and security consequences

- Treat the database as read-only over the `agent_ro` role with
  `statement_timeout`: the gateway connects as `agent_ro` with `SELECT`-only
  grants and `BEGIN READ ONLY`, and the guard blocks DDL, DML, and dangerous
  functions before the database would reject them (`AGENTS.md:89-90`,
  `docker/docker-compose.yml:21-26`).
- Treat bearer tokens as local-only: per-role MCP tokens and the OpenCode Go
  key live in untracked `.env` or Actions secrets and never in
  `policies/mcp_clients.yaml`, logs, or traces (`.env.example:1-11`,
  `policies/mcp_clients.yaml:1-4`, `AGENTS.md:91-92`). PRs opened with the
  default `GITHUB_TOKEN` do not trigger most `pull_request` workflows, so wiki
  automation uses the dedicated `OPENWIKI_PR_TOKEN` with `Contents` and
  `Pull requests` read plus write
  (`.github/workflows/openwiki-update.yml:99-103`).
- Treat PII as fake but still redacted: seeded `vi_VN` Faker values are
  filtered by the sensitive-column set (`customers.phone`, `customers.email`,
  `customers.address`, `employees.salary`) and by regex PII scanning on query
  rows, trace events, and audit sinks (`policies/sensitive_columns.yaml:5-14`,
  `AGENTS.md:91-92`, `scripts/demo-tracer.ts:1-15`).
- Treat untrusted data as data: query rows are delimited in prompts and
  synthesis nodes run with no tools bound; treat gold data as hidden by keeping
  eval cases, seeded scenarios, and injection rows out of prompts and out of
  OpenWiki indexing (`AGENTS.md:93-97`, `.openwikiignore:31-39`).
- General CI scans every pull request and `main` push with `gitleaks` and keeps
  loopback database passwords as committed dev-only defaults that must never be
  reused for real tokens or deployed environments
  (`.github/workflows/ci.yml:163-175`,
  `.github/workflows/ci.yml:107-121`,
  `docker/docker-compose.yml:10-19`).
- New workspace packages are an extension seam with three obligations: add the
  `apps/*` or `packages/*` path if outside the current globs, reference shared
  dependencies through the pnpm `catalog:` instead of repeating ranges, and
  extend the ESLint `no-restricted-imports` guards so the new package cannot
  silently bypass DB and contract boundaries (`pnpm-workspace.yaml:11-29`,
  `eslint.config.mjs:61-67`, `scripts/check-workspace.mjs:34-71`).

## 8. Expected repository and submission layout

The PRD submission contract (`docs/prd.md:591-604`) defines the layout agent
code grows into; this operations page does not duplicate per-UC design:

- Repository must contain source code, `README` with setup, dataset source and
  license, and load instructions, plus `.env.example`, `AGENTS.md`, `data/`
  loader and transform scripts (no large re-downloadable data files),
  `semantic/` data dictionary and event log, `policies/` RBAC and masking
  rules, `skills/`, `evals/` questions and EX grader plus runner, and `docs/`
  architecture diagrams (`docs/prd.md:591`).
- Technical report must cover the `agent = model + harness` architecture,
  database source and Vietnamesization plus seeded data, submitted-UC list with
  the K1–K8 coverage table, per-UC design, failure-mode mitigations, eval and
  regression results, safety analysis, limitations, and AI-use transparency
  (`docs/prd.md:592-601`).
- Remaining deliverables are the ownership table, a demo video of at most 15
  minutes covering every submitted UC, and at least one successful sample trace
  per UC (`docs/prd.md:602-604`).
- Current repository evidence for these paths is [`README.md`](../../README.md),
  [`package.json`](../../package.json), [`docs/prd.md`](../../docs/prd.md),
  [`docs/architecture.md`](../../docs/architecture.md), `packages/data/src/load.ts`
  and `verify.ts` for the `data/` contract, [`semantic/data_dictionary.md`](../../semantic/data_dictionary.md),
  [`policies/mcp_clients.yaml`](../../policies/mcp_clients.yaml),
  [`openwiki/INSTRUCTIONS.md`](../INSTRUCTIONS.md),
  [`.openwikiignore`](../../.openwikiignore), and the workflow files above. Large
  publisher CSVs stay in untracked `data/.cache/` and seeded or gold signals
  (`evals/`, seed fixtures, manifests, trace and audit payloads) stay out of
  the wiki index (`.openwikiignore:31-39`, [`.gitignore`](../../.gitignore):20-30).

The implemented harness uses TypeScript with LangGraph.js for the workflow,
within the Python-recommended-or-TypeScript plus LangGraph-recommended-or-justified
PRD allowance (`docs/prd.md:56-65`, `AGENTS.md:20-22`). Per-UC plans and the
architecture specification already assume that shape; consult the architecture
and UC-plan documents before adding a new framework or dependency
(`AGENTS.md:73-74`).

## 9. Coding-agent operating rules

- Audience and scope: this wiki is code documentation for coding agents that
  build and modify the repository; optimize for entrypoints, commands, paths,
  and invariants, covering the LangGraph workflow, read-only guards, semantic
  index, memory, guardrails, eval runner, and traces
  (`openwiki/INSTRUCTIONS.md:3-10`).
- Taxonomy: organize by system and workflow such as `agent/`, `data/`,
  `use-cases/`, and `evals/`, not by mirroring source directories; keep
  [Quickstart](../quickstart.md) as the task-routing map
  (`openwiki/INSTRUCTIONS.md:25-30`).
- Grounding: ground material claims in inspected source with `repo://` evidence
  and `file:line` citations; document loader scripts and schema files, never
  ignored data dumps such as `data/*.csv|*.parquet|*.db|*.sqlite|*.duckdb`;
  never reproduce secrets or generated run state
  (`openwiki/INSTRUCTIONS.md:39-44`). Language is English only, including for
  concepts sourced from Vietnamese PRD and UC-plan documents
  (`openwiki/INSTRUCTIONS.md:46-47`).
- Read boundary: [`.openwikiignore`](../../.openwikiignore) excludes `.env`
  files except `.env.example`, generated wiki state
  (`openwiki/.run.json`, `openwiki/.page-manifest.json`), dependencies and
  build output, and data dumps (`.openwikiignore:6-29`).
  [`.gitignore`](../../.gitignore) likewise excludes `.env` and
  `openwiki/.run.json` (`.gitignore:5-10`).
- [`AGENTS.md`](../../AGENTS.md) marks the generated `openwiki/` index as
  optional just-in-time context, directs retrieval use, treats source and tests
  as authoritative, and forbids hand-editing generated pages unless explicitly
  asked in favor of updating source and letting OpenWiki regenerate
  (`AGENTS.md:5-14`).

## Related pages

- [Quickstart](../quickstart.md): one-command setup, command table, and task-routing map.
- [Workflow architecture](../agent/workflow-architecture.md): LangGraph loop, state, and harness ownership.
- [Eval and safety harness](../evals/eval-and-safety-harness.md): one-command eval runs, EX scoring, regression, and safety cases.
- [MCP server](../integrations/mcp-server.md): DB I/O ownership, tool contracts, and the generated interface this page's `docs:interface` entrypoint refreshes.
