# Requirements: SE373 Analytics Agent — Milestone 1 (Shared Agent Harness)

**Defined:** 2026-10-25
**Core Value:** Every UC owner can clone the repo, run one setup command, and build their UC against a stable, enforced harness: shared contracts, a read-only Postgres with seeded data, a guarded `db-tools` path, a LangGraph.js agent skeleton, and a single trace/eval format.

"Owner" below = a UC owner (teammate) consuming the harness. Behavior owned by a UC (text-to-SQL repair loop, RAG quality, RCA planner, anomaly engine, masking depth) is NOT a harness requirement.

## v1 Requirements

### Repository & Tooling (REPO)

- [ ] **REPO-01**: Owner can run `pnpm install && pnpm db:up && pnpm data:load` on Node 24 and get a working local stack from a clean clone
- [x] **REPO-02**: Workspace has `apps/web`, `apps/api`, `packages/{contracts,mcp-server,access-policy,agent}` with strict TS (`~6.0.3`) project references and a single shared `zod@^4` copy
- [x] **REPO-03**: Owner can run `pnpm typecheck`, `pnpm lint`, `pnpm test` at the root and per package (`pnpm --filter <pkg> …`)
- [x] **REPO-04**: Every PR to `main` runs CI (typecheck + lint + test + gitleaks v3) and must be green to merge
- [x] **REPO-05**: ESLint `no-restricted-imports` fails the build if `packages/agent` or `apps/*` imports `pg`, `pg-cursor`, or `packages/mcp-server` internals
- [x] **REPO-06**: CODEOWNERS maps each package/folder to its UC owner so reviews route automatically

### Shared Contracts (CONT)

- [x] **CONT-01**: Owner imports zod input/output schemas for the 5 db-tools (`list_tables`, `describe_table`, `explain_query`, `run_query`, `sample_rows`) from `@se373/contracts`
- [x] **CONT-02**: Owner imports the 11 standard error codes (UNAUTHORIZED … INTERNAL_ERROR, per UC-09 §A.7) and a typed `DbToolError` shape `{code, message, retryable}`
- [x] **CONT-03**: Owner imports `SQLAnswerSchema` (UC-01 fields + UC-02 `citations` + telemetry) as the single answer contract for UI/API
- [x] **CONT-04**: Owner imports a trace/audit event envelope (`runId`, `threadId`, `userId`, `role`, `node`, `type`, `ts`, `durationMs`, payload) used by every package
- [x] **CONT-05**: Owner imports semantic chunk metadata schema (`doc_type`, `table`, `metric_name`, `aliases`, `sensitivity`) for UC-02
- [x] **CONT-06**: `docs/mcp_interface.md` is generated from the zod schemas via `z.toJSONSchema()` (`pnpm docs:interface`), so docs never drift from code

### Database & Roles (DB)

- [x] **DB-01**: `pnpm db:up` starts PostgreSQL 16 + pgvector (pinned `pgvector/pgvector:0.8.7-pg16`) via Docker Compose; `pnpm db:reset` recreates it
- [x] **DB-02**: Init SQL creates roles `owner` (DDL/load), `agent_ro` (SELECT on business schema only; no TEMP/CREATE; no role memberships; `default_transaction_read_only=on`; `statement_timeout=30s`), `indexer` (writes only to semantic/state schemas)
- [x] **DB-03**: Automated test proves `agent_ro` cannot INSERT/UPDATE/DELETE/CREATE/TEMP even after `SET default_transaction_read_only=off` / `BEGIN READ WRITE`
- [x] **DB-04**: Schemas are separated: business tables, `semantic` (pgvector `semantic_chunks`), `langgraph` (checkpointer), `app_state` (audit/alert history) with per-role grants

### Data & Seeds (DATA)

- [x] **DATA-01**: Localized schema has ≥8 tables with FKs (customers, orders, order_items, products, categories, sellers, payments, reviews, regions, channels, employees, promotions) over 2025–2026, VND, Vietnamese provinces grouped into 3 regions
- [ ] **DATA-02**: `pnpm data:load` loads the Olist-derived dataset deterministically (seeded RNG, checksums) with `order_items` ≥ 1,000,000 rows
- [ ] **DATA-03**: PII columns (`customers.phone/email/address`, `employees.salary`) are synthetic via `@faker-js/faker` vi locale (with en fallback); no real personal data
- [ ] **DATA-04**: Loader injects ≥3 known-cause variance scenarios (UC-05), ≥5 anomaly points (UC-10), and ≥3 prompt-injection text rows, documented in `data/seeded_scenarios.md`
- [ ] **DATA-05**: `data/seeded_scenarios.md`, gold SQL and gold results are excluded from agent context and from OpenWiki (`.openwikiignore`), with a test that fails if agent code reads them
- [ ] **DATA-06**: `pnpm data:verify` asserts row counts, FK integrity, and that each seeded scenario/anomaly is detectable by a reference SQL
- [ ] **DATA-07**: README documents dataset source, CC BY-NC-SA 4.0 attribution, and every transformation step

### SQL Guard & Executor (GUARD)

- [x] **GUARD-01**: `sqlGuard` (pgsql-parser, warmed once at startup) accepts exactly one `SelectStmt` (incl. WITH/UNION) and rejects DDL/DML, multi-statements, `SELECT INTO`, `FOR UPDATE`, and data-modifying CTEs with `FORBIDDEN_STATEMENT`
- [x] **GUARD-02**: `sqlGuard` rejects denylisted functions (`pg_sleep`, `pg_read_file`, `dblink*`, `lo_*`, `set_config`, `pg_terminate_backend`, …) with `FORBIDDEN_FUNCTION` and system schemas / unknown tables or columns with `UNKNOWN_TABLE`
- [x] **GUARD-03**: Guard ships with ≥30 vitest cases (malicious + valid), and owners can import it as a library for local pre-flight
- [x] **GUARD-04**: Read-only executor runs `BEGIN READ ONLY` → `SET LOCAL statement_timeout` → cursor `read(maxRows+1)` → `ROLLBACK`, returns `{columns, rows, rowCount, truncated, durationMs}`, and always releases the connection
- [x] **GUARD-05**: Timeouts surface as `TIMEOUT` (PG 57014) and all DB errors pass through one `sanitizeError()` that never leaks host, user, password, DSN, file paths, or stack traces
- [x] **GUARD-06**: `packages/access-policy` exposes an `AccessPolicy` interface and a pass-through/fail-closed `ColumnScopePolicy` stub wired to `policies/sensitive_columns.yaml`, so UC-09/UC-08 can plug enforcement without changing the server

### MCP db-tools Server (MCP)

- [ ] **MCP-01**: `pnpm --filter mcp-server dev` serves the 5 tools over stateless Streamable HTTP with zod input/output schemas; MCP Inspector can list and call all 5
- [ ] **MCP-02**: Requests require `Authorization: Bearer <token>`; tokens map to `{clientId, role, scopes}` in `policies/mcp_clients.yaml` (zod-validated; invalid config = server refuses to start)
- [ ] **MCP-03**: Each tool enforces its scope (`schema:read` for metadata, `data:read` for `run_query`/`sample_rows`/`explain_query`); missing scope returns `SCOPE_DENIED`, missing token returns 401
- [ ] **MCP-04**: `explain_query` never runs `ANALYZE`; `sample_rows` is capped at 5 rows; `run_query` enforces maxRows and timeout server-side, independent of the caller
- [ ] **MCP-05**: Every call writes exactly one redacted audit JSONL line (client, scope, tool, params with literals redacted, rowCount, durationMs, decision, `runId` from `X-Run-Id`)

### Agent Skeleton (AGENT)

- [ ] **AGENT-01**: `packages/agent` compiles one root LangGraph.js graph with a shared typed `BaseState` and a linear path `understand → retrieve (stub) → generate → validate → execute → answer`
- [ ] **AGENT-02**: Graph uses `PostgresSaver` (schema `langgraph`, `setup()` at boot) so a run can be resumed by `threadId` after process restart
- [ ] **AGENT-03**: Agent reaches the DB only through an MCP client with a per-role bearer token; an end-to-end run calls ≥2 db-tools (course Phase-1 bar)
- [ ] **AGENT-04**: Owners extend the graph through documented seams — register a node/subgraph, a tool, or a router branch in their own file — without editing a shared graph-builder file
- [ ] **AGENT-05**: `interrupt()` + `Command({resume})` is plumbed end-to-end (test proves pause/resume) so UC-05 HITL and future approval gates can reuse it
- [ ] **AGENT-06**: LLM access goes through one configurable chat-model factory (OpenAI-compatible base URL + key from `.env`), with a fake/stub model for tests so CI needs no API key
- [ ] **AGENT-07**: Tool results are wrapped as untrusted data in prompts (delimited, never executed as instructions) as the baseline defense against injection rows

### Observability & API (OBS)

- [ ] **OBS-01**: Every run gets a `runId`; agent nodes, tool calls, SQL attempts, errors, tokens and estimated cost are written as JSONL trace events (contract envelope) under `traces/`
- [ ] **OBS-02**: Trace and log writers apply PII redaction (pino redact + regex for phone/email); a canary test seeds a fake PII value and asserts it never appears in traces/logs/audit
- [ ] **OBS-03**: `apps/api` exposes `POST /api/ask` streaming graph events over SSE and `POST /api/resume` for interrupts; `apps/web` is an empty Vite+React shell that renders the stream

### Eval & Skills Scaffolding (EVAL)

- [ ] **EVAL-01**: `pnpm eval --uc <id>` and `pnpm eval --all` discover per-UC case files under `evals/<uc>/` and write structured results to `results/<uc>.json`
- [ ] **EVAL-02**: Shared EX grader compares result sets (order-insensitive unless `ordered`, ±0.5% float tolerance, column-name-insensitive, NULL/numeric/timestamp normalized) with unit tests
- [ ] **EVAL-03**: Benchmark JSONL schema `{id, question, difficulty, gold_sql, gold_result_path, tags}` is defined in contracts with a validator and a 3-question sample (full ≥30 set authored by UC-01)
- [ ] **EVAL-04**: Shared safety suite scaffold with the 5 PRD §4.3 attack cases, each recording which layer blocked it (connection, validator, policy, prompt, reviewer)
- [ ] **EVAL-05**: `skills/_template/SKILL.md` defines the PRD §4.2 contract (name, description, when to use, I/O, steps, constraints, examples, final check), with a lint that rejects executable scripts or DB credentials in `skills/`

### Docs & Onboarding (DOCS)

- [ ] **DOCS-01**: `docs/architecture.md` describes layers, package boundaries, data flow of one question, extension seams, and "how to add your UC" (with a small mermaid diagram)
- [ ] **DOCS-02**: `openwiki/INSTRUCTIONS.md` updated to TS/pnpm commands and the new package taxonomy; wiki `wiki:*` scripts load `.env` (`--env-file-if-exists`); wiki regenerated after merge
- [ ] **DOCS-03**: UC-09/UC-10 docs updated to Node 24; UC-05 plan flagged for TS/zod port; K7 coverage gap recorded as a team decision item

## v2 Requirements

Deferred to UC-owned milestones. Tracked but not in this roadmap.

### UC-09 depth (owner: HungPham-VNU)

- **UC09-01**: Full `ColumnScopePolicy` with `resolveColumns` (expand `*`, alias, JOIN, 1-level CTE) and AST masking + deparse
- **UC09-02**: PII post-scan regex layer on results (`piiScanHit`)
- **UC09-03**: MCP resources `semantic://data-dictionary` (role-filtered) and `semantic://metrics`
- **UC09-04**: External MCP client script + Inspector demo; audit web page; ~24-case UC-09 eval ×2

### Other UCs

- **UC01-01**: Text-to-SQL repair loop, zero-row diagnostic, clarify-then-query, ≥30-question benchmark
- **UC02-01**: Semantic corpus YAML, incremental SHA-256 indexer, hybrid RRF retriever, citation validator
- **UC05-01**: RCA planner, branching drill-down subgraph, attribution closure check (TS port)
- **UC10-01**: Anomaly detection engine, severity routing, deduped alert sending

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full UC behavior inside the harness | Harness ships seams; owners ship behavior — avoids a "6th UC" and ownership blur |
| JWT tokens, per-client rate limit | UC-09 P2; static bearer tokens suffice for M1 |
| Row-level RBAC / RLS | Needs a UC-08 owner; interface seam is enough now |
| Reviewer, approval gate, charts, memory, scheduled reports | Each is a separately graded UC (06/07/03/04/11) |
| Rich web UI pages | Only an empty streaming shell in M1; pages are UC-owned |
| Python / sqlglot in the agent path | Team standardized on TypeScript |
| Hosted text-to-SQL/BI products | PRD §1.5.1 — any use zeroes the UC |
| Real PII | PRD §1.5.3 — synthetic only |
| `run_python` sandbox | Optional in PRD; no UC needs it |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| REPO-01 | Phase 7 | Pending |
| REPO-02 | Phase 1 | Complete |
| REPO-03 | Phase 1 | Complete |
| REPO-04 | Phase 1 | Complete |
| REPO-05 | Phase 1 | Complete |
| REPO-06 | Phase 1 | Complete |
| CONT-01 | Phase 1 | Complete |
| CONT-02 | Phase 1 | Complete |
| CONT-03 | Phase 1 | Complete |
| CONT-04 | Phase 1 | Complete |
| CONT-05 | Phase 1 | Complete |
| CONT-06 | Phase 1 | Complete |
| DB-01 | Phase 2 | Complete |
| DB-02 | Phase 2 | Complete |
| DB-03 | Phase 2 | Complete |
| DB-04 | Phase 2 | Complete |
| DATA-01 | Phase 2 | Complete |
| DATA-02 | Phase 2 | Pending |
| DATA-03 | Phase 2 | Pending |
| DATA-04 | Phase 2 | Pending |
| DATA-05 | Phase 2 | Pending |
| DATA-06 | Phase 2 | Pending |
| DATA-07 | Phase 2 | Pending |
| GUARD-01 | Phase 3 | Complete |
| GUARD-02 | Phase 3 | Complete |
| GUARD-03 | Phase 3 | Complete |
| GUARD-04 | Phase 3 | Complete |
| GUARD-05 | Phase 3 | Complete |
| GUARD-06 | Phase 3 | Complete |
| MCP-01 | Phase 4 | Pending |
| MCP-02 | Phase 4 | Pending |
| MCP-03 | Phase 4 | Pending |
| MCP-04 | Phase 4 | Pending |
| MCP-05 | Phase 4 | Pending |
| AGENT-01 | Phase 5 | Pending |
| AGENT-02 | Phase 5 | Pending |
| AGENT-03 | Phase 5 | Pending |
| AGENT-04 | Phase 5 | Pending |
| AGENT-05 | Phase 5 | Pending |
| AGENT-06 | Phase 5 | Pending |
| AGENT-07 | Phase 5 | Pending |
| OBS-01 | Phase 6 | Pending |
| OBS-02 | Phase 6 | Pending |
| OBS-03 | Phase 7 | Pending |
| EVAL-01 | Phase 6 | Pending |
| EVAL-02 | Phase 6 | Pending |
| EVAL-03 | Phase 6 | Pending |
| EVAL-04 | Phase 6 | Pending |
| EVAL-05 | Phase 6 | Pending |
| DOCS-01 | Phase 7 | Pending |
| DOCS-02 | Phase 7 | Pending |
| DOCS-03 | Phase 7 | Pending |

**Coverage:**
- v1 requirements: 52 total
- Mapped to phases: 52 ✓
- Unmapped: 0

---
*Requirements defined: 2026-10-25*
*Last updated: 2026-10-25 after initialization*
