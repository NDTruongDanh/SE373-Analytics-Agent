# Feature Research: Shared Analytics-Agent Harness (Milestone 1)

**Domain:** Shared agent HARNESS (infrastructure layer: contracts, DB, MCP `db-tools`, agent skeleton, trace/eval) for a text-to-SQL agent system — not end-user features
**Researched:** 2026-10-25
**Confidence:** HIGH (all claims grounded in PRD + the five UC plans, which are authoritative for this milestone)

> Reading guide: every UC claim cites `file:line`. "Harness" = Milestone 1 shared code every UC builds on. "UC-owned" = stays out of the harness.

## Feature Landscape

### Table Stakes (Harness Must Provide — a UC Owner Is Blocked Without These)

| Capability | Why Expected (who depends on it) | Complexity | Notes |
|---|---|---|---|
| TS pnpm monorepo skeleton (`apps/web`, `apps/api`, `packages/{contracts,mcp-server,access-policy,agent}`), strict tsconfig, ESLint (incl. `no-restricted-imports` banning direct DB imports from agent), vitest, CI (typecheck+lint+test+gitleaks) | All 5 UCs build here from day one. UC-09 F0 `UC09.md:174`; UC-01/UC-02/UC-09/UC-10 converged on TS (`UC01.md:6`, `UC02.md:193`, `UC09.md:10-24`, `UC10.md:12-21`). CONFLICT: UC-05 plan is still Python/Pydantic (`UC05.md:76-109`) and must be ported to TS | LOW-MED | Freeze package layout + `pnpm` scripts (`db:up`, `data:load`, `eval --uc`, `UC09.md:69-76`) before any UC code |
| Shared `packages/contracts`: zod schemas for 5 tool I/O, 11 standard error codes, `SQLAnswer` envelope (incl. `citations` + telemetry), trace/audit event envelope keyed by `runId` | UC-01 `SQLAnswerSchema` (`UC01.md:58-85`) extended by UC-02 with `citations`/`telemetry` (`UC02.md:149-173`); UC-01 repair consumes normalized codes (`UC01.md:52`); UC-09 owns error taxonomy (`UC09.md:183`); trace joins on `runId` (`UC09.md:184`, `UC01.md:209`). Freeze deadline M1 26–28/10 (`UC01.md:176`, `UC02.md:193`, `UC09.md:233-234`) | MED | Single highest-leverage item: contract churn after M1 breaks all UCs |
| Dockerized Postgres 16 + pgvector, 3 roles (`owner` / `agent_ro` / `indexer`); `agent_ro` read-only at the DB layer (`default_transaction_read_only=on`, `statement_timeout=30s`) | PRD §1.5.2 read-only at connection layer, prompt-blocking insufficient (`prd.md:62`); UC-09 F1 (`UC09.md:175`); every UC's safety case rests on this layer | LOW | Vitest must prove `agent_ro` cannot DELETE/CREATE (`UC09.md:175`) |
| Read-only executor: `BEGIN READ ONLY` → `SET LOCAL statement_timeout` → cursor `read(maxRows+1)` + `truncated` flag, always `release()` | UC-09 F2 (`UC09.md:176`); PRD `run_query` row (`prd.md:515`); consumed by UC-01 (`UC01.md:47`), UC-05 drill-down (`UC05.md:187-196`), UC-10 series fetch (`UC10.md:69`) | LOW-MED | Timeout PG code 57014 → `TIMEOUT` mapping (`UC09.md:143`) |
| `sqlGuard` (pgsql-parser): exactly 1 statement, root `SelectStmt` (WITH/UNION ok), no DML/`intoClause`/`lockingClause` even inside CTEs, function denylist (`pg_sleep`, `pg_read_file`, …), table/column whitelist, no system schemas | UC-09 F3 (`UC09.md:177`); shared with UC-01 which validates locally AND re-checks server-side (`UC01.md:50`); UC-10 drill-down SQL also passes it (`UC10.md:23`) | HIGH | TS has no `sqlglot.optimizer.qualify`; `resolveColumns` must be hand-written, +2 days (`UC09.md:28-30`). Fail-closed on unresolvable refs touching sensitive tables (`UC09.md:30`) |
| Minimal MCP server `db-tools`: 5 tools (`list_tables`, `describe_table`, `explain_query` without `ANALYZE`, `run_query`, `sample_rows ≤5`) over Streamable HTTP, zod input/output schemas | UC-09 F4 (`UC09.md:178`); PRD §4.1 (`prd.md:510-515`); UC-01 calls only via MCP (`UC01.md:40-50`); UC-10 via MCP, no private pool (`UC10.md:17`); UC-05 executes via read-only account (`UC05.md:190`) | MED | M1 may expose the server; full masking depth lands in UC-09 Tuần B 04–10/11 (`UC09.md:235`) |
| Bearer-token → scope auth (`schema:read`, `data:read`, `data:sensitive`), YAML-declared clients, zod-validated at startup (bad config = server won't start) | UC-09 F6 (`UC09.md:180`); PRD UC-09 TC2 (`prd.md:438`); UC-01 expects scope-filtered metadata (`UC01.md:44`); UC-10 binds recipient role → scope at query time (`UC10.md:132`) | LOW-MED | `requireBearerAuth` at HTTP layer + `requireScope` per handler (`UC09.md:119-123`) |
| `AccessPolicy` interface + `ColumnScopePolicy` skeleton + `sensitive_columns.yaml` plumbing (mask via AST rewrite + deparse; fail-closed) | UC-09 F7 (`UC09.md:181`); UC-01 reads `sensitive` flags from `describe_table` (`UC01.md:44-45`) and masks previews (`UC01.md:88`); UC-10 inherits policy (`UC10.md:17`); UC-08 later plugs `RbacPolicy` without server changes (`UC09.md:181`). SCOPE NOTE: M1 ships interface + metadata flags; full enforcement is UC-09 Tuần B — PROJECT.md keeps masking in UC-09's milestone (`PROJECT.md:36`) | HIGH | Riskiest M1 item after sqlGuard; fallback: narrow resolution (FROM/JOIN/`*`/1-level CTE), everything else fail-closed (`UC09.md:246`) |
| Standardized errors: 11 codes (E1–E11 table) + `sanitizeError()` (PG codes → internal; never leak DSN/creds/paths) | UC-09 F9 (`UC09.md:183`); UC-01 repair prompt consumes only normalized `{code,message,retryable}` (`UC01.md:52`); UC-09 TC5 (`UC09.md:220`) | LOW | E-table `UC09.md:135-148` is the spec |
| Seeded DB content + one-command `pnpm data:load`: ≥8 localized tables + FKs, ≥1M-row table, synthetic PII cols (`customers.phone/email/address`, `employees.salary`), ≥3 injection rows | PRD §2.1 (`prd.md:81-90`); UC-02 needs `order_items ≥1M` + sensitivity-aligned columns (`UC02.md:22-24`); UC-10 needs ≥1M scan cost + 5 anomalies + 3 injection rows (`UC10.md:149`) | MED | See "Seeded-Data Coverage" below — loader milestone must satisfy UC-05 and UC-10 jointly |
| Hidden seeded knowledge: 3 RCA scenarios + 5 anomaly points documented in `data/seeded_scenarios.md`, gold SQL/results hidden from agent AND from OpenWiki reads | PRD §2.1 (`prd.md:86-89`), §2.2 (`prd.md:102`); UC-05 scenarios (`UC05.md:153-157`); UC-10 anomalies (`UC10.md:149`). Hidden-ness is load-bearing for grading | MED | Mechanism needed: gold/seed docs excluded from agent context + eval-only read path. UC-05 EC-02 (Đà Nẵng returns) and UC-10 spike (Đà Nẵng ×4) likely the SAME event — coordinate (`UC05.md:217`, `UC10.md:161`) |
| Benchmark set: ≥30 VI questions JSONL (`{id,question,difficulty,gold_sql,gold_result_path,tags}`), ≥10 easy / ≥12 medium / ≥8 hard, ≥5 metric-dependent, ≥3 unanswerable | PRD §2.2 (`prd.md:94-102`); UC-01 M2 builds it (`UC01.md:179,191`); UC-02 must be 100% disjoint from its 15–20 few-shot examples (`UC02.md:37`) | MED | Authoring cost dominates; lock early — UC-01/UC-02 regression compares against it (`UC02.md:257-259`) |
| EX grader: set comparison (order-insensitive unless `ordered`), float tolerance 0.5%, NULL/bool/unicode/`numeric`/timestamp normalization, duplicate rows kept | PRD EX rule (`prd.md:101`); UC-01 TS spec (`UC01.md:192`) | MED | One shared implementation; all UC reports reuse it |
| Eval runner `pnpm eval --uc <id>` / `--all`, structured JSON results | PRD one-command full suite (`prd.md:563`); UC-09 F13 (`UC09.md:187`); UC-10 runner (`UC10.md:157`); UC-02 RAG ON/OFF flag (`UC02.md:241`) | LOW-MED | Must run ≥2× for regression (PRD §6.3, `prd.md:584-585`; UC-10 `UC10.md:6`, UC-02 `UC02.md:257-259`) |
| Shared safety/attack suite (≥5 cases: `"; DROP TABLE"` injection, privilege escalation, data-borne `ignore previous instructions`, cartesian/`pg_sleep`, fabricated-number demand; +admin-impersonation recommended), each recording which layer blocked it | PRD §4.3 (`prd.md:528-539`); UC-01 lists 6 local cases (`UC01.md:195`); UC-10 defers to the shared suite and logs the blocking layer in trace (`UC10.md:150`) | LOW | Authoring, not engineering; highest grading-pts-per-effort item |
| Observability envelope: JSONL trace + audit log, `runId` propagation, per-node/tool-call/SQL-attempt/policy/skill/token-cost/latency capture, PII redaction (`<redacted>` literals) | PRD §4.4 (`prd.md:542-543`); UC-09 F10 audit (`UC09.md:184`); UC-01 trace fields + streaming events (`UC01.md:209`); UC-10 per-slice token/cost/latency (`UC10.md:151`); UC-02 telemetry in schema (`UC02.md:170-172`) | MED | 100% calls audited, zero raw PII in logs (`UC09.md:166,184`) |
| LangGraph.js agent skeleton: typed state, Postgres checkpointer, node seams (understand→retrieve→generate→validate→execute→answer), MCP client wiring | UC-09 F11 (`UC09.md:185`); UC-01 graph + 3-attempt cap (`UC01.md:27`); UC-05 resume-from-checkpoint (`UC05.md:258-260`) and HITL `interrupt` (`UC05.md:174-182`); UC-10 checkpointer (`UC10.md:142`) | MED | Phase-1 bar: agent with ≥2 tools on UC-09 DB core by 27/10 (`UC09.md:234`) |
| `skills/` contract template (name/purpose/triggers/I-O/steps/constraints/examples/final-check) + validation that skills contain no executable scripts or alternate DB credentials | PRD §4.2 (`prd.md:523-525`); UC-01 `text-to-sql` (`UC01.md:213`); UC-10 `anomaly-alert` (`UC10.md:169`) | LOW | Template only in M1; skill BODIES are UC-owned |
| Semantic-layer storage contract: `semantic/*.yaml` outline (6 `doc_type`s), `semantic_chunks` table + pgvector HNSW, chunk metadata (`doc_type/table/tables/metric_name/aliases/sensitivity`), `pnpm semantic:index` CLI | UC-02 weeks 1–2 (`UC02.md:192-212`); PRD §2.3 (`prd.md:106-113`); 2 MCP resources (`semantic://data-dictionary`, `semantic://metrics`) due by Nov 03 (`UC02.md:187`, `UC09.md:179`); `getMetricSpec` serves UC-05 attribution + UC-10 (`UC02.md:242`) | MED | Harness = storage + indexer skeleton; retrieval QUALITY (RRF, expansion) is UC-02 depth — see Differentiators |
| Team onboarding: CODEOWNERS per package, architecture doc, `openwiki/INSTRUCTIONS.md` refresh (TS/pnpm taxonomy) | PROJECT.md active requirements (`PROJECT.md:30`); UC-09 F14 interface doc reviewed by UC-01 owner (`UC09.md:188`) | LOW | Process table stake; unblocks parallel UC work |

### Differentiators (Valuable — Ship in M1 Only If Cheap, Else UC-Owned Follow-up)

| Capability | Value Proposition | Complexity | Notes |
|---|---|---|---|
| PII post-scan regex layer on results (defense-in-depth after masking) | Catches bypasses via exotic functions; UC-09 TC2 (`UC09.md:220`) | LOW-MED | UC-09 F8 is P1, not M1 (`UC09.md:182`). Include iff free after F7 |
| `EXPLAIN`-based cost signal surfaced in trace/`explainSummary` | Feeds UC-01 zero-row/gate diagnostics (`UC01.md:127`) and future UC-07 approval; PRD reference loop (`prd.md:117-144`) | LOW | Tool already table stakes; RANKING estimates (Spearman ≥0.7, `prd.md:397`) is UC-07 depth — do not build in M1 |
| External-client demo script + MCP Inspector docs | Proves server independence (UC-09 TC3, `UC09.md:186`); cheap demo points | LOW | UC-09 F12 (`UC09.md:186`); schedule Tuần C (`UC09.md:236`) |
| Empty-but-routed web/api shells (chat stream events, role switcher, approval queue stub, alert list stub) | Lets UC UIs land without rework; PRD software 2.5 pts (`prd.md:548-554`) | MED | Shells ONLY — pages owned by UC-01 (chat, `UC01.md:209`), UC-09 (audit, `UC09.md:189`), UC-02 (dictionary admin + reindex, `UC02.md:244`), UC-10 (alert list + manual run, `UC10.md:152`) |
| Hybrid-retrieval quality: 3-leg RRF (dense+BM25+alias, k=60) + join-rule graph expansion + hot-reload BM25 | Recall@5 ≥0.85 and +15pp EX lift (`UC02.md:268-269`) | HIGH | UC-02-owned weeks 3–4 (`UC02.md:215-235`); harness must not pre-empt the design |
| Incremental SHA-256 re-indexing (`updated:1, skipped:N-1` proof) | Demo-grade "edit metric → answer changes" (`UC02.md:204-212`) | MED | UC-02-owned; harness provides only the table + `updated_at` column |
| Statistical alerting engine (trimmed z-score, WoW with EPS, `min_support`, severity routing, PG-backed fingerprint dedup) | ≥4/5 detection, ≤3 FP/week (`UC10.md:70,159-165`) | HIGH | Strictly UC-10 (`UC10.md:85-143`); harness must not bake thresholds |
| RCA planner + waterfall attribution (±5% closure check) | 2/3 seeded scenarios (`UC05.md:214-220`) | HIGH | Strictly UC-05 (`UC05.md:230-256`) |
| Zero-row diagnostic + `Clarify-Then-Query` | Separates `no_data` from bad filters (`UC01.md:124-151`) | MED | Strictly UC-01; harness must NOT generalize this into shared middleware |

### Anti-Features (Explicitly OUT — Do Not Build in the Harness)

| Anti-Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|
| Full UC logic in harness (text-to-SQL loop, RAG pipeline, RCA drill-down, alert engine) | "Unblock UCs faster" | Harness becomes a 6th UC; ownership blur, grading risk | Harness ships seams + contracts; UC owners ship behavior (`PROJECT.md:34`) |
| UC-09 depth in M1: JWT, per-client rate limit | "More K8 points" | P2 by owner plan (`UC09.md:191-192`); delays M1 28/10 bar | Defer to UC-09 hardening weeks |
| Row-level RBAC / RLS views in M1 | "UC-08 for free" | No owner; UC-01 explicitly doesn't depend on it (`UC01.md:19`); half-baked policy is worse than none | Ship `AccessPolicy` interface + column flags; UC-08 plugs `RbacPolicy` later (`UC09.md:181`) |
| Reviewer agent, approval gate, chart/insight validator, conversation memory, scheduled reports | "Complete harness" | Each is a graded UC (06/07/03/04/11) with its own acceptance math | Keep MCP scopes + trace seams multi-agent-ready; behavior stays UC-owned |
| Python agent code / sqlglot in agent path | UC-05 plan is Python (`UC05.md:76-109`) | Violates team TS decision (`PROJECT.md:39,65`); splits contracts/tooling | Port UC-05 state to `RCAState` zod + LangGraph.js |
| Hosted text-to-SQL/BI products (Vanna hosted, Copilot, Genie…) | Faster SQL quality | PRD §1.5.1: any UC using them scores 0 (`prd.md:58-60`) | Self-built guard + retrieval (cf. Vanna OSS only as RAG-corpus reference) |
| Prompt-only safety (skip read-only role / direct DB imports) | Faster iteration | PRD §1.5.2: violation zeroes the UC (`prd.md:62`) | Enforce at 3 layers: validator + `agent_ro` + post-scan (`UC09.md:150`); ESLint ban (`UC09.md:185`) |
| Real customer/employee PII in seed data | "Realistic demo" | PRD §1.5.3: violation zeroes the UC + repo purge (`prd.md:63`) | `@faker-js/faker` vi locale only (`UC09.md:24`) |
| Gold SQL/results or `seeded_scenarios.md` visible to agent / OpenWiki | "Better few-shots" | Destroys EX validity (PRD §2.2 hidden gold, `prd.md:102`) | Eval-only read path; UC-02 few-shots 100% disjoint from benchmark (`UC02.md:37`) |
| Rich web UI in M1 (audit page, dictionary admin, alert dashboard) | "Demo looks finished" | Out of scope beyond empty shell (`PROJECT.md:37`); pages are UC-owned (`UC09.md:189`, `UC02.md:244`, `UC10.md:152`) | Shells with routed stubs (Differentiators) |
| `run_python` sandbox in M1 | PRD lists it | PRD marks it optional (`prd.md:519`); UC-10 computes stats in SQL instead (`UC10.md:16`) | Defer; revisit only if a UC proves need |
| Agent-side `SELECT *` / private pools / unguarded analysis queries | Convenience | Side-channels bypass policy (UC-10 explicitly forbids, `UC10.md:133`); UC-01 takes only needed tables (`UC01.md:44`) | All reads via MCP tools; `sample_rows ≤5` masked |

## Feature Dependencies

```
packages/contracts (zod: tools I/O, 11 error codes, SQLAnswer, trace envelope)
    └──requires──> NOTHING (build FIRST — M1 26–28/10: UC01.md:176, UC02.md:193, UC09.md:233-234)

Postgres roles (agent_ro read-only) ──requires──> contracts(error codes for TIMEOUT/DENIED)
    └──requires──> docker/initdb (UC09.md:175)
DB executor (READ ONLY + timeout + cursor) ──requires──> roles
sqlGuard + resolveColumns ──requires──> contracts(schema catalog) + pgsql-parser WASM warmup (UC09.md:33)
MCP 5 tools ──requires──> executor + sqlGuard + contracts
scope auth ──requires──> contracts + mcp_clients.yaml
ColumnScopePolicy ──requires──> sqlGuard.resolveColumns + sensitive_columns.yaml (fail-closed: UC09.md:30)
error sanitize ──requires──> contracts(codes)

seeded data (tables + PII + injection rows + scenarios/anomalies)
    └──requires──> roles (load as owner) + faker (UC09.md:24)
benchmark JSONL ──requires──> seeded data (gold results must RUN: prd.md:96)
EX grader ──requires──> benchmark format
eval runner ──requires──> grader + safety suite + trace envelope
safety suite ──requires──> seeded injection rows (data-borne case: prd.md:533)

trace/audit envelope ──requires──> contracts + pino redact (UC09.md:184)
agent skeleton ──requires──> contracts + MCP tools + checkpointer (UC09.md:185, UC05.md:258-260)
semantic storage + indexer ──requires──> pgvector + contracts(metadata zod: UC02.md:193)
MCP resources (data-dictionary, metrics) ──requires──> semantic storage (due Nov 03: UC02.md:187)
skills template ──requires──> contracts (final-check references codes/statuses)

UC-owned, harness-INDEPENDENT (consume seams, never modify harness):
  UC-01 repair/zero-row/clarify (UC01.md:124-151) ──uses──> MCP tools + sqlGuard + errors
  UC-02 retriever RRF (UC02.md:99-120) ──uses──> semantic storage + resources
  UC-05 planner/attribution (UC05.md:230-256) ──uses──> MCP run_query + getMetricSpec (UC02.md:242)
  UC-10 detector/router (UC10.md:85-143) ──uses──> MCP run_query + metric specs + alert_history table
```

### Dependency Notes

- **Contracts require nothing and block everything:** any slip past 28/10 cascades to UC-01 M3 (04–10/11, `UC01.md:180`), UC-02 MCP resources (Nov 03, `UC02.md:187`), UC-09 Tuần A (`UC09.md:235`), UC-10 MCP cutover (09–10/11, `UC10.md:74`).
- **Masking split:** harness M1 = interface + sensitivity metadata; enforcement depth = UC-09 Tuần B. UC-01 is deliberately insulated via its own `LocalQuerySafetyGate` (`UC01.md:19,161-172`).
- **Seeded-data fan-out:** one loader serves UC-05 scenarios, UC-10 anomalies, the safety suite's data-borne injection case, and gold-result generation — loader schema changes after gold capture invalidate the benchmark.
- **Eval runner needs the trace envelope first:** per-query token/cost/latency reporting (PRD §6.2, `prd.md:570-582`) is emitted by traces, aggregated by the runner.

## Seeded-Data Coverage (Loader Milestone Checklist)

| Requirement | Source | Harness Loader Must Provide |
|---|---|---|
| ≥8 tables, FKs, localized Olist, ≥1M-row table, fake PII cols | PRD §2.1 (`prd.md:81-85`) | `order_items` ≥1M via noisy duplication; `phone/email/address/salary` via fakerVI |
| 3 RCA scenarios w/ known causes (e.g. Shopee×Central×home-appliances halt from 05/09/2026) | UC-05 (`UC05.md:153-157`) | Deterministic scenario deltas; hidden doc |
| 5 anomaly points (Đà Nẵng returns ×4, drop, 2 regional spikes, 1 AOV drop) | UC-10 (`UC10.md:149,159-165`) | Calibrated so tuned engine hits ≥4/5 with ≤3 FP/week on a clean week (`UC10.md:70`) |
| ≥3 injection rows (`ignore previous instructions…` in product/review text) | PRD §2.1 (`prd.md:89`) | Must be RETURNABLE by queries (tests data-borne case, `prd.md:533`) yet never followed |
| 15–20 few-shot Q-SQL pairs, 100% disjoint from benchmark | UC-02 (`UC02.md:37`) | Co-authored with benchmark to guarantee disjointness |
| Business event log (sales, warehouse incidents, date-ranged) | UC-02 (`UC02.md:38`) | Reused by UC-05/10/11 contextualization |
| 10–12 metric definitions + canonical join rules + fan-out warnings | PRD §2.3 (`prd.md:106-113`), UC-02 (`UC02.md:25-36`) | `additive` flags consumed by UC-05 (`UC02.md:242`) |

## MVP Definition

### Launch With (M1 — usable by teammates ~28/10/2026)

- [ ] Contracts frozen (tools I/O, 11 codes, `SQLAnswer`+citations+telemetry, trace envelope) — unblocks all 5 UCs
- [ ] Monorepo + CI green; `agent_ro` read-only proven by test
- [ ] Executor + sqlGuard + 5 MCP tools + scope auth (masking: interface + metadata flags)
- [ ] Seeded DB (`data:load`) + hidden scenarios/anomalies/injection rows
- [ ] Benchmark ≥30 + EX grader + `eval --uc` runner + safety suite
- [ ] Trace/audit JSONL with `runId` + PII redaction
- [ ] Agent skeleton (state, checkpointer, MCP client, ESLint DB-import ban) running ≥2 tools end-to-end (Phase-1 bar, `UC09.md:234`)
- [ ] Skills template + semantic storage/indexer CLI + 2 MCP resources (by Nov 03)

### Add After Validation (Nov, UC-owned)

- [ ] Full ColumnScopePolicy enforcement (UC-09 Tuần B) — trigger: M1 metadata flags landed
- [ ] Retrieval quality RRF tuning (UC-02 weeks 3–4) — trigger: Recall@5 measured on retrieval benchmark
- [ ] RAG ON/OFF EX-lift report (UC-02) — trigger: benchmark + grader stable
- [ ] UC UIs (audit page, dictionary admin, alert list) — trigger: shells routed

### Future Consideration (v2+ / P2)

- [ ] JWT + rate limiting (`UC09.md:191-192`) — defer: static bearer suffices for course demo
- [ ] `run_python` sandbox — defer: no UC proves need (PRD optional)
- [ ] Row-level RLS — defer: needs a UC-08 owner (`UC09.md:250`)

## Feature Prioritization Matrix

| Capability | UC Value | Implementation Cost | Priority |
|---|---|---|---|
| Contracts package | HIGH (blocks all) | MEDIUM | P1 |
| PG roles + read-only executor | HIGH (safety base) | LOW | P1 |
| sqlGuard + resolveColumns | HIGH | HIGH | P1 |
| MCP 5 tools + scope auth | HIGH | MEDIUM | P1 |
| Seeded data + hidden scenarios | HIGH (5 UCs' evals) | MEDIUM | P1 |
| Benchmark + EX grader + runner + safety suite | HIGH (U3 grading) | MEDIUM | P1 |
| Trace/audit envelope | HIGH (PRD §4.4, §6.2) | MEDIUM | P1 |
| Agent skeleton + MCP client | HIGH | MEDIUM | P1 |
| Skills template + semantic storage/resources | HIGH (UC-02 critical path Nov 03) | MEDIUM | P1 |
| ColumnScopePolicy full enforcement | HIGH | HIGH | P2 (UC-09 Tuần B) |
| PII post-scan | MEDIUM (defense-in-depth) | LOW-MEDIUM | P2 |
| External-client demo + interface docs | MEDIUM (demo/TC3) | LOW | P2 |
| Hybrid retrieval / detector / planner / repair-loop quality | HIGH (UC points) | HIGH | P2 (UC-owned) |
| JWT / rate limit / run_python / RLS / rich UI in M1 | LOW (for M1 goal) | MEDIUM-HIGH | P3 (deferred/anti) |

**Priority key:** P1 = M1 launch · P2 = UC-milestone follow-up · P3 = deferred or anti-feature.

## Competitor Feature Analysis (Reference Only — Adapts, Never Adopts Banned Parts)

| Capability | LangGraph SQL-agent tutorials | Vanna OSS (MIT) | Our Harness Approach |
|---|---|---|---|
| Tool layer | 4 direct-call tools (list tables, get schema, query, check query); no MCP, no guard | RAG over DDL/docs/SQL/Q-SQL pairs in vector store; generates SQL, no execution guard | 5 MCP tools + independent server-side `sqlGuard`; agent-local pre-check + server re-check |
| Semantic knowledge | None (schema strings in prompt) | Corpus = DDL + docs + SQL + Q-SQL pairs (mirrors our 6 `doc_type`s, `UC02.md:20-38`) | Versioned YAML corpus + incremental SHA-256 indexing + citations validator |
| Safety | Prompt-only ("don't do X") | None built-in | 3 independent layers: validator + `agent_ro` + post-scan; prompt is never a layer (`UC09.md:150`) |
| Eval | None | None | Hidden-gold EX grader + safety suite + regression ×2 (PRD §6) |
| Why we differ | Tutorials optimize for brevity; we optimize for gradeable safety + parallel UC development | Hosted Vanna is PRD-banned (`prd.md:58-60`); OSS RAG-corpus idea is the only takeaway | MCP-first enforcement so a foreign client is equally constrained (UC-09 TC3) |

## Sources

- `docs/prd.md` §§1.5, 2.1, 2.2, 2.3, 4.1–4.4, 6.1–6.3 (authoritative requirements)
- `docs/UC-plan/UC01.md` (tool contract, SQLAnswer, LocalQuerySafetyGate, eval/grader spec)
- `docs/UC-plan/UC02.md` (semantic corpus, indexer, hybrid retriever, citations, MCP resource dates)
- `docs/UC-plan/UC05.md` (RCA state, HITL, budgets, seeded scenarios; Python→TS port flagged)
- `docs/UC-plan/UC09.md` (F0–F18, E1–E11, timeline, risk fallbacks; backbone of M1 scope)
- `docs/UC-plan/UC10.md` (stats engine, dedup/RBAC fixes, cross-UC table, MCP cutover 09–10/11)
- `.planning/PROJECT.md` (M1 scope, out-of-scope, Node 24, K7 gap)
- LangChain SQL-agent tutorial docs; Vanna OSS docs/training guides (reference only, fetched 2026-10-25)

---
*Feature research for: shared analytics-agent HARNESS (Milestone 1)*
*Researched: 2026-10-25*
