---
type: task-routing-map
title: Quickstart task map
description: Entry points, one-command setup, and routing links to agent, data, MCP, evals, and use-case domains for the SE373 Analytics Agent.
tags: [quickstart, setup, analytics-agent, routing, openwiki]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-13T15:50:35.780Z
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
  - id: openwiki-source-c4cad033353f1dc74105e364
    resource: repo://apps/api/src/ports.ts
  - id: openwiki-source-b6c48ff1dbe6fcf04f2e36f1
    resource: repo://apps/api/src/sse.ts
  - id: openwiki-source-874170dfe5527cc01ce20f78
    resource: repo://apps/web/src/app.tsx
  - id: openwiki-source-8e8b395281c4996e784ae3b5
    resource: repo://apps/web/src/main.tsx
  - id: openwiki-source-5be27729131e30130689f927
    resource: repo://docker/docker-compose.yml
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-e1843c282db36a6d28fd4a37
    resource: repo://docs/local-setup.md
  - id: openwiki-source-959b64ff54cd1f30f8828ba2
    resource: repo://docs/mcp_interface.md
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-bfb9871db1c11a0b91b0e3c3
    resource: repo://packages/agent/src/constants.ts
  - id: openwiki-source-7a382cb67515f2241c13f47e
    resource: repo://packages/agent/src/graph.ts
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
  - id: openwiki-source-3c3de4bf966593db2e75c054
    resource: repo://packages/data/src/load.ts
  - id: openwiki-source-38ea9620ad4a090cbdc31b69
    resource: repo://packages/mcp-server/src/semantic/index.ts
  - id: openwiki-source-133b0c7d08e8e3c7f7e4fda2
    resource: repo://packages/mcp-server/src/server.ts
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-0414973c1f692e417872f6fc
    resource: repo://scripts/demo-tracer.ts
  - id: openwiki-source-448c9d8aa919e800fae5eedb
    resource: repo://scripts/generate-interface.mjs
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
generated: { by: "openwiki/0.9.0", at: "2026-11-13T15:50:35.780Z" }
---

# Quickstart task map

This repository is the **SE373 Analytics Agent**: a natural-language analytics agent over a fictional Vietnamese business. Users ask in Vietnamese or English; the agent looks up the semantic dictionary, generates `SELECT`/`WITH`, self-repairs on error, then returns tables, charts, and cited insights.

Mental model: **LLM proposes, harness disposes.** Policy, SQL validation, RBAC and masking, verification, and audit live in TypeScript code, not prompts. Stack is TypeScript, LangGraph.js, MCP (`db-tools` gateway), Postgres 16 + pgvector, and React + Vite.

Use this page to set up the environment, verify the toolchain, and route to the domain that owns your task.

## 1. Prerequisites

- Docker + Docker Compose.
- Node `>=24.0.0` and pnpm `>=10`; the repo pins `pnpm@11.25.0` via `packageManager` and activates it with Corepack.
- Ports free (loopback-only): `5433` (db), `8081` (mcp), `3001` (api), `5173` (web).
- An OpenCode Go API key for OpenWiki runs only; it is never committed and is pasted locally or stored as a CI secret. The harness agent itself runs on the deterministic fake model when no agent model key is set.

See [`README.md`](../README.md), [`package.json`](../package.json), and [`.env.example`](../.env.example). For a step-by-step Windows PowerShell startup of Docker, MCP, API, and web, see [`docs/local-setup.md`](../docs/local-setup.md).

## 2. One-command setup and run

First-time setup:

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # fill in tokens locally; never commit .env
```

`.env` carries DB URLs, `MCP_PORT` / `API_PORT`, MCP bearer tokens (`MCP_TOKEN_*`), and optional model and embedding keys. Without an agent model key the agent runs on the deterministic fake model.

Full stack with Docker (db + mcp + api + web):

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
docker compose down        # stop
docker compose down -v     # stop + wipe pgdata (fresh DB next boot)
```

Same via pnpm wrappers: `pnpm docker:up` / `pnpm docker:down` / `pnpm docker:ps` / `pnpm docker:logs`. The compose definition is [`docker/docker-compose.yml`](../docker/docker-compose.yml) with a root include in [`docker-compose.yml`](../docker-compose.yml); the database image is `pgvector/pgvector:0.8.7-pg16` and host ports are loopback-only `127.0.0.1:5433:5432` (db), `127.0.0.1:8081:8081` (mcp), `127.0.0.1:3001:3001` (api), and `127.0.0.1:5173:80` (web). Roles are `owner` / `agent_ro` / `indexer` / `harness_state`.

Harness operator run (needs Docker plus the DB env in `.env`):

```sh
pnpm db:up             # compose db service only
pnpm data:load         # full Olist-VN seed (~1M order_items, ~6 min)
pnpm data:load --scale=small  # CI-speed seed: same FK graph, <2 min
pnpm data:verify       # pins the loaded volume to the seed manifest
pnpm demo:tracer       # end-to-end proof: gateway + host, PII-clean trace events
pnpm trace:show <runId>  # render a stored redacted trace; no DB or network I/O
pnpm eval --uc uc09    # live harness eval (or --all); needs the DB + gateway env
pnpm skills:check      # declarative-skills invariant (no scripts or credentials)
```

Load seed data one-off through the profile-gated service instead when running the full stack: `docker compose --profile data run --rm data` (or `pnpm docker:data`). Verify in the browser at `http://127.0.0.1:5173`, then check `traces/` (per-run) and `logs/mcp_audit.jsonl` (PII-redacted).

Local iteration without Docker for the app layer:

```sh
corepack pnpm build
node --env-file=.env --import tsx packages/mcp-server/src/server.ts
node --env-file=.env --import tsx apps/api/src/index.ts
corepack pnpm --filter @shared/web dev
```

Check `http://127.0.0.1:3001/healthz` (api) and `http://127.0.0.1:8081/healthz` (mcp). The operator hosts are [`apps/api/src/index.ts`](../apps/api/src/index.ts) — Express SSE host that mints run context, maps UI persona to MCP principal, invokes the root graph, and supports resume on the same thread — with persistence ports from [`apps/api/src/ports.ts`](../apps/api/src/ports.ts) (fails fast when `HARNESS_STATE_DATABASE_URL` is absent) and sanitized streaming via [`apps/api/src/sse.ts`](../apps/api/src/sse.ts).

Wiki docs run:

```sh
pnpm wiki:update:print # non-interactive; same command CI runs
pnpm wiki:dry-run      # validate without writing
pnpm typecheck && pnpm lint && pnpm test
```

The copyable variable template is [`.env.example`](../.env.example). Never commit the resulting `.env`; CI maps the `OPENCODE_GO_API_KEY` secret to `OPENAI_COMPATIBLE_API_KEY`. The read boundary for wiki runs is [`.openwikiignore`](../.openwikiignore): secrets and local state, generated wiki state, dependencies and build output, data dumps (`data/*.csv|*.parquet|*.db|*.sqlite|*.duckdb`), evals, seeded scenarios and manifests, traces, audit payloads, and results. Document the loader script and schema files, never the contents of ignored dumps or hidden gold signals.

Every `wiki:*` script preloads [`scripts/openwiki-fetch-patch.mjs`](../scripts/openwiki-fetch-patch.mjs), which injects a stable opaque `x-opencode-session` header (`ses_` plus 32 hex chars) on `opencode.ai` requests to satisfy the mandatory OpenCode Go routing requirement. Inference must stay on the Responses API (`OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true`) because the pinned model is Responses-only; routing to `/chat/completions` fails as `ModelProtocolUnsupported` surfaced as HTTP 401. Scheduled wiki CI runs daily at `08:00 UTC` plus on demand on Node 24, installs with `pnpm/action-setup` and `actions/setup-node`, runs the same wiki update command, and opens a docs-only auto-merge PR limited to `openwiki`, `AGENTS.md`, and `CLAUDE.md`.

## 3. Commands (entrypoints)

| Command | What it does |
|---|---|
| `pnpm wiki:update:print` | Non-interactive wiki update; the command CI runs |
| `pnpm wiki:init` / `pnpm wiki:update` | First generation / interactive update |
| `pnpm wiki:dry-run` | Validate without writing |
| `pnpm wiki:visualize` | Static-site export |
| `pnpm db:up` / `pnpm db:reset` | Start / reset the loopback Postgres 16 + pgvector container |
| `pnpm docker:up` / `pnpm docker:down` / `pnpm docker:ps` / `pnpm docker:logs` | Full-stack equivalents of `docker compose up/down/ps/logs` |
| `pnpm docker:data` | One-shot seed load through the profile-gated `data` service |
| `pnpm data:load` / `pnpm data:verify` | Seed the Olist-VN business data / verify it against the seed manifest |
| `pnpm demo:tracer` | End-to-end gateway + host proof with PII-clean trace events |
| `pnpm trace:show` | Render a stored PII-redacted trace bundle without DB or network I/O |
| `pnpm external-client` | External MCP client probe over Streamable HTTP |
| `pnpm eval` | Live harness eval runner (`--uc <id>` or `--all`) |
| `pnpm skills:check` | Declarative-skills invariant check |
| `pnpm alert:run` | Manual or scheduled anomaly-alert runner |
| `pnpm typecheck` / `pnpm build` / `pnpm clean` | TypeScript project-references build (`tsc -b`) and clean |
| `pnpm check:workspace` | Workspace consistency check |
| `pnpm lint` | ESLint over the repo, including package import boundaries |
| `pnpm test` | Type-check plus Vitest run over the workspace |
| `pnpm docs:interface` | Regenerate `docs/mcp_interface.md` from frozen contract schemas |
| `pnpm semantic:index` | Build or refresh the semantic retrieval index (`semantic.semantic_chunks`) |

The full set is defined in [`package.json`](../package.json). The interface generator reads the frozen Zod schemas in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts) and writes [`docs/mcp_interface.md`](../docs/mcp_interface.md); run `pnpm docs:interface` after changing contracts and do not hand-edit the generated file. The semantic indexer is [`packages/mcp-server/src/semantic/index.ts`](../packages/mcp-server/src/semantic/index.ts) and writes as the `indexer` role.

## 4. Repository layout

| Path | Role |
|---|---|
| [`README.md`](../README.md) | Operator setup, Docker flow, dataset, and gate summary |
| [`AGENTS.md`](../AGENTS.md) | Contributor rules, boundaries, and gates |
| [`package.json`](../package.json) | Scripts and pinned toolchain |
| [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) | Workspace packages (`apps/*`, `packages/*`) and shared catalog versions |
| [`docs/architecture.md`](../docs/architecture.md) | Harness architecture, package boundaries, shared contracts, per-UC placement |
| [`docs/local-setup.md`](../docs/local-setup.md) | Step-by-step local startup on Windows PowerShell and troubleshooting |
| [`docs/prd.md`](../docs/prd.md) | Full product requirements (use cases, harness, evals) |
| [`docs/mcp_interface.md`](../docs/mcp_interface.md) | Generated MCP tool interface; regenerate with `pnpm docs:interface` |
| [`.env.example`](../.env.example) | Copyable env template; never commit the filled `.env` |
| [`docker/docker-compose.yml`](../docker/docker-compose.yml) | Services, loopback ports, roles, volumes, and profile-gated loader |
| [`packages/agent/src/graph.ts`](../packages/agent/src/graph.ts) | Frozen root LangGraph builder; extend only via registry and injected seams |
| [`packages/agent/src/subgraphs/registry.ts`](../packages/agent/src/subgraphs/registry.ts) | Sole UC wiring seam (`registerUC`); `tracer` stays the default route |
| [`packages/mcp-server/src/server.ts`](../packages/mcp-server/src/server.ts) | MCP `db-tools` gateway over Streamable HTTP |
| [`packages/data/src/load.ts`](../packages/data/src/load.ts) / [`packages/data/src/verify.ts`](../packages/data/src/verify.ts) | Deterministic Vietnamized Olist loader / manifest verifier |
| [`scripts/demo-tracer.ts`](../scripts/demo-tracer.ts) | One-command live proof used by `pnpm demo:tracer` |
| [`scripts/trace-show.ts`](../scripts/trace-show.ts) | Redacted trace renderer used by `pnpm trace:show` |
| [`scripts/externalClient.ts`](../scripts/externalClient.ts) | Scoped-token gateway probe used by `pnpm external-client` |
| [`.openwikiignore`](../.openwikiignore) | Read boundary: secrets, generated state, deps, dumps, evals, seeds, traces |
| [`.github/workflows/openwiki-update.yml`](../.github/workflows/openwiki-update.yml) | Scheduled wiki refresh workflow |

## 5. Task-routing map

| If you need to… | Start here |
|---|---|
| Understand the reference agent loop and shared harness (root graph, UC registry, budgets, HITL, checkpointing) | [Agent workflow and harness architecture](agent/workflow-architecture.md) |
| Build the semantic layer (dictionary, metrics, hybrid retrieval, citations, embeddings) | [Semantic layer and retrieval](agent/semantic-layer.md) |
| Enforce read-only guards, SQL validation, cost gates, RBAC and masking, PII redaction, and injection defenses | [Safety and access control](agent/safety-and-access-control.md) |
| Build or load the business database (Olist-VN tables, ~1M-row table, fake PII, hidden seeded scenarios) | [Business database and seeding](data/database-and-seeding.md) |
| Implement natural-language queries with bounded self-repair and execution accuracy | [Natural-language query with self-repair (UC-01)](use-cases/text-to-sql.md) |
| Add branching root-cause analysis or scheduled anomaly detection with deduped alerts | [Root cause and anomaly alerts (UC-05, UC-10)](use-cases/root-cause-and-anomaly.md) |
| Package DB tools as an MCP server with scoped auth plus operator surfaces | [Database MCP server and gateway](integrations/mcp-server.md) |
| Run evals (`pnpm eval --all`), execution-accuracy scoring, regression, and mandatory safety cases | [Eval runner, metrics, and regression](evals/eval-and-safety-harness.md) |
| Change toolchain, Docker services, env, gates, wiki provider config, scheduled wiki CI, or submission layout | [Repository operations and wiki automation](operations/repository-operations.md) |

Hard invariants apply to every task: the agent builds its own SQL path (no hosted text-to-SQL products), connects read-only at the connection layer as `agent_ro`, uses only synthetic or public data with fake PII, and answers through a LangGraph-style workflow. Tool, skill, observability, and single-command eval requirements are fixed in the common harness contract.

## 6. Next steps

1. Run the setup sequence in §2 and confirm `pnpm wiki:dry-run` plus `pnpm typecheck && pnpm lint && pnpm test` pass.
2. Read the PRD scope and mandatory rules before writing any agent or loader code.
3. Pick a use case from §5 and check its coverage row; a submission set must cover the required knowledge areas.
4. Continue to [Agent workflow and harness architecture](agent/workflow-architecture.md) for the workflow and harness, and [Business database and seeding](data/database-and-seeding.md) for the dataset, seeded scenarios, and load command.
