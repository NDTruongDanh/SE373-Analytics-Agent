---
type: task-routing-map
title: Quickstart task map
description: Entry points, one-command setup, wiki commands, and routing links to agent, data, use-case, integration, eval, and operations domains for the SE373 Analytics Agent.
tags: [quickstart, setup, analytics-agent, routing, openwiki]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-26T14:44:58.914Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-72efaf773522f7b91f911aa6
    resource: repo://packages/contracts/src/index.ts
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-448c9d8aa919e800fae5eedb
    resource: repo://scripts/generate-interface.mjs
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
generated: { by: "openwiki/0.7.2", at: "2026-10-26T14:44:58.914Z" }
---

# Quickstart task map

This repository is the **SE373 Analytics Agent** course project: a natural-language analytics agent over a fictional Vietnamese business database (`README.md:1-3`, `package.json:6`). The monorepo foundation is built — harness architecture, package boundaries, shared contracts, and lint boundaries (`docs/architecture.md:1-5`) — while per-use-case agent behavior remains planned in `docs/UC-plan/` and `openwiki/`. Use this page to set up the environment, verify the toolchain, and route to the domain that owns your task.

## 1. Prerequisites

- Node.js `>=24.0.0` and pnpm `>=10`; the repo pins `pnpm@11.25.0` via `packageManager` and activates it with Corepack (`README.md:17-19`, `package.json:8-12`).
- An OpenCode Go API key (Go or Go Plus subscription); it is never committed and is pasted locally or stored as a CI secret (`README.md:20-21`, `.env.example:7-11`).

## 2. One-command setup and run

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # then fill in OPENAI_COMPATIBLE_API_KEY with your key
pnpm wiki:update:print # non-interactive; same command CI runs
pnpm typecheck && pnpm lint && pnpm test
```

This sequence is the documented local run (`README.md:25-30`); the copyable variable template lives in [`.env.example`](../.env.example) (`.env.example:6-21`). Never commit the resulting `.env`; CI instead maps the `OPENCODE_GO_API_KEY` secret to `OPENAI_COMPATIBLE_API_KEY` (`README.md:52-53`, `.env.example:7-11`). The read boundary for what wiki runs may inspect is [`.openwikiignore`](../.openwikiignore): secrets and local state, generated wiki state, dependencies and build output, and data dumps (`data/*.csv|*.parquet|*.db|*.sqlite|*.duckdb`) (`.openwikiignore:6-14`, `.openwikiignore:16-29`). Document the loader script and schema files, never the contents of ignored dumps or secrets.

## 3. Commands (entrypoints)

| Command | What it does | Source |
|---|---|---|
| `pnpm wiki:update:print` | Non-interactive wiki update; the command CI runs | `package.json:16`, `README.md:30` |
| `pnpm wiki:init` | First wiki generation | `package.json:14`, `README.md:33` |
| `pnpm wiki:update` | Interactive wiki update | `package.json:15`, `README.md:33` |
| `pnpm wiki:dry-run` | Validate without writing | `package.json:17`, `README.md:34` |
| `pnpm wiki:visualize` | Static-site export under `docs/openwiki-visualizer` | `package.json:18`, `README.md:34-36` |
| `pnpm typecheck` | TypeScript project references build (`tsc -b`) | `package.json:19` |
| `pnpm lint` | ESLint over the repo, including package import boundaries | `package.json:20` |
| `pnpm test` | Vitest run over the workspace | `package.json:21` |
| `pnpm docs:interface` | Regenerate `docs/mcp_interface.md` from frozen contract schemas | `package.json:22`, `scripts/generate-interface.mjs:1-3` |

The full current script set is `package.json:13-24`, not wiki-only: wiki entrypoints plus `typecheck`/`lint`/`test`/`docs:interface`.

Every `wiki:*` script preloads [`scripts/openwiki-fetch-patch.mjs`](../scripts/openwiki-fetch-patch.mjs), which injects the mandatory `x-opencode-session` header (`ses_<32 hex>`) on `opencode.ai` requests (`README.md:67-74`, `scripts/openwiki-fetch-patch.mjs:22-37`). The session id is stable per process: an explicit `OPENWIKI_OPENCODE_SESSION_ID` override wins, otherwise a deterministic `repo|run_id|sha|job` hash in GitHub Actions or a random value locally, never overwriting an existing header (`scripts/openwiki-fetch-patch.mjs:44-70`, `.env.example:23-28`). The provider must stay on the Responses API (`OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true`) because the pinned model is Responses-only; `false` routes to `/chat/completions` and fails as `ModelProtocolUnsupported` (`README.md:60-66`, `.env.example:18-21`).

The interface generator [`scripts/generate-interface.mjs`](../scripts/generate-interface.mjs) (`scripts/generate-interface.mjs:1-3`) reads the frozen Zod schemas in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) (`packages/contracts/src/index.ts:1-8`) and writes [`docs/mcp_interface.md`](../docs/mcp_interface.md) (`scripts/generate-interface.mjs:132-135`). It covers `list_tables`, `describe_table`, `explain_query`, `run_query`, and `sample_rows` plus the shared error-code table (`scripts/generate-interface.mjs:20-66`). Run `pnpm docs:interface` after changing contracts; do not hand-edit the generated file (`scripts/generate-interface.mjs:73-77`).

Scheduled CI ([`openwiki-update.yml`](../.github/workflows/openwiki-update.yml), `.github/workflows/openwiki-update.yml:3-7`) runs daily at `08:00 UTC` plus on demand on Node 24, installs via `pnpm/action-setup` + `actions/setup-node`, runs OpenWiki with `code --update --print`, and opens a docs-only auto-merge PR limited to `openwiki`, `AGENTS.md`, `CLAUDE.md` (`.github/workflows/openwiki-update.yml:30-53`, `.github/workflows/openwiki-update.yml:90-92`).

## 4. Repository layout

| Path | Role |
|---|---|
| [`README.md`](../README.md) | Setup, local runs, CI secrets, provider caveat |
| [`package.json`](../package.json) | Scripts (`package.json:13-24`) and pinned `openwiki@0.7.2` dependency |
| [`docs/architecture.md`](../docs/architecture.md) | Harness architecture, package boundaries, shared contracts, per-UC code placement |
| [`docs/prd.md`](../docs/prd.md) | Full product requirements (11 use cases, harness, evals) |
| [`docs/mcp_interface.md`](../docs/mcp_interface.md) | Generated MCP tool interface; regenerate with `pnpm docs:interface` |
| [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) | Frozen shared Zod schemas consumed by the interface generator |
| [`openwiki/INSTRUCTIONS.md`](INSTRUCTIONS.md) | Brief every OpenWiki run reads; defines scope, taxonomy, and grounding rules |
| [`.openwikiignore`](../.openwikiignore) | Read boundary: secrets, generated state, `node_modules/`, data dumps |
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
| Add charts plus number-grounded insights, multi-turn memory, Reviewer agent, or periodic business reports | [Agent workflow and harness architecture](agent/workflow-architecture.md) | UC-03 (`docs/prd.md:256-284`), UC-04 (`docs/prd.md:288-315`), UC-06 (`docs/prd.md:349-372`), UC-11 (`docs/prd.md:485-501`) |
| Package DB tools as an MCP server with scoped auth plus operator surfaces (Web/CLI/Notebook) | [Database MCP server and operator software](integrations/mcp-server.md) | UC-09 (`docs/prd.md:430-449`), software (`docs/prd.md:546-554`) |
| Run evals (`python -m evals.run --all`), EX scoring, regression, and mandatory safety cases | [Eval runner, metrics, and regression](evals/eval-and-safety-harness.md) | Evals and safety (`docs/prd.md:505-542`, `docs/prd.md:560-585`) |
| Change toolchain, build/test/lint/interface entrypoints, provider/session-header config, scheduled wiki CI, or submission layout | [Repository operations and wiki automation](operations/repository-operations.md) | [`README.md`](../README.md), [`.env.example`](../.env.example), [`openwiki-update.yml`](../.github/workflows/openwiki-update.yml) |

Hard invariants apply to every task: the agent builds its own SQL path (no hosted text-to-SQL/BI products), connects read-only at the connection layer, uses only synthetic or public data with fake PII, and answers in Python or TypeScript with a LangGraph-style workflow (`docs/prd.md:56-65`). Tool, skill, observability, and single-command eval requirements are fixed in the common harness contract (`docs/prd.md:505-525`, `docs/prd.md:540-542`, `docs/prd.md:560-565`).

## 6. Next steps

1. Run the setup sequence in §2 and confirm `pnpm wiki:dry-run` plus `pnpm typecheck && pnpm lint && pnpm test` pass.
2. Read the PRD scope and mandatory rules (`docs/prd.md:45-65`) before writing any agent or loader code.
3. Pick a use case from §5 and check its K1–K8 coverage row (`docs/prd.md:159-186`); a submission set must cover all eight knowledge areas.
4. Continue to [Agent workflow and harness architecture](agent/workflow-architecture.md) for the workflow and harness, and [Business database and seeded scenarios](data/database-and-seeding.md) for the dataset, seeded scenarios, and load command.
