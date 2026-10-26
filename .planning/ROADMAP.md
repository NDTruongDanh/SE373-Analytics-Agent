# Roadmap: SE373 Analytics Agent

## Overview

This milestone builds the **v1.0 Shared Agent Harness** — the stable, enforced foundation every UC owner plugs into — before any UC behavior lands. The journey runs contracts-first (Phase 1 freezes the zod schemas everything imports and the ESLint DB-import ban, due ~28/10 because UC-01 M3, UC-02 resources on 03/11, and UC-09/UC-10 cutovers all block on it), then data and guard layers in parallel (Phases 2–3: Postgres roles plus seeded data alongside the sqlGuard and read-only executor), then the MCP gateway the agent must use from day one (Phase 4), then the agent skeleton and the trace/eval scaffolding in parallel (Phases 5–6: the 27/10 course bar — an agent run calling ≥2 db-tools — is met when Phase 5 lands on top of Phase 4), and finally end-to-end wiring, shells, and team onboarding (Phase 7: one-command setup proven, regression evidence, docs refreshed). UC-owned behavior (text-to-SQL repair loop, RAG quality, RCA planner, anomaly engine, masking depth) stays out; the harness ships seams, not UCs.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Monorepo + Contracts Freeze** - pnpm workspaces, CI, DB-import ban, and frozen zod contracts everything imports (completed 2026-10-25)
- [ ] **Phase 2: Postgres Roles + Seeded Data** - Read-only roles proven by test plus deterministic ≥1M-row localized dataset
- [x] **Phase 3: SQL Guard + Read-Only Executor** - AST allowlist guard and read-only executor as an importable library (completed 2026-10-25)
- [ ] **Phase 4: MCP db-tools Server + Scope Auth** - 5 tools over Streamable HTTP with bearer-token scope enforcement
- [ ] **Phase 5: Agent Skeleton + Root Graph** - LangGraph.js graph with checkpointer, MCP client, seams, and ≥2-tools run
- [ ] **Phase 6: Trace, Eval + Skills Scaffolding** - JSONL trace with PII redaction, EX grader, eval runner, safety suite
- [ ] **Phase 7: E2E Wiring, Shells + Team Onboarding** - One-command setup, streaming shells, architecture docs, regression evidence

## Phase Details

### Phase 1: Monorepo + Contracts Freeze

**Goal**: Every UC owner builds against one frozen set of contracts and one enforced repo layout
**Depends on**: Nothing (first phase)
**Requirements**: REPO-02, REPO-03, REPO-04, REPO-05, REPO-06, CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, CONT-06
**Success Criteria** (what must be TRUE):
  1. Owner can clone, run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` at root and per package, all green on Node 24
  2. Owner can import the 5 db-tool schemas, 11 error codes with `DbToolError`, `SQLAnswerSchema` (with `citations` + telemetry), the trace event envelope, and semantic chunk metadata from `@se373/contracts`
  3. `docs/mcp_interface.md` regenerates from the zod schemas via `pnpm docs:interface`, so docs never drift from code
  4. A PR that imports `pg`, `pg-cursor`, or mcp-server internals from `packages/agent` or `apps/*` fails lint, and every PR runs green CI (typecheck + lint + test + gitleaks v3)

**Plans**: 3/3 plans complete
- [x] 01-01-PLAN.md
- [x] 01-02-PLAN.md
- [x] 01-03-PLAN.md

### Phase 2: Postgres Roles + Seeded Data

**Goal**: Teammates develop against a realistic local database where read-only safety is proven at the DB layer, not by prompt wording
**Depends on**: Phase 1
**Requirements**: DB-01, DB-02, DB-03, DB-04, DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, DATA-07
**Success Criteria** (what must be TRUE):
  1. Owner can run `pnpm db:up` (pinned `pgvector/pgvector:0.8.7-pg16`) and `pnpm data:load` to get ≥8 FK-linked localized tables over 2025–2026 with `order_items` ≥ 1,000,000 rows, deterministically (seeded RNG + checksums)
  2. An automated test proves `agent_ro` cannot INSERT/UPDATE/DELETE/CREATE/use TEMP even after `SET default_transaction_read_only=off` or `BEGIN READ WRITE`
  3. `pnpm data:verify` confirms row counts, FK integrity, and that every seeded scenario (≥3 variance, ≥5 anomaly, ≥3 injection rows) is detectable by a reference SQL
  4. Gold SQL, gold results, and `data/seeded_scenarios.md` are unreachable from agent code and OpenWiki (a test fails if agent code reads them), and the README documents source, CC BY-NC-SA 4.0 attribution, and every transformation

**Plans**: 2/4 plans executed
- [x] 02-01-PLAN.md
- [x] 02-02-PLAN.md
- [ ] 02-03-PLAN.md
- [ ] 02-04-PLAN.md

### Phase 3: SQL Guard + Read-Only Executor

**Goal**: UC owners get a proven SQL safety layer they can import as a library before any network transport exists
**Depends on**: Phase 1 (parallelizable with Phase 2 — different teammate, disjoint files; live-DB executor tests need Phase 2 roles up; table/column whitelist syncs with the Phase 2 schema)
**Requirements**: GUARD-01, GUARD-02, GUARD-03, GUARD-04, GUARD-05, GUARD-06
**Success Criteria** (what must be TRUE):
  1. `sqlGuard` accepts exactly one SELECT/WITH (incl. UNION) and rejects DDL/DML, multi-statements, `SELECT INTO`, `FOR UPDATE`, data-modifying CTEs, denylisted functions, and unknown tables/columns — covered by ≥30 vitest cases (malicious + valid)
  2. The read-only executor runs `BEGIN READ ONLY` → `SET LOCAL statement_timeout` → cursor `read(maxRows+1)` → `ROLLBACK`, returns `{columns, rows, rowCount, truncated, durationMs}`, and always releases the connection; timeouts surface as `TIMEOUT` with no host/user/DSN/path/stack leakage
  3. Owner can import the guard for local pre-flight, and UC-09 can plug column enforcement into the `AccessPolicy` / `ColumnScopePolicy` stub wired to `policies/sensitive_columns.yaml` without changing the (future) server

**Plans**: 4/4 plans complete
- [x] 03-01-PLAN.md
- [x] 03-02-PLAN.md
- [x] 03-03-PLAN.md
- [x] 03-04-PLAN.md

### Phase 4: MCP db-tools Server + Scope Auth

**Goal**: All database access flows through one enforced MCP gateway from day one, so no agent code ever needs rewiring
**Depends on**: Phase 3 (needs guard + executor; also needs Phase 2 database)
**Requirements**: MCP-01, MCP-02, MCP-03, MCP-04, MCP-05
**Success Criteria** (what must be TRUE):
  1. MCP Inspector can list and call all 5 tools over stateless Streamable HTTP with zod input/output schemas
  2. Requests without a bearer token get 401; a token without the tool's scope (`schema:read` vs `data:read`) gets `SCOPE_DENIED`; an invalid `policies/mcp_clients.yaml` refuses server boot
  3. `explain_query` never runs `ANALYZE`, `sample_rows` is capped at 5 rows, and `run_query` enforces maxRows and timeout server-side regardless of caller claims
  4. Every call writes exactly one redacted audit JSONL line (client, scope, tool, redacted params, rowCount, durationMs, decision, `runId` from `X-Run-Id`)

**Plans**: TBD

### Phase 5: Agent Skeleton + Root Graph

**Goal**: Every UC owner can run and extend the shared LangGraph.js agent without editing shared graph code (27/10 course bar met here: agent run calling ≥2 db-tools over MCP)
**Depends on**: Phase 4 (parallelizable with Phase 6 — different teammate, disjoint files)
**Requirements**: AGENT-01, AGENT-02, AGENT-03, AGENT-04, AGENT-05, AGENT-06, AGENT-07
**Success Criteria** (what must be TRUE):
  1. One compiled root graph runs the linear path `understand → retrieve (stub) → generate → validate → execute → answer` against the MCP server with a per-role bearer token, calling ≥2 db-tools end-to-end (course Phase-1 bar)
  2. A run can be resumed by `threadId` after process restart (PostgresSaver `setup()` at boot), and `interrupt()` + `Command({resume})` pauses/resumes end-to-end (proven by test)
  3. Owner can register a node/subgraph, tool, or router branch in their own file without editing a shared graph-builder file
  4. LLM access goes through one configurable chat-model factory (OpenAI-compatible base URL + key from `.env`), CI runs keyless via a fake/stub model, and tool results are delimiter-wrapped as untrusted data in prompts

**Plans**: TBD

### Phase 6: Trace, Eval + Skills Scaffolding

**Goal**: Every run is traceable, every UC is gradable with the same runner and grader, and skills follow one contract
**Depends on**: Phase 1 (parallelizable with Phases 2–5 — different teammate, disjoint files; needs only the frozen trace/benchmark contracts)
**Requirements**: OBS-01, OBS-02, EVAL-01, EVAL-02, EVAL-03, EVAL-04, EVAL-05
**Success Criteria** (what must be TRUE):
  1. Every run emits JSONL trace events (contract envelope, `runId`) covering nodes, tool calls, SQL attempts, errors, tokens and estimated cost under `traces/`, with phone/email PII redacted (a canary test proves a seeded fake PII value never appears in traces/logs/audit)
  2. Owner can run `pnpm eval --uc <id>` / `pnpm eval --all` to discover cases under `evals/<uc>/` and write structured results to `results/<uc>.json`, graded by the shared order-insensitive EX grader (±0.5% float tolerance, normalized NULL/numeric/timestamp)
  3. The benchmark JSONL schema lives in contracts with a validator and 3-question sample, and the 5 PRD §4.3 attack cases form a safety suite recording which layer blocked each
  4. `skills/_template/SKILL.md` defines the PRD §4.2 contract and a lint rejects executable scripts or DB credentials in `skills/`

**Plans**: TBD

### Phase 7: E2E Wiring, Shells + Team Onboarding

**Goal**: A new teammate is productive within one session: one setup command, a streaming UI shell, docs that answer "how do I add my UC", and regression evidence
**Depends on**: Phase 5 and Phase 6
**Requirements**: REPO-01, OBS-03, DOCS-01, DOCS-02, DOCS-03
**Success Criteria** (what must be TRUE):
  1. Owner can run `pnpm install && pnpm db:up && pnpm data:load` from a clean clone on Node 24 and get a working local stack
  2. Owner can ask a question via `POST /api/ask` streaming graph events over SSE, resume an interrupt via `POST /api/resume`, and watch the stream render in the empty Vite+React shell
  3. `docs/architecture.md` (layers, boundaries, one-question data flow, extension seams, "how to add your UC", mermaid diagram) plus updated `openwiki/INSTRUCTIONS.md` (TS/pnpm, new taxonomy, `.env`-loading wiki scripts) and Node-24/TS-port/K7-gap updates let a teammate add a UC without asking the harness author
  4. `pnpm eval --all` runs green twice as regression evidence before handoff

**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7, except parallelizable work noted in Depends on fields: Phase 3 with Phase 2; Phase 6 with Phases 2–5; Phase 5 with Phase 6.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Monorepo + Contracts Freeze | 3/3 | Complete    | 2026-10-25 |
| 2. Postgres Roles + Seeded Data | 2/4 | In Progress | - |
| 3. SQL Guard + Read-Only Executor | 4/4 | Complete    | 2026-10-25 |
| 4. MCP db-tools Server + Scope Auth | 0/TBD | Not started | - |
| 5. Agent Skeleton + Root Graph | 0/TBD | Not started | - |
| 6. Trace, Eval + Skills Scaffolding | 0/TBD | Not started | - |
| 7. E2E Wiring, Shells + Team Onboarding | 0/TBD | Not started | - |
