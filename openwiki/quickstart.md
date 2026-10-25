---
type: task-routing-map
title: Quickstart task map
description: Entry points, one-command setup, wiki commands, and routing links to architecture, data, use-case, and eval domains for the SE373 Analytics Agent.
tags: [quickstart, setup, analytics-agent, routing, openwiki]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-25T07:25:04.439Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-6d4b4e707b8d60b6ccfa3425
    resource: repo://.github/workflows/openwiki-update.yml
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-a11884925ded039ec27120f5
    resource: repo://scripts/openwiki-fetch-patch.mjs
generated: { by: "openwiki/0.7.2", at: "2026-10-25T07:25:04.439Z" }
---

# Quickstart task map

This repository is the **SE373 Analytics Agent** course project: a natural-language analytics agent over a fictional Vietnamese business database (`README.md:1-3`, `package.json:6`). The repo is currently in **initial setup** — wiki tooling, PRD, and use-case plans exist, but no agent, database loader, or eval code has been landed yet. Use this page to set up the environment, run the wiki, and route to the domain that owns your task.

## 1. Prerequisites

- Node.js `>=24.0.0` and pnpm `>=10`; the repo pins `pnpm@11.25.0` via `packageManager` and activates it with Corepack (`README.md:14-16`, `package.json:8-12`).
- An OpenCode Go API key (Go or Go Plus subscription); it is never committed and is pasted locally or stored as a CI secret (`README.md:9-10`, `README.md:17-18`).

## 2. One-command setup and run

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # then fill in OPENAI_COMPATIBLE_API_KEY with your key
pnpm wiki:update:print # non-interactive; same command CI runs
```

This sequence is the documented local run (`README.md:22-28`); the copyable variable template lives in [`.env.example`](../.env.example) (`.env.example:6-21`). Never commit the resulting `.env`; CI instead maps the `OPENCODE_GO_API_KEY` secret to `OPENAI_COMPATIBLE_API_KEY` (`README.md:45-50`).

## 3. Commands (entrypoints)

| Command | What it does | Source |
|---|---|---|
| `pnpm wiki:update:print` | Non-interactive wiki update; the command CI runs | `package.json:16`, `README.md:27` |
| `pnpm wiki:init` | First wiki generation | `package.json:14`, `README.md:30` |
| `pnpm wiki:update` | Interactive wiki update | `package.json:15`, `README.md:30` |
| `pnpm wiki:dry-run` | Validate without writing | `package.json:17`, `README.md:30-31` |
| `pnpm wiki:visualize` | Static-site export under `docs/openwiki-visualizer` | `package.json:18`, `README.md:31-33` |

Every `wiki:*` script preloads [`scripts/openwiki-fetch-patch.mjs`](../scripts/openwiki-fetch-patch.mjs), which injects the mandatory `x-opencode-session` header (`ses_<32 hex>`) on `opencode.ai` requests (`README.md:64-71`, `scripts/openwiki-fetch-patch.mjs:1-37`). The provider must stay on the Responses API (`OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API=true`) because the pinned model is Responses-only; `false` routes to `/chat/completions` and fails as `ModelProtocolUnsupported` (`README.md:57-63`, `.env.example:18-21`).

Scheduled CI (`.github/workflows/openwiki-update.yml:3-7`) runs daily at `08:00 UTC` plus on demand on Node 24, installs via `pnpm/action-setup` + `actions/setup-node`, runs OpenWiki, and opens a docs-only auto-merge PR limited to `openwiki`, `AGENTS.md`, `CLAUDE.md` (`README.md:38-43`, `.github/workflows/openwiki-update.yml:30-43`).

## 4. Repository layout

| Path | Role |
|---|---|
| [`README.md`](../README.md) | Setup, local runs, CI secrets, provider caveat |
| [`package.json`](../package.json) | Scripts and pinned `openwiki@0.7.2` dependency |
| [`docs/prd.md`](../docs/prd.md) | Full product requirements (11 use cases, harness, evals) |
| [`docs/UC-plan/`](../docs/UC-plan/) | Per-use-case plans landed so far: UC-01, UC-02, UC-05, UC-09, UC-10 |
| [`openwiki/INSTRUCTIONS.md`](INSTRUCTIONS.md) | Brief every OpenWiki run reads; defines scope, taxonomy, and grounding rules |
| [`.openwikiignore`](../.openwikiignore) | Read boundary: secrets, generated state, `node_modules/`, data dumps |
| [`.github/workflows/openwiki-update.yml`](../.github/workflows/openwiki-update.yml) | Scheduled wiki refresh workflow |

The agent brief scopes this wiki to code documentation for coding agents: workflow graph, read-only guards, semantic index, memory, evals, and traces — organized by system (`agent/`, `data/`, `use-cases/`, `evals/`), not by source directory (`openwiki/INSTRUCTIONS.md:8-10`, `openwiki/INSTRUCTIONS.md:25-30`).

## 5. Task-routing map

| If you need to… | Start here | Normative spec |
|---|---|---|
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Understand the agent loop (understand → retrieve → generate → validate → execute → chart → review) | [Architecture overview](architecture/overview.md) | [`docs/prd.md`](../docs/prd.md) §2.4 (`docs/prd.md:115-144`) |
<!-- openwiki: broken internal link [data/database.md] file "data/database.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Build or load the database (8+ tables, ≥1M-row table, PII columns, seeded scenarios) | [Database](data/database.md) | [`docs/prd.md`](../docs/prd.md) §2.1 (`docs/prd.md:69-90`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Implement text-to-SQL with bounded self-repair and ≥70% execution accuracy | [Architecture overview](architecture/overview.md) | UC-01 (`docs/prd.md:190-227`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Build the semantic layer (chunking, hybrid retrieval, citations) | [Architecture overview](architecture/overview.md) | UC-02 (`docs/prd.md:231-252`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Add charts plus number-grounded insights | [Architecture overview](architecture/overview.md) | UC-03 (`docs/prd.md:256-284`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Add multi-turn state, checkpointer resume, and compaction | [Architecture overview](architecture/overview.md) | UC-04 (`docs/prd.md:288-315`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Add branching root-cause analysis with plan checkpoints | [Architecture overview](architecture/overview.md) | UC-05 (`docs/prd.md:319-345`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Add the read-only Reviewer agent (≤2 rounds) | [Architecture overview](architecture/overview.md) | UC-06 (`docs/prd.md:349-372`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Gate costly queries with `EXPLAIN`, approval, and audit log | [Architecture overview](architecture/overview.md) | UC-07 (`docs/prd.md:376-400`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Enforce RBAC row/column policy and PII masking in code | [Architecture overview](architecture/overview.md) | UC-08 (`docs/prd.md:404-426`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Package DB tools as an MCP server with scoped tools | [Architecture overview](architecture/overview.md) | UC-09 (`docs/prd.md:430-449`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Run scheduled anomaly detection with deduped alerts | [Architecture overview](architecture/overview.md) | UC-10 (`docs/prd.md:454-481`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Generate periodic business reports grounded in the event log | [Architecture overview](architecture/overview.md) | UC-11 (`docs/prd.md:485-501`) |
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Run evals (`python -m evals.run --all`), EX scoring, regression, safety cases | [Architecture overview](architecture/overview.md) | Evals and safety (`docs/prd.md:505-542`, `docs/prd.md:560-585`) |

Hard invariants apply to every task: the agent builds its own SQL path (no hosted text-to-SQL/BI products), connects read-only at the connection layer, uses only synthetic or public data with fake PII, and answers in Python or TypeScript with a LangGraph-style workflow (`docs/prd.md:56-65`). Tool, skill, observability, and single-command eval requirements are fixed in the common harness contract (`docs/prd.md:505-525`, `docs/prd.md:540-542`, `docs/prd.md:560-565`).

## 6. Next steps

1. Run the setup sequence in §2 and confirm `pnpm wiki:dry-run` passes.
2. Read the PRD scope and mandatory rules (`docs/prd.md:45-65`) before writing any agent or loader code.
3. Pick a use case from §5 and check its K1–K8 coverage row (`docs/prd.md:159-186`); a submission set must cover all eight knowledge areas.
<!-- openwiki: broken internal link [architecture/overview.md] file "architecture/overview.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [data/database.md] file "data/database.md" does not exist. Fix the href or restore the target, then delete this comment. -->
4. Continue to [Architecture overview](architecture/overview.md) for the workflow and harness, and [Database](data/database.md) for the dataset, seeded scenarios, and load command.
