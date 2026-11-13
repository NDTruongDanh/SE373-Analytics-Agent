---
type: operations-guide
title: Repository operations
description: Local Docker and CI operations for the monorepo — workspace, services,
  environment, quality gates, and harness_state persistence.
tags: [operations, repository, configuration, ci, docker, persistence]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-13T15:50:35.780Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-f00eaba2c90e44e4ab690b0d
    resource: repo://.github/actions/setup-js/action.yml
  - id: openwiki-source-1307a98427393d045f958ba3
    resource: repo://.github/CODEOWNERS
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-b2c87895529e27619164cb6f
    resource: repo://.github/workflows/pr-review.yml
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-d04d22ac02c0c45a07baad16
    resource: repo://apps/api/src/index.ts
  - id: openwiki-source-c4cad033353f1dc74105e364
    resource: repo://apps/api/src/ports.ts
  - id: openwiki-source-1c08bb216d9a5f9146a82fe7
    resource: repo://apps/api/src/principals.ts
  - id: openwiki-source-ec6a18eda977120fc72fe842
    resource: repo://apps/api/src/store/alertStore.ts
  - id: openwiki-source-5be27729131e30130689f927
    resource: repo://docker/docker-compose.yml
  - id: openwiki-source-a684e234421714e27e69998b
    resource: repo://docker/initdb/01_roles.sql
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
  - id: openwiki-source-3e1ec54e40c3b23967c408a1
    resource: repo://packages/contracts/src/constants.ts
  - id: openwiki-source-b9e9ae256f4d9997cea8bf48
    resource: repo://packages/data/src/constants.ts
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
  - id: openwiki-source-c16f849ab0d34fad871ef3b2
    resource: repo://ruleset-main.json
  - id: openwiki-source-1d017c2ee320a152b05389a3
    resource: repo://scripts/check-workspace.mjs
  - id: openwiki-source-0414973c1f692e417872f6fc
    resource: repo://scripts/demo-tracer.ts
  - id: openwiki-source-448c9d8aa919e800fae5eedb
    resource: repo://scripts/generate-interface.mjs
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
  - id: openwiki-source-c34cd6c7e80ed77b473e30fa
    resource: repo://scripts/pr-review.mjs
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
generated: { by: "openwiki/0.9.0", at: "2026-11-13T15:50:35.780Z" }
---

# Repository operations

This page owns the operational layer: toolchain and monorepo layout, Docker
services, environment and tokens with fake-model fallback, quality gates and
CI, and `harness_state` persistence wiring. It is a TypeScript monorepo
(`apps/*`, `packages/*`) implementing `agent = model + harness`: the LLM
proposes, deterministic code disposes through policy, validation, and audit.
Start with [Quickstart](../quickstart.md) for the task-routing map.

## 1. Toolchain and monorepo layout

- Node.js `>=24.0.0` and pnpm `>=10`; the repository pins `pnpm@11.25.0`
  through `packageManager` and activates it with Corepack
  (`package.json:8-12`).
- Local activation is `corepack enable`,
  `corepack prepare pnpm@11.25.0 --activate`, then
  `pnpm install --frozen-lockfile` (`README.md:13-16`).
- The shared CI setup composite installs the same toolchain: pnpm `11.25.0`
  and Node `24` with pnpm cache, then `pnpm install --frozen-lockfile`
  (`.github/actions/setup-js/action.yml:4-31`).
- Scheduled wiki CI also runs on Node `24` with pnpm `11.25.0`
  (`.github/workflows/openwiki-update.yml:30-40`).
- `pnpm-workspace.yaml:15-18` defines the workspace globs `apps/*` and
  `packages/*`; it is not a second package definition. The seven workspace
  projects are `contracts`, `agent`, `mcp-server`, `access-policy`, `data`,
  `api`, and `web` (`tsconfig.json:4`, `vitest.workspace.ts:2-10`).
- Build approvals live in `allowBuilds`: `true` for `better-sqlite3`,
  `esbuild`, and `@launchql/protobufjs`, and explicit `false` for
  `@openuidev/lang-core` so its install-time telemetry never runs
  (`pnpm-workspace.yaml:1-14`).
- Shared dependency versions live in the `catalog:` section so workspace
  packages reference them with `catalog:` instead of repeating ranges, so
  shared dependencies cannot drift (`pnpm-workspace.yaml:20-43`).
- Security pins for transitive dependencies live in `overrides:` (for
  example `katex`, `minimatch`, `@ag-ui/core`), each covered by the
  workspace typecheck/lint/test gate (`pnpm-workspace.yaml:45-58`).
- `minimumReleaseAgeExclude` pins selected versions that are exempt from
  minimum-release-age gating (`pnpm-workspace.yaml:60-68`).

## 2. Docker stack, db-only, data profile, and image build

Full stack file: `docker/docker-compose.yml`. CI-only file:
`docker/docker-compose.ci.yml`. Image definition: `Dockerfile`.

- Full local stack is Postgres plus pgvector, MCP gateway, API host, and web
  UI (`docker/docker-compose.yml:1-9`).
- Run everything with `docker compose up -d --build`, inspect with
  `docker compose ps` and `docker compose logs`, stop with
  `docker compose down`, wipe with `docker compose down -v` for a fresh DB
  (`README.md:26-33`). The same flows have pnpm wrappers: `pnpm docker:up`,
  `pnpm docker:down`, `pnpm docker:ps`, `pnpm docker:logs`
  (`package.json:16-17`).
- The `db` service uses `pgvector/pgvector:0.8.7-pg16` with `pgdata` and
  initdb volumes and a `pg_isready` healthcheck
  (`docker/docker-compose.yml:27-53`).
- All host ports are loopback-only: `5433` for Postgres, `8081` for MCP,
  `3001` for API, `5173` for web (`README.md:20-22`,
  `docker/docker-compose.yml:48-50`).
- `mcp` and `api` carry `fetch`-based healthchecks on `/healthz` and depend
  on `db` healthy; `api` additionally waits on `mcp` healthy; `web` waits on
  `api` healthy (`docker/docker-compose.yml:95-165`).
- Container DSNs point at `db:5432` over the compose network through the
  shared `x-app-environment` anchor; host `.env` URLs use `127.0.0.1:5433`
  and are overridden inside containers so API and MCP never try to reach
  their own loopback (`docker/docker-compose.yml:40-46`).
- Writable runtime outputs (`logs/`, `traces/`, `results/`,
  `data/.cache/`) are bind-mounted or volume-backed so redacted traces and
  audit JSONL stay visible on the host
  (`docker/docker-compose.yml:95-145`, `Dockerfile:44-50`).
- DB-only iteration uses `pnpm db:up`, which brings up only the `db` service
  (`package.json:14`, `README.md:44-46`). `pnpm db:reset` drops the volume
  and restarts the loopback database (`package.json:15`).
- Seed loading is profile-gated and never started by `up`: the `data`
  service carries `profiles: ["data"]` and runs
  `node packages/data/dist/load.js` one-shot
  (`docker/docker-compose.yml:167-180`). Run it with
  `docker compose --env-file .env -f docker/docker-compose.yml run --rm data`
  or `pnpm docker:data` (`README.md:36-40`, `package.json:20`).
- CI uses a separate db-only file on purpose: the full stack hard-requires
  `../.env` for tokens and keys, while a clean CI checkout has no `.env`.
  `docker compose -f docker/docker-compose.ci.yml up db -d --wait` works
  with no `.env` present and defines only `db` with no app services
  (`docker/docker-compose.ci.yml:1-14`, `.github/workflows/ci.yml:121-126`).
  The CI `db` service mirrors the full-stack `db` service (image,
  environment defaults, ports, volumes, healthcheck) and must be kept in
  sync, including dev-default literals matching `docker/initdb/01_roles.sql`
  (`docker/docker-compose.ci.yml:12-20`).
- The image build is multi-stage from `node:24-bookworm`: one `build` stage
  installs the pnpm workspace with `--frozen-lockfile` and compiles every
  package plus the web bundle, then fans out to `app` (`node:24-bookworm-slim`
  with compiled API and MCP gateway, different commands in compose) and
  `web` (nginx serving `apps/web/dist/site` and proxying `/api` to the API)
  (`Dockerfile:1-13`, `Dockerfile:15-31`, `Dockerfile:33-54`,
  `Dockerfile:56-62`). Runtime secrets are never baked in: `.env` is
  excluded and injected per service through compose `env_file` and
  `environment` (`Dockerfile:11-13`).

See [Database and seeding](../data/database-and-seeding.md) for roles,
schema ownership, and the loader and verifier contract.

## 3. Environment, tokens, and fake-model fallback

The template is `.env.example`; the real `.env` is never committed
(`.env.example:1-3`). In CI the same values come from Actions secrets, not
from a committed file (`.env.example:1-3`).

Harness runtime configuration:

- Postgres loopback URLs: `DATABASE_URL` and `OWNER_DATABASE_URL` for owner
  work, plus `AGENT_RO_DATABASE_URL` for the read-only gateway role,
  `INDEXER_DATABASE_URL` for the semantic indexer role, and
  `HARNESS_STATE_DATABASE_URL` for API checkpoint and alert-history state,
  all on `127.0.0.1:5433` (`.env.example:44-53`).
- Ports are loopback-only: `MCP_PORT=8081`, `API_PORT=3001`
  (`.env.example:56-58`).
- Bearer-token principals are static gateway tokens that live only in the
  environment under names resolved by `policies/mcp_clients.yaml` (for
  example `MCP_TOKEN_SALES_SOUTH`, `MCP_TOKEN_MARKETING`, `MCP_TOKEN_HR`,
  `MCP_TOKEN_ADMIN`); the YAML file records scopes and row-scope predicates
  but never token values (`.env.example:98-108`,
  `policies/mcp_clients.yaml:1-4`). Generate dev values locally and export
  them in `.env` (`.env.example:98-108`).
- Data loader and verifier connect through the owner URL; the API host boots
  only from `HARNESS_STATE_DATABASE_URL` and fails fast when it is absent,
  never falling back to in-memory state (`.env.example:47-52`,
  `apps/api/src/ports.ts:29-42`).

Fake-model fallback:

- Without an agent model key the agent runs on the deterministic fake model
  and no key is needed (`README.md:23-24`). The optional agent model
  endpoint stays unset by default (`AGENT_MODEL_API_KEY`,
  `AGENT_MODEL_BASE_URL` commented out in `.env.example:78-88`).
- When the model base URL points at OpenCode Go, the backend injects the
  mandatory `x-opencode-session` header automatically; the web path
  otherwise fails with `MissingSessionID` (`.env.example:80-87`).
- Embeddings follow the same pattern: when the embedding key is unset, the
  gateway serves deterministic fake embeddings for tests, CI, and keyless
  local runs and logs a boot warning (`.env.example:110-116`). The fixed
  embedding dimension is `1536` (`.env.example:72-76`).

Wiki inference configuration (separate from harness runtime):

- `OPENWIKI_PROVIDER=openai-compatible` (`.env.example:6`,
  `.github/workflows/openwiki-update.yml:66`).
- `OPENAI_COMPATIBLE_BASE_URL=https://opencode.ai/inference/go/openai/v1`
  (`.env.example:15`, `.github/workflows/openwiki-update.yml:68`).
- `OPENWIKI_MODEL_ID=muse-spark-1.3-contributor` (`.env.example:17`,
  `.github/workflows/openwiki-update.yml:69`).
- `OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true` (`.env.example:21`,
  `.github/workflows/openwiki-update.yml:70`).
- The flag must stay `true`: OpenCode Go serves this model only on the
  Responses API at `POST {base}/responses`; `false` routes to
  `/chat/completions` and Go answers `ModelProtocolUnsupported`, surfaced as
  HTTP 401 that looks like bad auth (`.env.example:18-21`).
- CI additionally sets
  `OPENWIKI_OPENAI_COMPATIBLE_REASONING_EFFORT_SUPPORTED=true` and
  `OPENWIKI_REASONING_EFFORT=xhigh`; a `#xhigh` model-ID suffix is not used
  because `#` fails OpenWiki model-ID validation
  (`.github/workflows/openwiki-update.yml:61-72`).
- Two Actions secrets are required for wiki automation:
  `OPENCODE_GO_API_KEY` mapped to `OPENAI_COMPATIBLE_API_KEY`, and
  `OPENWIKI_PR_TOKEN` for PR creation and merging (`.env.example:7-11`,
  `.github/workflows/openwiki-update.yml:67`).

Fetch-patch session header:

- OpenCode Go requires `x-opencode-session` on every request, otherwise it
  returns `400 MissingSessionID`. The patch module
  `scripts/openwiki-fetch-patch.mjs` patches global `fetch` via Node
  `--import` preload because OpenWiki builds its client with only
  `{ baseURL }` and sends no such header
  (`scripts/openwiki-fetch-patch.mjs:1-20`,
  `.github/workflows/openwiki-update.yml:49-53`).
- Scope is `opencode.ai` requests only; other hosts pass through unchanged
  (`scripts/openwiki-fetch-patch.mjs:74-81`).
- Value shape is opaque `ses_` plus 32 lowercase hexadecimal characters; it
  never contains PII (`scripts/openwiki-fetch-patch.mjs:11-14`,
  `scripts/openwiki-fetch-patch.mjs:41-42`).
- Resolution order: reuse a valid `OPENWIKI_OPENCODE_SESSION_ID` override
  when set (invalid values throw); otherwise derive deterministically in
  GitHub Actions as `ses_<sha256(openwiki|repo|run_id|sha|job)[0:32]>`,
  stable within the run and unique across runs; otherwise generate a random
  per-process value locally (`scripts/openwiki-fetch-patch.mjs:44-70`,
  `.env.example:23-28`).
- One CLI run uses one process-wide value, matching Go routing and
  prompt-cache granularity; existing header values are never overwritten
  (`scripts/openwiki-fetch-patch.mjs:26-36`).
- Failure modes: missing or bypassed preload causes every Go call to 400; a
  `false` Responses-API flag causes 401 `ModelProtocolUnsupported`; a
  malformed override fails fast before any request
  (`scripts/openwiki-fetch-patch.mjs:57-70`, `.env.example:18-21`).

Every `wiki:*` script preloads the patch with Node `--import` before
invoking the OpenWiki CLI (`package.json:22-26`): `pnpm wiki:init`,
`pnpm wiki:update`, `pnpm wiki:update:print` (the non-interactive command CI
runs), `pnpm wiki:dry-run`, and `pnpm wiki:visualize`.

## 4. Quality gates and CI

Local gates:

| Command | Invocation | Purpose |
|---|---|---|
| `pnpm typecheck` | `tsc -b` | Typecheck all project references in `tsconfig.json:4` against the strict ESM `nodenext` base in `tsconfig.base.json:2-15` (`package.json:27`) |
| `pnpm build` | `tsc -b` | Emit project-reference builds (`package.json:28`) |
| `pnpm clean` | `tsc -b --clean` | Remove project-reference outputs (`package.json:29`) |
| `pnpm lint` | `eslint .` | Lint with ignores for `node_modules/`, `**/dist/`, and `coverage/` (`package.json:31`, `eslint.config.mjs:4-5`) |
| `pnpm test` | `tsc -b && vitest run` | Typecheck then run the Vitest workspace (`package.json:32`, `vitest.workspace.ts:2-10`) |
| `pnpm check:workspace` | `node scripts/check-workspace.mjs` | Verify `workspace:*` links, `exports` entrypoints, `CONTRACTS_VERSION`, symlinks, and project references (`package.json:30`, `scripts/check-workspace.mjs:1-9`) |
| `pnpm docs:interface` | `tsx scripts/generate-interface.mjs` | Regenerate `docs/mcp_interface.md` from the frozen Zod schemas in `packages/contracts`; never hand-edit the output (`package.json:33`, `docs/mcp_interface.md:1-3`) |
| `pnpm semantic:index` | `tsx packages/mcp-server/src/semantic/index.ts` | Build or refresh the semantic retrieval index used by the MCP gateway (`package.json:34`) |

The root gate is `pnpm typecheck && pnpm lint && pnpm test`; scoped
iteration uses `pnpm --filter @shared/<pkg> test`, and contracts changes
must include a regenerated `docs/mcp_interface.md` (`AGENTS.md:40-44`).

- `tsconfig.base.json:2-15` selects strict TypeScript on `ES2022` with ESM
  `nodenext` module and module resolution, plus `esModuleInterop`,
  `skipLibCheck`, declarations, source maps, `resolveJsonModule`, and
  `isolatedModules`. `tsconfig.json:1-4` extends that base and references
  the seven workspace projects.
- `vitest.workspace.ts:2-10` runs one project per package:
  `packages/contracts`, `packages/agent`, `packages/mcp-server`,
  `packages/access-policy`, `packages/data`, `apps/api`, and `apps/web`.
  CI's `test` job runs `pnpm exec vitest run` directly because the separate
  `typecheck` job already covers `tsc -b`
  (`.github/workflows/ci.yml:61-84`).
- `eslint.config.mjs:22-58` bans `agent`, `access-policy`, and `api` code
  from importing the `pg` driver, the `pg-cursor` driver, and `mcp-server`
  internals, with a carve-out for the `apps/api` AppStateStore DAO and its
  test (`eslint.config.mjs:15-27`). This enforces that only the MCP gateway,
  the operator data loader, and the AppStateStore host own the driver while
  agent, policy, and API code reach data through the MCP client or injected
  ports.
- `eslint.config.mjs:60-119` gives `apps/web` the driver ban plus the
  MCP-server ban plus the contracts-only workspace rule: the UI must take
  shared types from `@shared/contracts` only. The rule is intentionally
  enumerated deny-by-default so a new workspace package cannot slip through
  silently; adding a workspace package means extending the web `paths` list
  and the shared catalog.
- `scripts/check-workspace.mjs:34-71` enforces the pnpm linking contract:
  every intra-`@shared` dependency must be `workspace:*`, every
  `packages/*` library with `src/index.ts` must expose
  `exports["."].default` as `./dist/index.js`, and every direct workspace
  dependency must be covered by a `tsconfig` project reference. It also pins
  `CONTRACTS_VERSION` to `packages/contracts/package.json` and verifies
  per-consumer `node_modules/@shared/*` symlinks resolve
  (`scripts/check-workspace.mjs:74-123`).
- `pnpm docs:interface` resolves Zod through the contracts package and
  writes `docs/mcp_interface.md` with a do-not-hand-edit header. CI
  regenerates the interface and fails on drift with
  `git diff --exit-code -- docs/mcp_interface.md`
  (`.github/workflows/ci.yml:86-103`).

General CI (`.github/workflows/ci.yml`):

- Shared `setup-js` composite action for checkout plus install, then gates
  split into `typecheck`, `lint`, `policy`, `test`, `docs`, `db`, and
  `secrets` jobs behind one required `gate` check
  (`.github/workflows/ci.yml:19-33`,
  `.github/workflows/ci.yml:177-203`).
- `policy` runs `pnpm check:workspace` and `pnpm skills:check`
  (`.github/workflows/ci.yml:47-59`).
- `test` builds workspace packages first because each runner is isolated,
  then runs unit tests only; live `*.live.test.ts` files skip without DB
  env (`.github/workflows/ci.yml:61-84`).
- `docs` regenerates the MCP interface and fails on drift
  (`.github/workflows/ci.yml:86-103`).
- `db` is the live-database job: it starts the loopback database from the
  CI-only compose file with `--wait`, runs `pnpm data:load --scale=small`
  and `pnpm data:verify --scale=small`, then runs role and grant live tests,
  MCP server live tests, agent ports live tests, and API end-to-end live
  tests, dumping DB logs on failure and tearing down with `down -v`
  (`.github/workflows/ci.yml:104-154`).
- The CI `db` job uses fake CI-only MCP tokens as test fixtures, not
  secrets, plus dev-only loopback credentials that are committed defaults
  for the local-only DB and must never be reused for real tokens
  (`.github/workflows/ci.yml:107-121`).
- `secrets` scans every pull request and `main` push with `gitleaks`
  (`.github/workflows/ci.yml:156-175`).
- `gate` is the single required check for branch protection: it requires
  all prior jobs and fails when any result is failure or cancelled, so
  adding a job never silently breaks protection
  (`.github/workflows/ci.yml:177-203`). Concurrency cancels stale PR runs
  but never cancels `main` (`.github/workflows/ci.yml:14-17`).

Harness operator scripts (`package.json:14-22`):

| Command | What it does |
|---|---|
| `pnpm db:up` | Start Postgres 16 plus pgvector on `127.0.0.1:5433` from `docker/docker-compose.yml` |
| `pnpm db:reset` | Drop the volume and restart the loopback database |
| `pnpm docker:up` / `docker:down` / `docker:ps` / `docker:logs` | Full-stack wrappers around `docker compose --env-file .env` |
| `pnpm docker:data` | One-shot profile-gated seed load via the `data` service |
| `pnpm data:load` | Full Olist-VN seed, about one million `order_items` in a few minutes (`packages/data/src/load.ts:20-28`, `packages/data/src/constants.ts:220-230`) |
| `pnpm data:load --scale=small` | CI-speed seed with the same foreign-key graph and seed scenarios, smaller volumes (one pass, 60k `order_items` target) (`packages/data/src/constants.ts:220-230`, `.github/workflows/ci.yml:128-133`) |
| `pnpm data:verify` | Pin the loaded volume to `data/seed_manifest.json`; with `--scale=small` pin to `data/seed_manifest.small.json` (`packages/data/src/verify.ts:1-7`, `packages/data/src/load.ts:25-27`) |
| `pnpm demo:tracer` | End-to-end proof over the gateway plus host pipeline (`package.json:18`, `scripts/demo-tracer.ts:1-15`) |
| `pnpm trace:show <runId>` | Offline redacted-trace viewer over `traces/<runId>.jsonl` with no DB or network I/O |
| `pnpm eval --uc uc09` or `--all` | Live harness evaluation; needs the database plus gateway environment |
| `pnpm skills:check` | Declarative-skills invariant: no runnable scripts, no credentials |
| `pnpm external-client` | External MCP client probe over Streamable HTTP |

The loader owns writes through owner transactions and `COPY`; the verifier
connects as owner and runs `SELECT`/`COUNT` only with zero DDL. Schema DDL
lives in `docker/initdb`, not in the loader (`packages/data/src/load.ts:1-15`,
`packages/data/src/verify.ts:1-7`). Document the loader and schema files;
never document ignored data dumps such as `data/*.csv`, `*.parquet`, `*.db`,
`*.sqlite`, or `*.duckdb` (`.openwikiignore:23-29`).

`pnpm demo:tracer` proves the full gateway pipeline from bearer-token auth
through scope, zod, `sqlGuard`, AccessPolicy, executor, PII scan, and audit
over Streamable HTTP without shortcuts (`scripts/demo-tracer.ts:1-15`).

## 5. Harness_state persistence wiring

- `createHostPorts(env)` builds both host ports from
  `HARNESS_STATE_DATABASE_URL` only: the PostgresSaver checkpointer via the
  agent ports barrel plus the `AppStateStore` DAO. It throws fail-fast when
  the variable is absent so the host never boots on `MemorySaver`
  (`apps/api/src/ports.ts:29-42`).
- `createCheckpointer(conn)` takes a connection string only (never a pool),
  calls `PostgresSaver.fromConnString(conn, { schema: "langgraph" })`, then
  awaits `setup()` exactly once so the four checkpoint tables exist before
  the first invoke; any setup failure throws at boot
  (`packages/agent/src/ports/checkpoints.ts:54-72`). It rejects the
  read-only `agent_ro` URL before touching the network because checkpoint
  writes require the `harness_state` owner
  (`packages/agent/src/ports/checkpoints.ts:80-93`).
- `AppStateStore` is the `app_state.alert_history` DAO as `harness_state`
  with zero grants on `public.*`, constructed from the same connection string
  with an injectable pool seam for DB-free unit tests
  (`apps/api/src/store/alertStore.ts:70-88`). All queries are parameterized;
  fingerprints are SHA-256 over canonical
  `recipientId|metric|dimensionKey|date|direction` field order through one
  helper so DAO rows and dedup checks cannot diverge
  (`apps/api/src/store/alertStore.ts:36-55`). The owned pool is capped at two
  connections (`apps/api/src/store/alertStore.ts:80-88`).
- Write-after-send contract: call `hasFingerprint(fp)` before sending
  (24-hour dedup check), then call `recordSent(row)` only after `send_alert`
  succeeds — never speculatively, never inside the send path — so retries of
  failed sends are never falsely suppressed (`apps/api/src/ports.ts:12-14`,
  `apps/api/src/store/alertStore.ts:90-120`). `recordSent` inserts one row
  and uses `ON CONFLICT (fingerprint) DO UPDATE` gated on the 24-hour
  window, so a fingerprint inside the window stays recorded while an expired
  window is updated in place instead of blocking a later alert
  (`apps/api/src/store/alertStore.ts:99-120`). The `pg` driver lives only in
  `apps/api` (this DAO) per the ESLint ban; the agent package reaches it
  only through injected ports.

For gateway DB I/O ownership, tool contracts, and the generated interface
this persistence layer supports, see [MCP server](../integrations/mcp-server.md).
For trace ownership and anomaly flows, see
[Root cause and anomaly](../use-cases/root-cause-and-anomaly.md).

## 6. Operator runbooks

- Boot the full API host only through the ports module: set
  `HARNESS_STATE_DATABASE_URL`, `MCP_URL` (or `MCP_PORT`), `API_PORT`, and
  every `MCP_TOKEN_*` named by `policies/mcp_clients.yaml`, then
  `await createHostPorts()` and `buildApp({ checkpointer, store, mcpUrl })`.
  Missing `HARNESS_STATE_DATABASE_URL` or any bearer token fails fast before
  listening — the host never falls back to `MemorySaver`
  (`apps/api/src/ports.ts:29-42`).
- Loopback bring-up order: `pnpm db:up`, then `pnpm data:load`
  (or `--scale=small` for CI), then `pnpm data:verify`; start the MCP gateway
  on `MCP_PORT=8081` and the API host on `API_PORT=3001`, and probe
  `GET /healthz` before asking (`package.json:14-20`).
- Use `pnpm db:reset` only when the volume must be dropped; initdb reruns
  only on an empty volume, so password changes require `down -v`
  (`docker/initdb/01_roles.sql:1-11`).
- Scheduled wiki CI and ownership: the workflow file
  `.github/workflows/openwiki-update.yml` triggers daily at `0 8 * * *`
  plus `workflow_dispatch`, uses full history (`fetch-depth: 0`) so the
  update can diff `HEAD`, runs the non-interactive
  `wiki:update:print` command with `--import` preload, and opens a
  docs-only PR that auto-merges
  (`.github/workflows/openwiki-update.yml:3-15`,
  `.github/workflows/openwiki-update.yml:21-53`).
- Coding agents must treat the generated wiki as optional just-in-time
  context with source as authoritative, respect the `.openwikiignore` read
  boundary including data dumps and secrets, and prefer updating source over
  hand-editing generated pages (`AGENTS.md:5-14`,
  `.openwikiignore:6-29`).
- Regression scope for operational changes: while iterating run the affected
  Vitest file (`pnpm --filter @shared/api test <file>`); before done run
  `pnpm typecheck && pnpm lint && pnpm --filter @shared/<pkg> test`; run full
  `pnpm test` when touching shared `packages/*`.

## 7. Configuration and security consequences

- Treat the database as read-only over the `agent_ro` role with
  `statement_timeout`: the gateway connects as `agent_ro` with `SELECT`-only
  grants and `BEGIN READ ONLY`, and the guard blocks DDL, DML, and dangerous
  functions before the database would reject them (`AGENTS.md:89-90`,
  `docker/docker-compose.yml:21-26`).
- Treat loopback database passwords as committed dev-only defaults that must
  match `docker/initdb/01_roles.sql` and must never be reused outside
  loopback development or for real tokens and deployed environments
  (`.env.example:52-53`, `docker/docker-compose.yml:10-19`,
  `docker/docker-compose.ci.yml:21-27`,
  `.github/workflows/ci.yml:107-121`). Overriding a `*_PASSWORD` in the
  environment changes only client URLs, not the server-side roles baked at
  initdb time (`docker/initdb/01_roles.sql:1-11`).
- Treat bearer tokens as local-only: per-role MCP tokens and the OpenCode Go
  key live in untracked `.env` or Actions secrets and never in
  `policies/mcp_clients.yaml`, logs, or traces (`.env.example:1-11`,
  `policies/mcp_clients.yaml:1-4`, `AGENTS.md:91-92`). Never reproduce
  secrets or generated run state in docs (`.openwikiignore:6-12`).
- Treat PII as fake but still redacted: seeded `vi_VN` Faker values are
  filtered by the sensitive-column set and by regex PII scanning on query
  rows, trace events, and audit sinks.
- Treat untrusted data as data: query rows are delimited in prompts and
  synthesis nodes run with no tools bound; treat gold data as hidden by
  keeping eval cases, seeded scenarios, and injection rows out of prompts and
  out of OpenWiki indexing (`.openwikiignore:31-39`).
- General CI scans every pull request and `main` push with `gitleaks` and
  keeps loopback database passwords as committed dev-only defaults
  (`.github/workflows/ci.yml:156-175`).
- New workspace packages are an extension seam with three obligations: add
  the `apps/*` or `packages/*` path if outside the current globs, reference
  shared dependencies through the pnpm `catalog:` instead of repeating
  ranges, and extend the ESLint `no-restricted-imports` guards so the new
  package cannot silently bypass DB and contract boundaries
  (`pnpm-workspace.yaml:15-43`, `eslint.config.mjs:61-67`,
  `scripts/check-workspace.mjs:34-71`).

## 8. API host and contract invariants

- Direct API host execution defaults to `API_PORT` 3001, `MCP_PORT` 8081,
  `TRACES_DIR` traces, and derives `MCP_URL` as
  `http://127.0.0.1:{MCP_PORT}/mcp` when `MCP_URL` is unset
  (`apps/api/src/index.ts:985-989`).
- Gateway authorization uses per-role bearer tokens resolved through
  `tokenEnv` names in `policies/mcp_clients.yaml` with scope and row-scope
  predicates; sensitive columns (for example customer phone, email, address
  and employee salary) are rewritten or blocked before execution and PII is
  redacted in outputs and traces (`policies/mcp_clients.yaml:1-4`,
  `policies/sensitive_columns.yaml:5-14`).
- Eval-only registry clients are validated for shape and uniqueness then
  dropped, so no persona resolves to them and boot never requires their
  bearer token; the eval scope token is only needed for `pnpm eval`
  gateways started with `MCP_ENABLE_EVAL_CLIENTS=1`
  (`.env.example:90-94`, `apps/api/src/principals.ts:109-153`).
- Workspace invariants pin `CONTRACTS_VERSION` to the
  `packages/contracts` package version so additive contract changes need one
  code-owner review and breaking changes need a major bump plus agreement
  from affected owners (`scripts/check-workspace.mjs:74-99`).
- `skills:check` fails on any executable file under `skills/` and on key
  blocks, URLs, or DSN strings, validates eight canonical
  declarative-skill headings when skills exist, and passes with a
  no-skills-yet message otherwise (`scripts/skills-check.ts:17-30`,
  `scripts/skills-check.ts:77-94`).

For the API SSE ask and resume lifecycle, persona fail-closed mapping, and
the sanitization gate, see the API host and trace documentation linked from
[Quickstart](../quickstart.md) and
[Root cause and anomaly](../use-cases/root-cause-and-anomaly.md).

## 9. Scheduled wiki automation and ownership

- Scheduled wiki CI triggers daily at `0 8 * * *` (08:00 UTC) plus
  `workflow_dispatch`, checks out full git history (`fetch-depth: 0`) so
  `openwiki code --update` can diff, installs with `--frozen-lockfile`, and
  runs `code --update --print` with `continue-on-error` to preserve partial
  pages (`.github/workflows/openwiki-update.yml:3-15`,
  `.github/workflows/openwiki-update.yml:21-53`).
- Wiki CI produces docs-only PRs limited to `openwiki`, `AGENTS.md`, and
  `CLAUDE.md` when present, excludes workflow-file changes and transient
  `openwiki/.run.json`, validates the numeric PR number, and merges with
  `--merge --admin --delete-branch` on success because the bypass actor
  skips the required code-owner review that would otherwise block auto-merge
  (`.github/workflows/openwiki-update.yml:74-128`).
- Secrets are never committed: local runs use untracked `.env` copied from
  `.env.example`, CI maps the `OPENCODE_GO_API_KEY` secret to
  `OPENAI_COMPATIBLE_API_KEY`, and PR creation and merge require the
  dedicated `OPENWIKI_PR_TOKEN` with Contents and Pull requests write
  (`.env.example:1-11`,
  `.github/workflows/openwiki-update.yml:99-103`).
- On OpenWiki failure the workflow disables auto-merge for the docs PR,
  annotates the PR URL with a notice, and propagates the failure with
  `exit 1` (`.github/workflows/openwiki-update.yml:133-148`).
- Branch protection lists `merge`, `squash`, and `rebase` as allowed merge
  methods while the update workflow merges docs-only PRs with
  `gh pr merge --merge --admin --delete-branch` after validating the PR
  number (`.github/workflows/openwiki-update.yml:116-131`,
  `ruleset-main.json:31-33`). `ruleset-main.json` protects `main` with
  deletion and non-fast-forward blocks, one code-owner review with
  stale-review dismissal and required thread resolution, and a single
  required `gate` status check with bypass actors for docs-only automation
  (`ruleset-main.json:23-48`).
- Code ownership requires approval from `@NDTruongDanh` or `@HungPham-VNU`
  on every change, with `@nguyenhun11` as third owner on contracts, agent,
  api, skills, and evals, plus per-path owners covering mcp-server,
  access-policy, web, policies, data, docker, and semantic
  (`.github/CODEOWNERS:1-29`).
- Advisory PR review is separate from the required `gate`. Workflow file:
  `.github/workflows/pr-review.yml`. It runs on pull requests into `main`
  for `opened`, `synchronize`, `reopened`, and `ready_for_review` (skipping
  drafts), with per-PR cancel-in-progress concurrency
  (`.github/workflows/pr-review.yml:20-37`). The review job reuses the
  OpenCode Go key over the Responses API with
  `muse-spark-1.3-contributor` at `xhigh` reasoning effort and the
  mandatory session header, and it is explicitly non-blocking so API or key
  failures exit zero instead of failing `gate`
  (`.github/workflows/pr-review.yml:47-56`,
  `scripts/pr-review.mjs:233-249`). The script diffs `base...HEAD` against
  `docs/architecture.md` as the source of truth, excludes lockfile,
  `openwiki`, `dist`, coverage, and log paths, truncates oversized diffs,
  and maintains one living marker comment stamped with the reviewed commit;
  missing keys, fork PRs, empty diffs, and API failures post skip or error
  notices without blocking `gate` (`scripts/pr-review.mjs:35-43`,
  `scripts/pr-review.mjs:126-155`, `scripts/pr-review.mjs:431-457`).

## 10. Submission layout and operating rules

- Submission layout requires a repository with `README`, `.env.example`,
  `AGENTS.md`, data loader and transform scripts without large
  re-downloadable files, semantic dictionary, policies RBAC and masking,
  skills, evals questions and EX grader plus runner, and docs diagrams,
  plus a technical report, ownership table, at most 15-minute demo video,
  and one sample trace per UC; the harness implements the data contract in
  `packages/data/src` with publisher cache and seeded signals kept out of
  the wiki index (`.openwikiignore:31-39`, `docs/prd.md:591-604`).
- The PRD allows Python (recommended) or TypeScript with LangGraph
  (recommended) or a justified equivalent, and the implemented harness uses
  TypeScript with LangGraph.js plus MCP and Postgres 16 with pgvector
  (`docs/prd.md:56-65`, `AGENTS.md:20-22`).
- Coding-agent operating rules: the wiki is code documentation for coding
  agents covering the LangGraph workflow, read-only guards, semantic index,
  memory, guardrails, eval runner, and traces; taxonomy is organized by
  system and workflow (for example `agent/`, `data/`, `use-cases/`,
  `evals/`), not by mirroring source directories; material claims are
  grounded in inspected source with `repo://` evidence and `file:line`
  citations; language is English only (`openwiki/INSTRUCTIONS.md:3-47`).
- Read boundary: `.openwikiignore` excludes `.env` files except
  `.env.example`, generated wiki state, dependencies and build output, and
  data dumps (`.openwikiignore:6-29`). `AGENTS.md` marks the generated
  `openwiki/` index as optional just-in-time context, treats source and
  tests as authoritative, and forbids hand-editing generated pages unless
  explicitly asked in favor of updating source and letting OpenWiki
  regenerate (`AGENTS.md:5-14`).

## Related pages

- [Quickstart](../quickstart.md): one-command setup, command table, and task-routing map.
- [Database and seeding](../data/database-and-seeding.md): roles, schema ownership, loader and verifier contracts.
- [MCP server](../integrations/mcp-server.md): DB I/O ownership, tool contracts, and the generated interface.
- [Root cause and anomaly](../use-cases/root-cause-and-anomaly.md): trace ownership and anomaly flows.
