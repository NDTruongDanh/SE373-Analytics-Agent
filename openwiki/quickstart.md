---
type: task-routing-map
title: Quickstart task map
description: Entry points, one-command setup, wiki commands, and routing links to agent, data, use-case, integration, eval, and operations domains for the SE373 Analytics Agent.
tags: [quickstart, setup, analytics-agent, routing, openwiki]
verified:
  - by: openwiki/0.7.2
    at: 2026-11-03T15:42:11.322Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-4cc9c6a076b816ea09303ac9
    resource: repo://apps/api/src/constants.ts
  - id: openwiki-source-d04d22ac02c0c45a07baad16
    resource: repo://apps/api/src/index.ts
  - id: openwiki-source-29e6795232e203660915fd20
    resource: repo://apps/web/src/constants.ts
  - id: openwiki-source-1dfd9d0040aec8cc63e58d27
    resource: repo://apps/web/src/index.ts
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-959b64ff54cd1f30f8828ba2
    resource: repo://docs/mcp_interface.md
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-6e14a80344fc52e883de4e14
    resource: repo://packages/agent/src/subgraphs/registry.ts
  - id: openwiki-source-0da85c5a9f665a701eb30287
    resource: repo://packages/agent/src/subgraphs/textToSql.ts
  - id: openwiki-source-3e1ec54e40c3b23967c408a1
    resource: repo://packages/contracts/src/constants.ts
  - id: openwiki-source-72efaf773522f7b91f911aa6
    resource: repo://packages/contracts/src/index.ts
  - id: openwiki-source-4c4499ad1e842a81b6f27cfc
    resource: repo://packages/contracts/src/tools.ts
  - id: openwiki-source-38ea9620ad4a090cbdc31b69
    resource: repo://packages/mcp-server/src/semantic/index.ts
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-448c9d8aa919e800fae5eedb
    resource: repo://scripts/generate-interface.mjs
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
generated: { by: "openwiki/0.7.2", at: "2026-11-03T15:42:11.322Z" }
---

# Quickstart task map

This repository is the **SE373 Analytics Agent** course project: a natural-language analytics agent over a fictional Vietnamese business database (`README.md:1-3`, `package.json:6`). The monorepo harness foundation — architecture, package boundaries, shared contracts, and lint boundaries — is built and the reference agent loop with its UC-01 registry extension is implemented; remaining per-UC designs are detailed in `docs/UC-plan/` and the openwiki domain pages (`docs/architecture.md:1-5`). Use this page to set up the environment, verify the toolchain, and route to the domain that owns your task.

## 1. Prerequisites

- Node.js `>=24.0.0` and pnpm `>=10`; the repo pins `pnpm@11.25.0` via `packageManager` and activates it with Corepack (`README.md:10-11`, `package.json:8-12`).
- An OpenCode Go API key (Go or Go Plus subscription); it is never committed and is pasted locally or stored as a CI secret (`README.md:42-43`, `.env.example:7-11`).
- Docker for the loopback Postgres database used by the harness operator flow (`README.md:10-11`).

## 2. One-command setup and run

Wiki docs run:

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # then fill in OPENAI_COMPATIBLE_API_KEY with your key
pnpm wiki:update:print # non-interactive; same command CI runs
pnpm typecheck && pnpm lint && pnpm test
```

This is the documented local wiki run (`README.md:55-60`); the copyable variable template lives in [`.env.example`](../.env.example) (`.env.example:6-21`). Never commit the resulting `.env`; CI instead maps the `OPENCODE_GO_API_KEY` secret to `OPENAI_COMPATIBLE_API_KEY` (`README.md:67-68`, `.env.example:9-10`, `.github/workflows/openwiki-update.yml:67`). The read boundary for what wiki runs may inspect is [`.openwikiignore`](../.openwikiignore): secrets and local state, generated wiki state, dependencies and build output, and data dumps (`data/*.csv|*.parquet|*.db|*.sqlite|*.duckdb`) (`.openwikiignore:6-14`, `.openwikiignore:16-29`). Document the loader script and schema files, never the contents of ignored dumps or secrets.

Harness operator run (needs Docker plus the DB env in `.env`):

```sh
pnpm db:up             # Postgres 16 + pgvector on 127.0.0.1:5433 (loopback only)
pnpm data:load         # full Olist-VN seed (~1M order_items, a few minutes)
pnpm data:load --scale=small  # CI-speed seed: same FK graph, ~53 s + verify
pnpm data:verify       # pins the loaded volume to data/seed_manifest.json
pnpm demo:tracer       # end-to-end proof: gateway + host, 7 PII-clean trace events
pnpm eval --uc uc09    # live harness eval (or --all); needs the DB + gateway env
pnpm skills:check      # declarative-skills invariant (no scripts/credentials)
```

This is the documented operator sequence (`README.md:13-26`). External MCP clients (MCP Inspector, `scripts/externalClient.ts`) connect to the gateway over Streamable HTTP with a per-role bearer token from `policies/mcp_clients.yaml`, whose values stay in `.env` and never enter the repo (`README.md:29-31`).

The operator hosts are [`apps/api/src/index.ts`](../apps/api/src/index.ts) — the full Express SSE host that mints run context, maps UI persona to MCP principal, invokes the root graph, and supports resume on the same thread — and [`apps/web/src/index.ts`](../apps/web/src/index.ts) — currently a web shell placeholder for the Vite + React chat UI.

## 3. Commands (entrypoints)

| Command | What it does | Source |
|---|---|---|
| `pnpm wiki:update:print` | Non-interactive wiki update; the command CI runs | `package.json:24`, `README.md:60` |
| `pnpm wiki:init` | First wiki generation | `package.json:22`, `README.md:63` |
| `pnpm wiki:update` | Interactive wiki update | `package.json:23`, `README.md:63` |
| `pnpm wiki:dry-run` | Validate without writing | `package.json:25`, `README.md:63` |
| `pnpm wiki:visualize` | Static-site export under `docs/openwiki-visualizer` | `package.json:26`, `README.md:63-66` |
| `pnpm db:up` / `pnpm db:reset` | Start / reset the loopback Postgres 16 + pgvector container | `package.json:14-15`, `README.md:18` |
| `pnpm data:load` / `pnpm data:verify` | Seed the Olist-VN business data / verify it against the seed manifest | `package.json:18-19`, `README.md:19-23` |
| `pnpm demo:tracer` | End-to-end gateway + host proof with PII-clean trace events | `package.json:16`, `README.md:24` |
| `pnpm eval` | Live harness eval runner (`--uc <id>` or `--all`) | `package.json:20`, `README.md:25` |
| `pnpm external-client` | External MCP client probe over Streamable HTTP | `package.json:17`, `README.md:29-31` |
| `pnpm skills:check` | Declarative-skills invariant check | `package.json:21`, `README.md:26` |
| `pnpm typecheck` / `pnpm build` / `pnpm clean` | TypeScript project references build (`tsc -b`) and clean | `package.json:27-29` |
| `pnpm check:workspace` | Workspace consistency check | `package.json:30` |
| `pnpm lint` | ESLint over the repo, including package import boundaries | `package.json:31` |
| `pnpm test` | Type-check plus Vitest run over the workspace | `package.json:32` |
| `pnpm docs:interface` | Regenerate `docs/mcp_interface.md` from frozen contract schemas | `package.json:33`, `scripts/generate-interface.mjs:1-2` |
| `pnpm semantic:index` | Build or refresh the semantic retrieval index (`semantic.semantic_chunks`) | `package.json:34`, `packages/mcp-server/src/semantic/index.ts:1-7` |

The full current script set is `package.json:13-34`: wiki entrypoints plus DB/data/eval entrypoints plus `typecheck`/`build`/`clean`/`check:workspace`/`lint`/`test`/`docs:interface`/`semantic:index`.

Every `wiki:*` script preloads [`scripts/openwiki-fetch-patch.mjs`](../scripts/openwiki-fetch-patch.mjs), which injects the mandatory `x-opencode-session` header (`ses_<32 hex>`) on `opencode.ai` requests (`README.md:78-85`, `scripts/openwiki-fetch-patch.mjs:22-24`). The session id is stable per process: an explicit `OPENWIKI_OPENCODE_SESSION_ID` override wins, otherwise a deterministic `repo|run_id|sha|job` hash in GitHub Actions or a random value locally, never overwriting an existing header (`scripts/openwiki-fetch-patch.mjs:44-70`, `.env.example:23-28`). The provider must stay on the Responses API (`OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true`) because the pinned model is Responses-only; `false` routes to `/chat/completions` and fails as `ModelProtocolUnsupported` (`README.md:71-77`, `.env.example:18-21`).

The interface generator [`scripts/generate-interface.mjs`](../scripts/generate-interface.mjs) (`scripts/generate-interface.mjs:1-4`) reads the frozen Zod schemas in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) (`packages/contracts/src/index.ts:1-12`) — tool I/O from `tools.ts` (`packages/contracts/src/tools.ts:8-20`, `packages/contracts/src/tools.ts:71-85`) and the frozen code list from `constants.ts` (`packages/contracts/src/constants.ts:8-21`) — and writes [`docs/mcp_interface.md`](../docs/mcp_interface.md) (`scripts/generate-interface.mjs:141-144`). It covers `list_tables`, `describe_table`, `explain_query`, `run_query`, and `sample_rows` plus the shared error-code table (`scripts/generate-interface.mjs:20-51`, `scripts/generate-interface.mjs:53-67`). It also emits the retryable/repairable routing mirror consumed by the executor (`scripts/generate-interface.mjs:106-110`, `packages/contracts/src/constants.ts:23-33`). Run `pnpm docs:interface` after changing contracts; do not hand-edit the generated file (`docs/mcp_interface.md:1-3`).

Scheduled CI ([`openwiki-update.yml`](../.github/workflows/openwiki-update.yml), `.github/workflows/openwiki-update.yml:3-7`) runs daily at `08:00 UTC` plus on demand on Node 24, installs via `pnpm/action-setup` + `actions/setup-node`, runs OpenWiki with `code --update --print`, and opens a docs-only auto-merge PR limited to `openwiki`, `AGENTS.md`, `CLAUDE.md` (`.github/workflows/openwiki-update.yml:30-53`, `.github/workflows/openwiki-update.yml:90-92`).

## 4. Repository layout

| Path | Role |
|---|---|
| [`README.md`](../README.md) | Operator setup, harness eval flow, provider/session-header caveat |
| [`package.json`](../package.json) | Scripts (`package.json:13-34`) and pinned `openwiki@0.7.2` dependency |
| [`docs/architecture.md`](../docs/architecture.md) | Harness architecture, package boundaries, shared contracts, per-UC code placement |
| [`docs/prd.md`](../docs/prd.md) | Full product requirements (11 use cases, harness, evals) |
| [`docs/mcp_interface.md`](../docs/mcp_interface.md) | Generated MCP tool interface; regenerate with `pnpm docs:interface` |
| [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) | Frozen shared Zod schemas consumed by the interface generator |
| [`apps/api/src/index.ts`](../apps/api/src/index.ts) | Full Express SSE host: `/api/ask`, `/api/runs/:runId/resume`, persona-to-principal mapping |
| [`apps/web/src/index.ts`](../apps/web/src/index.ts) | Web shell placeholder for the Vite + React operator UI |
| [`openwiki/INSTRUCTIONS.md`](INSTRUCTIONS.md) | Brief every OpenWiki run reads; defines scope, taxonomy, and grounding rules |
| [`.openwikiignore`](../.openwikiignore) | Read boundary: secrets, generated state, `node_modules/`, data dumps, evals/seeds/traces |
| [`.github/workflows/openwiki-update.yml`](../.github/workflows/openwiki-update.yml) | Scheduled wiki refresh workflow |

The agent brief scopes this wiki to code documentation for coding agents: workflow graph, read-only guards, semantic index, memory, evals, and traces — organized by system (`agent/`, `data/`, `use-cases/`, `integrations/`, `evals/`, `operations/`), not by source directory (`openwiki/INSTRUCTIONS.md:8-10`, `openwiki/INSTRUCTIONS.md:25-30`).

## 5. Task-routing map

| If you need to… | Start here | Normative spec |
|---|---|---|
| Understand the reference agent loop (understand → retrieve → plan → generate → validate → cost-gate → execute → mask → chart → review) and shared harness | [Agent workflow and harness architecture](agent/workflow-architecture.md) | [`docs/prd.md`](../docs/prd.md) §2.4 (`docs/prd.md:115-144`), [`docs/architecture.md`](../docs/architecture.md) |
| Build the semantic layer (data dictionary, metric definitions, join rules, hybrid retrieval, citations, event log) | [Semantic layer and retrieval](agent/semantic-layer.md) | [`docs/prd.md`](../docs/prd.md) §2.3 (`docs/prd.md:104-113`), UC-02 (`docs/prd.md:231-252`) |
| Enforce read-only guards, SQL validation, EXPLAIN cost gates, RBAC row/column policy, PII masking, and injection defenses | [Safety and access control](agent/safety-and-access-control.md) | [`docs/prd.md`](../docs/prd.md) §§4.1/4.3 (`docs/prd.md:507-521`, `docs/prd.md:527-538`), UC-07/UC-08 |
| Build or load the business database (8+ tables, ≥1M-row table, fake PII columns, hidden seeded scenarios) with one command | [Business database and seeded scenarios](data/database-and-seeding.md) | [`docs/prd.md`](../docs/prd.md) §2.1 (`docs/prd.md:69-90`) |
| Implement natural-language queries with bounded self-repair and ≥70% execution accuracy | [Natural-language query with self-repair (UC-01)](use-cases/text-to-sql.md) | UC-01 (`docs/prd.md:190-227`) |
| Add branching root-cause analysis with checkpoints or scheduled anomaly detection with deduped alerts | [Root-cause and anomaly alerts (UC-05, UC-10)](use-cases/root-cause-and-anomaly.md) | UC-05 (`docs/prd.md:319-345`), UC-10 (`docs/prd.md:454-481`) |
| Package DB tools as an MCP server with scoped auth plus operator surfaces (Web/CLI/Notebook) | [Database MCP server and operator software](integrations/mcp-server.md) | UC-09 (`docs/prd.md:430-449`), software (`docs/prd.md:546-554`) |
| Run evals (`pnpm eval --all`), EX scoring, regression, and mandatory safety cases | [Eval runner, metrics, and regression](evals/eval-and-safety-harness.md) | Evals and safety (`docs/prd.md:505-542`, `docs/prd.md:560-585`) |
| Change toolchain, build/test/lint/interface entrypoints, provider/session-header config, scheduled wiki CI, or submission layout | [Repository operations and wiki automation](operations/repository-operations.md) | [`README.md`](../README.md), [`.env.example`](../.env.example), [`openwiki-update.yml`](../.github/workflows/openwiki-update.yml) |

Hard invariants apply to every task: the agent builds its own SQL path (no hosted text-to-SQL/BI products), connects read-only at the connection layer, uses only synthetic or public data with fake PII, and answers in Python or TypeScript with a LangGraph-style workflow (`docs/prd.md:56-65`). Tool, skill, observability, and single-command eval requirements are fixed in the common harness contract (`docs/prd.md:505-525`, `docs/prd.md:540-542`, `docs/prd.md:560-565`).

## 6. Next steps

1. Run the setup sequence in §2 and confirm `pnpm wiki:dry-run` plus `pnpm typecheck && pnpm lint && pnpm test` pass.
2. Read the PRD scope and mandatory rules (`docs/prd.md:45-65`) before writing any agent or loader code.
3. Pick a use case from §5 and check its K1–K8 coverage row (`docs/prd.md:159-186`); a submission set must cover all eight knowledge areas.
4. Continue to [Agent workflow and harness architecture](agent/workflow-architecture.md) for the workflow and harness, and [Business database and seeded scenarios](data/database-and-seeding.md) for the dataset, seeded scenarios, and load command.
