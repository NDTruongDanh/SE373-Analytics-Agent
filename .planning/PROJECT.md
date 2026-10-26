# SE373 Analytics Agent

## What This Is

A natural-language analytics agent for the fictional Vietnamese e-commerce company "Chợ Sen" (localized Olist dataset, 2025–2026, VND). Business users (sales lead, marketing, HR, data admin) ask questions in Vietnamese or English; the agent retrieves the semantic layer, writes read-only SQL, validates it, executes it through a guarded MCP server, self-repairs, and answers with cited numbers, charts, and traces. It is the SE373 (Agentic AI Engineering) course project built by a student team, where each student owns at least one use case (UC) from `docs/prd.md`.

This first milestone builds the **shared agent harness** — the architecture every UC plugs into — so teammates can start their UCs in parallel without stepping on each other.

## Core Value

Every UC owner can clone the repo, run one setup command, and build their UC against a stable, enforced harness: shared contracts, a read-only Postgres with seeded data, a guarded `db-tools` path, a LangGraph.js agent skeleton, and a single trace/eval format.

## Requirements

### Validated

- ✓ OpenWiki documentation pipeline (pnpm `wiki:*` scripts, scheduled GitHub Action, `openwiki/INSTRUCTIONS.md`) — existing
- ✓ Branch protection on `main` with CODEOWNERS review — existing

### Active

- [ ] pnpm-workspace TypeScript monorepo (`apps/web`, `apps/api`, `packages/{contracts,mcp-server,access-policy,agent}`) with strict tsconfig, ESLint, vitest, CI (typecheck + lint + test + gitleaks)
- [ ] `packages/contracts`: zod schemas for the 5 db-tools (I/O), 11 standard error codes, `SQLAnswer` (incl. UC-02 `citations` + telemetry), trace/audit event envelope keyed by `runId`
- [ ] Dockerized PostgreSQL 16 + pgvector with 3 roles (`owner`, `agent_ro` read-only with `default_transaction_read_only=on` + `statement_timeout=30s`, `indexer`)
- [ ] Localized e-commerce schema (≥8 tables, FKs, fake PII columns) and one-command `pnpm data:load` with ≥1M-row table and hidden seeded scenarios/anomalies/injection rows
- [ ] db-tools core: read-only executor (`BEGIN READ ONLY`, `SET LOCAL statement_timeout`, cursor `maxRows+1`) and `sqlGuard` (pgsql-parser, single SELECT/WITH, denylist, table/column whitelist)
- [ ] Minimal MCP server `db-tools` (5 tools over Streamable HTTP) with bearer-token → scope auth so agents use MCP from day one
- [ ] LangGraph.js agent skeleton: typed state, Postgres checkpointer, node/extension seams for each UC (understand → retrieve → generate → validate → execute → answer), MCP client
- [ ] Observability + eval scaffolding: JSONL trace with PII redaction, `runId` propagation, `pnpm eval --uc <id>` runner + EX grader skeleton, `skills/` contract template
- [ ] Team onboarding: CODEOWNERS per package, architecture doc, updated `openwiki/INSTRUCTIONS.md` (TS/pnpm, new taxonomy), refreshed wiki

### Out of Scope

- Full UC implementations (UC-01 text-to-SQL loop, UC-02 RAG pipeline, UC-05 RCA, UC-10 alerts) — each owner builds these in their own milestone on top of the harness
- UC-09 advanced features beyond the minimal server (column masking/`resolveColumns`, PII post-scan, audit web page, rate limit, JWT) — owner's UC milestone
- Web UI beyond an empty Vite+React shell — product UI is built per UC later
- Hosted text-to-SQL/BI products (Vanna hosted, Copilot, Genie, …) — banned by PRD §1.5.1; violation zeroes the UC
- Python agent code / sqlglot — team standardized on TypeScript; no Python in agent path
- Real personal data — PRD §1.5.3; all PII generated with `@faker-js/faker` (vi locale)

## Context

- **Course rules (PRD §1.5):** team builds its own agent; DB access read-only at the connection layer (prompt-only blocking is insufficient); only public/synthetic data; Python or TypeScript; LangGraph or equivalent.
- **Grading:** 11 UCs × 1.5 pts (agent max 7.5) + software 2.5. Submitted UCs must cover knowledge areas K1–K8 (−0.5 per missing area). Each UC graded on U1 function, U2 harness design, U3 verification (≥5 eval cases, traces, analysis).
- **Planned UCs and owners:** UC-01 (text-to-SQL, K1/K2), UC-02 (semantic layer, K3), UC-05 (root-cause analysis, K4/K5), UC-09 (MCP db-tools, K6/K8 — owner HungPham-VNU), UC-10 (anomaly alerts, K2/K5). Plans in `docs/UC-plan/`.
- **Known coverage gap:** current UC set does not cover **K7** (only UC-03 or UC-06 provide it) — team must add one.
- **Cross-UC integration dates (from UC plans):** Phase 1 course milestone 27/10/2026 (agent with ≥2 tools on UC-09 DB core); UC-02 MCP resources by 03/11; UC-01/UC-10 over MCP by 09–10/11; shared regression eval 24–30/11.
- **Repo state at init:** only OpenWiki tooling, PRD, and UC plans — no application code. UC-09 plan's own Phase-1 tasks (monorepo, DB, guard) were scheduled 21–25/10 and are not yet started.
- **Tooling:** Node 24 via nvm, pnpm 11.25.0 via Corepack, OpenWiki 0.7.2 regenerates `openwiki/` daily via CI.

## Constraints

- **Tech stack**: TypeScript, pnpm workspaces, `@langchain/langgraph`, `zod`, `@modelcontextprotocol/sdk`, `pg` + `pg-cursor`, `pgsql-parser`, PostgreSQL 16 + pgvector, vitest, pino — agreed in UC-01/02/09/10 plans
- **Security**: agent DB role is read-only and timeout-bounded at the DB layer; every DB access goes through `db-tools` (agent must not import DB code — enforced by ESLint `no-restricted-imports`) — PRD §1.5.2, UC-09 F11
- **Data**: synthetic PII only; seeded scenarios and gold SQL hidden from the agent and from OpenWiki reads — PRD §2.1, §2.2
- **Timeline**: harness must be usable by teammates by ~28/10/2026; all UCs end ~24/11, regression 24–30/11
- **Team workflow**: `main` protected (PR + code-owner review); work happens on feature branches (this milestone: `feat/agent-harness-architecture`)
- **Runtime**: Node ≥24 (`package.json` engines) — UC-09/UC-10 docs still say Node 22

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript monorepo instead of Python | Team plans (UC-01/02/09/10) converged on TS; shared types between web/api/agent | — Pending (UC-05 plan still Python/Pydantic, needs port) |
| PostgreSQL 16 + pgvector in Docker | Read-only role + `statement_timeout` enforce safety at DB layer; pgvector serves UC-02 | — Pending |
| `pgsql-parser` for SQL guard (no sqlglot) | Real Postgres parser in WASM; TS has no sqlglot equivalent | — Pending |
| All DB access via MCP `db-tools`, from day one | Single enforcement point, independent of agent (UC-09 TC3); avoids later rewiring | — Pending |
| First milestone = harness + DB/data (not full UC-09) | Unblocks every teammate; UC-specific depth stays with owners | — Pending |
| GSD workflow: plan → execute only (research on, plan-check/verifier off) | User preference; verification done separately | — Pending |
| Node 24 | Enforced by `package.json` engines and OpenWiki CI | — Pending (team to confirm vs. Node 22 in UC docs) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-25 after initialization*
