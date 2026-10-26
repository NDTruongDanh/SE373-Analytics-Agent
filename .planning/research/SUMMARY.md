# Project Research Summary

**Project:** SE373 Analytics Agent (Chợ Sen) — shared agent harness milestone
**Domain:** TypeScript LangGraph.js text-to-SQL analytics agent over read-only PostgreSQL + pgvector, exposed via guarded MCP `db-tools`
**Researched:** 2026-10-26
**Confidence:** HIGH

## Executive Summary

This milestone builds the **shared agent harness** — not end-user features. It is the infrastructure every use-case (UC) owner plugs into: a pnpm TypeScript monorepo with shared zod contracts, a Dockerized PostgreSQL 16 + pgvector database with localized Olist data and three least-privilege roles, a read-only `sqlGuard` + executor, a minimal MCP `db-tools` server (5 tools over Streamable HTTP with bearer-token scope auth), a LangGraph.js agent skeleton with Postgres checkpointer, and a single JSONL trace/eval format keyed by `runId`.

The recommended approach is **contracts-first, then DB roles, then guard, then MCP, then agent skeleton, then semantic/eval scaffolding** — because every UC (UC-01 text-to-SQL, UC-02 semantic layer, UC-05 RCA, UC-09 db-tools, UC-10 anomaly alerts) consumes the contracts and the MCP gateway, and building the agent on direct DB calls before MCP lands is the #1 rework risk. All DB access goes through MCP from day one, enforced at three independent layers (server-side AST guard + least-privilege grants + PII post-scan), never by prompt wording alone.

The key risks are all grade-zero under PRD §1.5: (1) treating `default_transaction_read_only` as a security boundary when it is session-overridable — grants must be the load-bearing layer; (2) first-keyword SQL guards that pass side-effecting `SELECT`s (verified precedent: CVE-2026-61788 / GHSA-mwwr-p57h-56pf in @bytebase/dbhub, fixed in 0.22.6) — the guard must be a recursive AST allowlist plus function denylist; (3) PII leaking through traces, logs, error strings, and audit literals. Each has a concrete harness-phase owner and a vitest/canary verification defined below.

## Key Findings

### Recommended Stack

TypeScript-first harness on Node 24 + pnpm 11.25.0 workspaces with project references. All versions verified via `npm view` on 2026-10-25 (see STACK.md). The single shared `zod@^4.6.7` satisfies every consumer's peer range (SDK, mcp-adapters, langgraph, openai); `pgsql-parser@^18.3.1` + `@pgsql/traverse` provide the real-Postgres guard; `pgvector/pgvector:0.8.7-pg16` (pinned, not floating) backs both business data and UC-02 vectors.

**Core technologies:**
- Node.js 24.x (`engines >=24.0.0`) + pnpm 11.25.0 via Corepack — runtime + workspaces; strict `node_modules` layout catches phantom DB imports
- `typescript@~6.0.3` — last JS-line compiler; TS 7 breaks `typescript-eslint@8.72.0` (peers `<6.1.0`), so TS 7 is deferred
- `zod@^4.6.7` — single shared contracts version; native `z.toJSONSchema()` for F14 interface docs (see contradiction resolution below)
- `@modelcontextprotocol/sdk@^1.32.2` (spec 2025-11-25) + `@langchain/mcp-adapters@~1.1.4` — v1 server + v1-line client on the same spec generation; v2 migration is post-milestone
- `@langchain/langgraph@^1.5.2` + `@langchain/langgraph-checkpoint-postgres@^1.1.2` + `@langchain/core@^1.3.0` — root graph + subgraphs, one PostgresSaver at root
- `pg@^8.23.1` + `pg-cursor@^2.22.1` — read-only executor (`BEGIN READ ONLY`, `SET LOCAL statement_timeout`, `read(maxRows+1)` + `truncated`)
- `pgsql-parser@^18.3.1` + `@pgsql/traverse@^18.8.1` — `sqlGuard` real-PG parse + AST walk + deparse for masking rewrites (parse is async; warm up once at boot)
- `express@^5.3.0` — blessed host for Streamable HTTP + `requireBearerAuth`; `pino@^10.4.0` JSONL audit with redact; `yaml@^2.9.1` policy parsing
- `pgvector/pgvector:0.8.7-pg16` Docker — 3 roles (`owner` / `agent_ro` / `indexer`); `agent_ro` gets `default_transaction_read_only=on` + `statement_timeout=30s` as layer 3, grants as layer 1
- `vitest@^5.0.5` + `vite@^8.3.5` + `react@^19.3.1` (web shell only) + `@faker-js/faker@^10.6.0` (vi locale with en fallback) for synthetic PII seed data

Details: `.planning/research/STACK.md`.

### Expected Features

Harness = infrastructure every UC builds on. UC-owned behavior stays out. Freeze deadline for contracts: 26–28/10 (blocks UC-01 M3, UC-02 resources 03/11, UC-09 Tuần A, UC-10 cutover 09–10/11).

**Must have (table stakes):**
- Monorepo skeleton + CI (typecheck + lint + test + gitleaks v3) + CODEOWNERS + `no-restricted-imports` DB ban — unblocks all 5 UCs
- `packages/contracts` zod schemas: 5 tool I/O, 11 error codes, `SQLAnswer` (+citations + telemetry), trace/audit envelope keyed by `runId` — highest-leverage item
- Postgres 16 + pgvector, 3 roles, `agent_ro` read-only proven by vitest (incl. SET-override variant)
- Read-only executor + `sqlGuard` (single `SelectStmt`, recursive DML/`intoClause`/`lockingClause` rejection, FuncCall denylist, table/column whitelist)
- Minimal MCP `db-tools` (5 tools, no `ANALYZE` in `explain_query`) + bearer→scope auth (`schema:read` / `data:read` / `data:sensitive`), YAML clients, fail-fast boot
- `AccessPolicy` interface + `ColumnScopePolicy` skeleton + `sensitive_columns.yaml` plumbing (M1 = interface + metadata flags; full enforcement = UC-09 Tuần B)
- Seeded loader `pnpm data:load` (≥8 tables, `order_items` ≥1M, fakerVI PII, 3 RCA scenarios + 5 anomaly points + ≥3 injection rows, hidden gold) + benchmark ≥30 VI questions + EX grader (0.5% tolerance, order-intent tag) + `pnpm eval --uc` runner + shared 5-case safety suite
- Trace/audit JSONL with `runId` propagation + PII redaction; LangGraph.js skeleton (typed state, checkpointer, MCP client, ≥2 tools end-to-end by 27/10); `skills/` template; semantic storage + indexer CLI + 2 MCP resources (by 03/11)

**Should have (competitive, cheap-only in M1):**
- PII post-scan regex layer; EXPLAIN cost signal in trace; external-client demo + Inspector docs; empty-but-routed web/api shells; (UC-owned depth: RRF tuning, detector, planner, repair loop stay in UC milestones)

**Defer (v2+ / P2 anti-features):**
- Full UC logic in harness; JWT + rate limit; row-level RLS; reviewer/approval/chart/memory/scheduler agents; Python agent code; hosted BI products (PRD-banned, scores 0); prompt-only safety; real PII; gold visible to agent; rich M1 UI; `run_python` sandbox

Details: `.planning/research/FEATURES.md`.

### Architecture Approach

Presentation (`apps/web`) → orchestration (`apps/api`, creates `threadId`/`runId`, SSE streaming) → agent (`packages/agent`, one compiled root graph + per-UC subgraphs sharing `BaseState`) → data plane (`packages/mcp-server`, sole DB gateway: auth→zod→sqlGuard→AccessPolicy→executor→PII-scan→audit) → state+data (Postgres: business, `semantic_chunks`, `langgraph.*`, `app_state.*`). Cross-cutting: `packages/contracts` (imported by everything, imports only zod), `packages/access-policy` (pure AST functions), `policies/*.yaml`, `semantic/*.yaml`, `skills/*/`, `evals/` + `traces/*.jsonl`.

**Major components:**
1. `packages/contracts` — zod single source of truth (tool I/O, 11 codes, SQLAnswer, Alert, chunk metadata, trace envelope)
2. `packages/mcp-server` — 5 tools + 2 resources, stateless Streamable HTTP, per-tool scope checks, read-only executor, redacted audit
3. `packages/agent` — root graph (`understand→retrieve→generate→validate→execute→answer`) + UC-01/05/10 subgraphs, retriever node, citation validator, MCP client; never imports `pg`/DB code
4. Postgres roles — `owner` (DDL/load), `agent_ro` (SELECT-only business reads), `indexer` (semantic/checkpoint/alert writes); separate pools per role
5. `apps/api` + `apps/web` — thin HTTP/SSE boundary + empty shells; no LLM/SQL-AST logic in web

Details: `.planning/research/ARCHITECTURE.md`.

### Critical Pitfalls

Top grade-zero and load-bearing pitfalls (10 critical total in PITFALLS.md; verification commands in "Looks Done But Isn't" checklist):

1. **`default_transaction_read_only` treated as the security boundary** — it is a USERSET GUC any session can unset; grants (SELECT-only, no TEMP/CREATE/sequence-UPDATE, zero role membership) are the load-bearing layer; add SET-override vitest variant — address in DB-roles phase, first.
2. **First-keyword SQL guards pass side-effecting SELECTs (verified: CVE-2026-61788 / GHSA-mwwr-p57h-56pf, NVD + GitLab advisory + OSV, fixed in dbhub 0.22.6)** — `pg_sleep`, `FOR UPDATE`, `INTO TEMP`, data-modifying CTEs, stacked statements, `dblink`/`pg_read_file`/`lo_export` all pass naive checks; guard must be recursive AST allowlist + FuncCall denylist + `stmts.length===1`, with ≥30 tests incl. every vector — address in sqlGuard phase before `run_query` is exposed.
3. **PII leaks via traces/logs/errors/audit** — mask projection (fail-closed) + regex post-scan + single `sanitizeError()` choke point + canary-sweep CI test; deny sensitive columns anywhere in query, not just projection.
4. **pgsql-parser handling** — async WASM warm-up once at boot, pin exact version, `length===1` + full-tree walk, re-parse after deparse masking rewrite, fail-closed on unresolvable sensitive refs.
5. **Prompt injection via seeded data rows** — delimiter-wrap tool outputs, never let result content change SQL, trace-flag imperative sentences, eval cases asserting non-compliance.

Details: `.planning/research/PITFALLS.md`.

## Implications for Roadmap

Suggested 7-phase harness roadmap (contracts → data → guard → gateway → agent → semantic/eval → hardening). Parallelizable phases marked **[P]** — disjoint owners, no shared-file contention once contracts are frozen.

### Phase 1: Monorepo + contracts freeze
**Rationale:** Everything imports contracts; the ESLint DB-import ban must exist before any agent/DB code lands. Earliest deadline (26–28/10) with widest blast radius.
**Delivers:** pnpm workspaces, strict tsconfig + project refs, ESLint flat + `no-restricted-imports`, vitest, CI (typecheck+lint+test+gitleaks v3), `packages/contracts` (tool I/O, 11 codes, SQLAnswer+citations+telemetry, trace envelope), CODEOWNERS, `docs/mcp_interface.md` generation via `z.toJSONSchema()`.
**Addresses:** Table-stakes skeleton + contracts; UC-01/02/09 contract freeze dates.
**Avoids:** C8 contract churn / team collisions; C6 zod-duplication (single `zod@^4.6.7` + `workspace:*`).

### Phase 2: Postgres roles + seeded data [P with Phase 3 start after roles land]
**Rationale:** All UCs need data; the role test proves PRD §1.5.2 independently of app code. Loader schema changes after gold capture invalidate the benchmark, so land early.
**Delivers:** Compose (`0.8.7-pg16` pinned), `01_roles.sql` (least-privilege from zero, TEMP/CREATE revoked, no memberships), `pnpm data:load` (seeded RNG + checksums, stratified ≥1M duplication, weekday-preserving date shift, hidden gold/scenarios), `data:verify` assertions, README Olist CC BY-NC-SA 4.0 attribution.
**Addresses:** Roles, seeded content, hidden scenarios, license compliance.
**Avoids:** C1 SET-override bypass; C9 duplication/drift/license gaps; C10 nondeterminism.

### Phase 3: sqlGuard + read-only executor (no MCP yet)
**Rationale:** Proving guard + grants before networking isolates parser failures from transport failures; UC-01 imports the guard as a *library* for local pre-flight.
**Delivers:** `sqlGuard` (recursive AST allowlist, denylist, whitelist), `resolveColumns` stub (FROM/JOIN/`*`/1-level CTE, fail-closed), `db.ts` executor, `errors.ts` + `sanitizeError()`, ≥30 guard tests + SET-override test.
**Addresses:** Executor, sqlGuard, standardized errors.
**Avoids:** C2 guard bypasses (incl. CVE-2026-61788 class); C4 parser mishandling.

### Phase 4: Minimal MCP db-tools + scope auth
**Rationale:** Agent must use MCP from day one (UC-09 F11) — kills the #1 rework risk of direct-call now, rewire later. External-client demo (TC3) proves server-side enforcement.
**Delivers:** Stateless `StreamableHTTPServerTransport` (per-request factory), `requireBearerAuth` at app level + per-tool `requireScope`, 5 tools + zod I/O, `explain_query` ANALYZE-reject, redacted audit JSONL with `runId`, scope-matrix + double-token tests.
**Addresses:** 5 tools, auth, error envelope over the wire.
**Avoids:** C6 transport/auth/zod pitfalls; C3 audit-literal leaks.

### Phase 5: Agent skeleton + root graph [P with Phase 6]
**Rationale:** Gives UC-01 a runnable loop, UC-05 interrupt/checkpoint rails, UC-10 slice-invoke pattern — all UCs proceed in parallel from here.
**Delivers:** `BaseState` (StateSchema + reducers), linear path `understand→retrieve(stub)→generate→validate→execute→answer`, PostgresSaver + `setup()` boot, MCP client (per-role bearer), SSE streaming, interrupt plumbed + resume endpoint, reducer/interrupt/resume/isolation tests.
**Addresses:** Skeleton, checkpointer, trace envelope emission, skills prompt framing vs injection rows.
**Avoids:** C7 reducer/setup/resume/serialization/`thread_id` pitfalls; C5 injection handling baseline.

### Phase 6: Semantic storage + eval/trace scaffolding [P with Phase 5]
**Rationale:** UC-02 MCP resources due 03/11; EX grader + safety suite are the highest grading-pts-per-effort items and need the longest soak.
**Delivers:** `semantic/*.yaml` + zod lint, chunker + SHA-256 incremental indexer, `semantic_chunks` HNSW, 2 MCP resources, `POST /api/semantic/reindex`, benchmark ≥30 + EX grader + `eval --uc/--all` runner + 5-case safety suite + gold-exclusion test + dataset_version pinning, canary PII sweep.
**Addresses:** Semantic contract, benchmark, grader, runner, safety suite, observability envelope.
**Avoids:** C9/C10 leakage/drift/ordering/tolerance gaps; C3 trace leaks.

### Phase 7: E2E wiring + hardening + team onboarding
**Rationale:** Follows PRD §6.3 (≥2 full runs with before/after analysis); freezes `BaseState` keys + tool signatures before UC milestones fork.
**Delivers:** ≥2-tools E2E over MCP (27/10 bar), PII post-scan, empty web/api shells, CODEOWNERS enforcement, arch doc + `openwiki/INSTRUCTIONS.md` refresh, regression `eval --all` ×2, redaction sweep, report + demo.
**Addresses:** Onboarding, shells, regression evidence.
**Avoids:** C8 merge gridlock; residual C3/C6/C7 gaps. Defers JWT/rate-limit/`run_python`/RLS/rich UI to UC-owned P2 (explicit anti-features).

### Phase Ordering Rationale

- Contracts (Phase 1) require nothing and block everything — any slip past 28/10 cascades to UC-01 M3, UC-02 resources, UC-09 Tuần A, UC-10 cutover (FEATURES dependency graph).
- DB roles before guard before MCP (Phases 2→3→4): each layer is independently testable, and `run_query` must never be exposed before both grant and AST layers are proven (C1+C2).
- Agent skeleton (Phase 5) needs something to call (Phase 4 tools), but semantic quality (Phase 6 retrieval tuning) must NOT block the skeleton — hence stub-retrieve first, quality later, and Phases 5‖6 parallelizable by different teammates.
- Hardening last (Phase 7) because redaction sweeps, regression ×2, and onboarding docs are only meaningful once all seams exist.

### Research Flags

Phases likely needing deeper research during planning (`--research-phase`):
- **Phase 3 (sqlGuard + ColumnScopePolicy):** deparse round-trip fidelity over the eval corpus, `@pgsql/parser` version-16-grammar fallback decision, fail-closed coverage table — parser-AST niche, sparse docs.
- **Phase 6 (retriever quality + EX edge cases):** RRF weighting / join-rule expansion tuning, float/NULL/ordering-intent grader edges — needs measurement, not just docs.

Phases with standard patterns (skip research-phase):
- **Phase 1:** pnpm workspaces + project refs + flat ESLint — stable, long-standing docs.
- **Phase 2:** Postgres role GRANTs + `COPY` loader — official PG 16 docs, settled practice.
- **Phase 4:** Stateless Streamable HTTP + bearer middleware — SDK v1 reference + verified `.d.ts`.
- **Phase 5:** Root-graph + PostgresSaver + `Command(resume)` — current LangGraph.js docs verified 2026-10-26.
- **Phase 7:** Shells + onboarding + regression runs — process work, no API risk.

## Contradiction Resolutions (explicit)

1. **zod version (STACK vs PITFALLS C6):** STACK wins. Use single `zod@^4.6.7` workspace-wide — verified each consumer accepts v4 (SDK `^3.25 || ^4.0`, adapters `^3.25.76 || ^4`, langgraph `^3.25.32 || ^4.2.0`, openai `^3.25.76 || ^4`). PITFALLS C6's "`zod@^3.25`" floor and `zod-to-json-schema` recommendation are superseded: that lib is v3-only and throws on v4 schemas. **Decision:** v4 everywhere; `z.toJSONSchema()` for docs; `zod/v3` subpath only as escape hatch; CI asserts one zod copy.
2. **Node version (PROJECT vs UC-09/UC-10 docs):** PROJECT wins. **Node 24** (`engines >=24`) — matches `package.json`, OpenWiki CI, and MCP SDK Web-Crypto requirement. UC docs still saying Node 22 are stale; update them during Phase 1.
3. **Build order (ARCHITECTURE 0–8 vs FEATURES dependency notes):** No real conflict — both agree contracts → DB → guard → MCP → agent → semantic → hardening. **Decision:** adopt ARCHITECTURE's 9-step order compressed into the 7 phases above (monorepo+contracts merged; corpus+retriever merged into one parallelizable phase with the agent skeleton; UC extensions explicitly out of harness scope per PROJECT.md).
4. **gitleaks version (STACK vs UC docs):** STACK wins — **`gitleaks/gitleaks-action@v3`**; v2 is dead (Node 20 runner removed 2026-09-16). Migrate any UC-doc snippet still on v2.
5. **UC-05 language (PROJECT/FEATURES vs UC-05 plan):** Team decision wins — **TypeScript only** in agent path (PRD §1.5 + team convergence). UC-05's Python/Pydantic state must be ported to `RCAState` zod + LangGraph.js; no `sqlglot`/Python in harness.
6. **Masking depth (FEATURES scope note vs ARCH pipeline):** Aligned — harness M1 ships `AccessPolicy` interface + metadata flags + fail-closed stub; full `ColumnScopePolicy` enforcement is UC-09 Tuần B. UC-01 stays insulated via its own `LocalQuerySafetyGate`.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Every pin verified via `npm view` + published-tarball `.d.ts` inspection on 2026-10-25; zod-compat matrix checked against each package's deps/peers |
| Features | HIGH | Grounded line-by-line in PRD + all five UC plans with `file:line` citations; freeze dates cross-checked |
| Architecture | HIGH | LangGraph.js + MCP SDK claims verified against current official docs (fetched 2026-10-26); ID/thread/resume semantics confirmed |
| Pitfalls | HIGH | PG 16 docs + SDK/LangGraph docs + Kaggle/Olist license page checked; dbhub CVE verified live (see below) |

**Overall confidence:** HIGH

### Gaps to Address

- **K7 coverage gap:** current UC set provides no K7 (only UC-03 or UC-06); team must add one UC — flag at roadmap creation, not solvable in harness.
- **`@types/pg-cursor@2.7.2` vs `pg-cursor@2.22.1` major lag:** API surface used (`connect/read/close`) is stable, but lock with a load smoke test (STACK).
- **Line-18 grammar superset vs PG16:** fail-safe direction (rejects less, never bypasses), but if eval shows PG17/18-syntax slippage, switch guard to `@pgsql/parser` with `version: 16` (STACK alternative).
- **Faker `vi` thin coverage:** build `new Faker({ locale: [vi, en, base] })` fallback chain so the ≥1M-row load never throws (STACK).
- **Residual `WHERE`-probe / length side channels:** documented as rate-limit + audit-flag treatment, not a completeness claim — UC-08 eval scope.

## Sources

### Primary (HIGH confidence)
- npm registry `npm view` (2026-10-25): all pins, deps, peerDeps, dist-tags in STACK.md — single-zod compat matrix
- Published tarball `.d.ts` inspection: `requireBearerAuth` signature, `registerTool` outputSchema/structuredContent, `MultiServerMCPClient`, `PostgresSaver`, `ChatOpenAI configuration` passthrough
- MCP TS SDK docs + server reference (fetched 2026-10-26): `McpServer`, `registerTool/Resource`, stateless vs stateful StreamableHTTP, `requireBearerAuth({verifier})` — team pins v1.x `@modelcontextprotocol/sdk`
- LangGraph.js docs (fetched 2026-10-26): `StateSchema`/`ReducedValue`, subgraphs, interrupts + `Command(resume)`, persistence + `PostgresSaver.setup()`
- `docs/prd.md` §§1.5, 2.1–2.3, 4.1–4.4, 6.1–6.3 + `docs/UC-plan/UC01/02/05/09/10.md` + `.planning/PROJECT.md` — authoritative requirements, dates, ownership
- NVD `CVE-2026-61788` + GitHub advisory `GHSA-mwwr-p57h-56pf` + OSV entry + GitLab AD + fix PR bytebase/dbhub#342 — first-keyword classifier failure precedent (verified live 2026-10-26; aliases match; fixed in 0.22.6)
- PostgreSQL 16 docs: `SET TRANSACTION` / Hot Standby / `default_transaction_read_only` USERSET semantics; Olist Kaggle page (CC BY-NC-SA 4.0); pgsql-parser monorepo README (async parse, deparse, 23k-statement corpus)

### Secondary (MEDIUM confidence)
- LangChain SQL-agent tutorials + Vanna OSS docs (RAG-corpus idea only; hosted parts PRD-banned) — reference patterns, fetched 2026-10-25
- Faker docs (vi → fakerVI, fallback-chain pattern); Docker Hub API (`0.8.7-pg16` pushed 2026-10-01); gitleaks v3.0.0 release notes; TS 7.0 announcement + typescript-eslint #10940/#12803
- DBGorilla read-only-role walkthrough (SET-override demo); SO #43229887 (`nextval` in read-only txn)

### Tertiary (LOW confidence, needs validation in build)
- `@types/pg-cursor` / `@types/pg-copy-streams` lagging majors cover the stable APIs used — confirm with load smoke test (Phase 2/3)
- Exact RRF weights (1.0/1.0/1.5, k=60) and anomaly thresholds — UC-02/UC-10 must measure, not trust (Phase 6 / UC-owned)

---
*Research completed: 2026-10-26*
*Ready for roadmap: yes*
