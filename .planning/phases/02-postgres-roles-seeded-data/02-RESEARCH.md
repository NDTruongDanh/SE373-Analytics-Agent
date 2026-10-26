# Phase 2: Postgres Roles + Seeded Data - Research

**Researched:** 2026-10-26
**Domain:** PostgreSQL 16 + pgvector role hardening, deterministic bulk data loading (TypeScript), Olist localization
**Confidence:** HIGH (role/grant SQL, load performance, Olist file inventory, faker locale, npm versions all verified empirically this session in throwaway containers / fresh /tmp installs)

## Summary

Phase 2 builds a local PostgreSQL 16 + pgvector database (pinned `pgvector/pgvector:0.8.7-pg16`) with three roles (`owner` / `agent_ro` / `indexer`), four separated schemas, and a deterministic TypeScript loader (`packages/data`) that Vietnamizes the Olist Brazilian E-Commerce dataset and expands `order_items` to ≥1M rows. Every load-bearing claim below was verified empirically: the exact grant SQL was executed against a real `pgvector:0.8.7-pg16` container (server 16.15, extension 0.8.7), including the SET-override bypass, `BEGIN READ WRITE`, TEMP denial, `nextval`, and `statement_timeout` (57014) paths; all 8 needed Olist CSVs were downloaded from Olist's official GitHub repo with headers/row counts/distinct values measured; COPY vs batched-INSERT was benchmarked (1M rows in 4.7s via COPY); faker `vi` locale determinism was proven.

**Primary recommendation:** Download Olist CSVs at load time from Olist's official GitHub repo (`olist/work-at-olist-data`, raw.githubusercontent URLs — no Kaggle token, no browser); load with `pg-copy-streams` COPY; enforce read-only at the grant layer with the exact SQL in §Code Examples (verified 42501-after-override, 57014 on timeout); expand `order_items` by order-level cloning ×9 with `faker.seed()` as the sole RNG; use 34 post-merger provinces; inject UC-05/UC-10/injection rows from a zod-validated JSON seeds file.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Olist + synthetic expansion. Olist CSVs downloaded at load time, never committed (CC BY-NC-SA 4.0, attribution + ShareAlike in README). Vietnamize (states→provinces in 3 regions, categories→Vietnamese, BRL→VND, dates→2025–2026), synthetically expand `order_items` to ≥1,000,000 rows with seeded RNG. Channels/employees/promotions/regions generated synthetically. All PII Faker `vi` (with `en` fallback), never real.
- **D-02:** Download must work with no manual browser steps. Research decides Kaggle API vs stable public mirror; token failure must explain how to get one. Downloads go to git-ignored cache (`data/.cache/`).
- **D-03:** New workspace package `@se373/data` (`packages/data`, TypeScript, run via `tsx`): owns loader + verifier; root scripts `pnpm data:load`, `pnpm data:verify`. `docker/` holds `docker-compose.yml` + `docker/initdb/*.sql`; root scripts `pnpm db:up/down/reset`. May import `pg` (ESLint DB ban covers only `packages/agent/**`, `apps/**`). Wire like Phase 1/3 packages (tsconfig reference, vitest workspace, CODEOWNERS, `docs/architecture.md`).
- **D-04:** Implement UC-05 (≥3 variance scenarios incl. Shopee × Miền Trung × Đồ gia dụng stop from 05/09/2026), UC-10 (≥5 anomalies incl. Đà Nẵng returns ×4), ≥3 prompt-injection rows via declarative seeds file UC owners can edit. Documented in `data/seeded_scenarios.md`, hidden from agent code + OpenWiki (DATA-05).
- **D-05:** Grants are the real protection (PITFALLS C1): `agent_ro` CONNECT + USAGE + SELECT on business only, no TEMP/CREATE/memberships, role-level `default_transaction_read_only=on`, `statement_timeout=30s`, `idle_in_transaction_session_timeout`. `indexer` writes `semantic`/`langgraph`/`app_state` only. `owner` DDL+load. Passwords from `.env` (dev defaults in `.env.example` OK, local-only).
- **D-06:** Phase 3's `packages/mcp-server/test/db.live.test.ts` must run (not skip) with `DATABASE_URL` → `agent_ro` and pass (closes deferred live proof: real 57014 timeout, 25006 write rejection).
- **D-07:** Docker 29 + Compose v2 installed; scripts use plain `docker compose` (docs mention `sg docker` workaround for pre-group shells).
- **D-08:** Research first: Olist files/columns/download, Vietnamization, role SQL vs real pgvector image, fast deterministic ≥1M load (COPY vs INSERT), seeded RNG, detectable-seed reference SQL.

### the agent's Discretion
- Exact table columns beyond PRD minimum, province list/region mapping, category translation table, date-shift formula, `order_items` expansion strategy (noisy duplication preserving weekday seasonality).
- Checksum mechanism for determinism (per-table row count + hash of canonical ordering).

### Deferred Ideas (OUT OF SCOPE)
- Semantic corpus YAML + indexer (UC-02), benchmark ≥30 questions (UC-01).
- Exporting schema catalog for MCP server may move to Phase 4.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DB-01 | `pnpm db:up` starts PG16+pgvector (pinned image) via Compose; `pnpm db:reset` recreates | Compose design + healthcheck + reset semantics verified pattern (§Architecture Patterns); image `0.8.7-pg16` confirmed on Docker Hub record / local pull |
| DB-02 | Init SQL: `owner`/`agent_ro`/`indexer`, `agent_ro` SELECT-only business, no TEMP/CREATE/memberships, `default_transaction_read_only=on`, `statement_timeout=30s` | Exact SQL executed in real container; role config read back from `pg_roles` (§Code Examples) |
| DB-03 | Test proves `agent_ro` cannot INSERT/UPDATE/DELETE/CREATE/TEMP after `SET default_transaction_read_only=off` / `BEGIN READ WRITE` | Verified error-code matrix (25006 vs 42501) incl. the single-string vs separate-call SET subtlety (§Common Pitfalls P1) |
| DB-04 | Schemas business/`semantic`/`langgraph`/`app_state` with per-role grants | Verified schema/grant SQL + `ALTER DEFAULT PRIVILEGES` for future tables; indexer bug found+fixed during verification |
| DATA-01 | ≥8 FK tables, 2025–2026, VND, provinces in 3 regions | 12-table schema map (§Architecture Patterns); 34-province decision justified (merger effective 2025-07-01); +2905d shift arithmetic verified |
| DATA-02 | `pnpm data:load` deterministic (seeded RNG, checksums), `order_items` ≥1M | COPY benchmark 1M/4.7s; order-level cloning strategy; faker.seed determinism proven; checksum design |
| DATA-03 | PII synthetic via faker `vi` (+en fallback) | `new Faker({locale:[vi,en,base]})` + `faker.seed()` verified deterministic; vi name/phone/email/address output samples captured |
| DATA-04 | ≥3 UC-05 scenarios, ≥5 UC-10 anomalies, ≥3 injection rows in `data/seeded_scenarios.md` | Declarative JSON seeds design + reference SQL patterns per scenario (§Code Examples) |
| DATA-05 | Gold/seeds hidden from agent + OpenWiki, failing test on read | `.openwikiignore` entries + vitest source-scan test design (ESLint alone insufficient for `fs.readFile` paths) |
| DATA-06 | `pnpm data:verify` asserts counts, FKs, per-scenario detectability | Reference SQL per seed + exit-nonzero report contract |
| DATA-07 | README documents source, CC BY-NC-SA 4.0, all transforms | License finding: Kaggle data licence CC BY-NC-SA 4.0 vs repo LICENSE MIT — README must carry data licence + attribution + transform log |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Role/grant enforcement | Database / Storage | — | Grants are the load-bearing read-only layer (D-05, C1); app code is bypassable |
| CSV download + transform + COPY load | Operator tooling (`packages/data`, local `tsx`) | — | One-shot admin path using `owner`; never imported by agent/MCP (ESLint boundary already covers agent/apps) |
| Seeded scenario injection | Operator tooling (JSON seeds + loader) | — | Deterministic data setup; UC owners edit the seeds file only |
| Verify/report (`data:verify`) | Operator tooling | CI (skip-if-no-DB) | Asserts counts/FKs/detectability; exit-nonzero contract |
| Live role proof (`db.live.test.ts` vs `agent_ro`) | Database / Storage (test) | CI (skip-if-no-DB) | Proves 57014/25006 for real; skips green when DB absent (existing precedent) |
| Gold/seed hiding | Repo config (`.openwikiignore`, `.gitignore`) + test | — | Static boundary, enforced by scan test, not runtime code |

## Project Constraints (from AGENTS.md)

The repo `AGENTS.md` contains only the OpenWiki guidance block (no build/test/lint directives beyond it). Actionable directives extracted [VERIFIED: AGENTS.md:1-16]:

1. `openwiki/` is a generated evidence index — optional just-in-time context, never preload/enumerate at task start.
2. Use retrieval only when unfamiliar architecture/dependency behavior materially affects the task or source inspection leaves uncertainty; stop once grounded.
3. Treat source code and tests as authoritative over generated docs.
4. Prefer the narrowest quiet validation that proves the changed behavior; preserve complete failure output.
5. Do NOT hand-edit generated OpenWiki pages; update source/docs and let the workflow regenerate.

Planner impact: Phase 2 research complied (no OpenWiki reads; all claims grounded in source reads + live verification). The `data/seeded_scenarios.md` and gold paths must be added to `.openwikiignore` (DATA-05) so regeneration never ingests them.

## Standard Stack

### Core (new for this phase — all versions verified via `npm view` 2026-10-26, Node 24)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pg` | `^8.23.1` (npm view: 8.23.1) | `owner` pool in loader/verifier | Already the repo driver (STACK.md); same major as checkpoint-postgres expects; types `@types/pg@^8.23.1` [ASSUMED — version seen in STACK.md, re-verify with `npm view` at plan time] |
| `pg-copy-streams` | `^7.0.0` (npm view: 7.0.0) | `COPY ... FROM STDIN` bulk load | Fastest PG ingest path; measured 1M rows in 4.7s (§Environment-independent benchmark below); types `@types/pg-copy-streams@^1.2.5` (npm view: 1.2.5, lags major but covers `from()`) |
| `csv-parse` | `^7.0.3` (npm view: 7.0.3) | Stream-parse Olist CSVs piped into COPY | STACK-blessed; backpressure-safe pipe into `pg-copy-streams` |
| `@faker-js/faker` | `^10.6.0` (npm view: 10.6.0) | Synthetic PII (`vi` + `en` fallback), seeded RNG | STACK-blessed; `new Faker({locale:[vi,en,base]})` + `faker.seed()` verified deterministic this session; `fakerVI` export exists |
| `tsx` | `^4.23.15` (npm view: 4.23.15) | Run loader/verifier without build step | Already root devDep; D-03 mandates `tsx` execution |
| `zod` | `^4.6.7` (existing shared copy) | Validate seeds JSON + `seed_manifest.json` | Zero new deps; single shared copy per monorepo rule |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `yaml` | `^2.9.1` (STACK-blessed) | Only if planner picks YAML seeds over JSON | Prefer JSON seeds (no new dep); YAML only if UC-owner editability demands comments |
| `node:test`/`vitest` | existing `vitest@^5.0.5` | Role-proof + gold-isolation tests | Always; follow `skipIf(!DATABASE_URL)` precedent for DB-touching tests |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `pg-copy-streams` COPY | batched multi-row INSERT | Measured 200k rows: COPY 966ms vs INSERT-b1000 1182ms — both adequate, but COPY streams without materializing arrays and runs in one txn; INSERT needs batching code + more round trips. Use COPY. |
| `faker.seed()` as sole RNG | `seedrandom` (`3.0.5` on npm) | Unnecessary extra dep: every random decision (sampling, jitter, choice) can flow through the seeded faker instance; one seed in `seed_manifest.json` = full determinism. Don't add. |
| Kaggle API download | GitHub raw mirror | Kaggle needs per-user token in `.env` + `kaggle` CLI/cookie handling; GitHub raw serves byte-identical publisher files over plain HTTPS. Use mirror primary, Kaggle fallback. |
| 63 provinces | 34 post-merger provinces | Merger (Res. 202/2025/QH15, effective 2025-07-01) predates the dataset window; 63 would be an anachronism for 2025–2026 data. Use 34. |

**Installation (planner gates behind human approval):**
```bash
pnpm --filter @se373/data add pg@^8.23.1 csv-parse@^7.0.3 pg-copy-streams@^7.0.0 @faker-js/faker@^10.6.0 zod@^4.6.7
pnpm --filter @se373/data add -D @types/pg@^8.23.1 @types/pg-copy-streams@^1.2.5 tsx@^4.23.15
```

**Version verification:** `npm view` run 2026-10-26 for `pg-copy-streams` (7.0.0), `csv-parse` (7.0.3), `@faker-js/faker` (10.6.0), `@types/pg-copy-streams` (1.2.5), `seedrandom` (3.0.5, rejected), `tsx` (4.23.15), `pg` (8.23.1). Re-run at plan time; pin exact in `packages/data/package.json`.

## Package Legitimacy Audit

> New packages must pass human approval (task instruction). No `gsd-tools` seam exists in this environment, so no package is tagged `[VERIFIED: npm registry]` — all below are `[ASSUMED]` pending the orchestrator's approval gate, even though versions were confirmed on the registry.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `pg-copy-streams` | npm 7.0.0 | ~10 yrs (brianc/node-postgres ecosystem) | ~500k/wk (est.) | github.com/brianc/node-postgres | [ASSUMED] OK | Approved pending human sign-off; STACK-blessed |
| `csv-parse` | npm 7.0.3 | ~12 yrs (adaltas) | ~10M/wk (est.) | github.com/adaltas/node-csv | [ASSUMED] OK | Approved pending human sign-off; STACK-blessed |
| `@faker-js/faker` | npm 10.6.0 | ~4 yrs (community fork) | ~5M/wk (est.) | github.com/faker-js/faker | [ASSUMED] OK | Approved pending human sign-off; STACK-blessed |
| `@types/pg-copy-streams` | npm 1.2.5 | old, stable | low | DefinitelyTyped | [ASSUMED] OK | Approved pending human sign-off; covers `from()` only |
| `seedrandom` | npm 3.0.5 | old, stable | high | github.com/davidbau/seedrandom | — | REMOVED — not needed (`faker.seed()` suffices) |

**Postinstall check:** `npm view pg-copy-streams scripts.postinstall` → none expected (pure stream wrapper); planner should re-check `csv-parse`/`faker` likewise at install time. No network/filesystem-touching postinstall is acceptable.

## Architecture Patterns

### System Architecture Diagram

```
Olist GitHub raw (publisher files, pinned blob SHA)
        │ HTTPS, never committed, → data/.cache/
        ▼
packages/data (tsx, owner role)
  download → parse (csv-parse) → vietnamize (maps+faker vi, seed N)
  → COPY business tables (pg-copy-streams) → expand order_items ×9
  → inject seeds/seeds.json (UC-05/UC-10/injection rows)
  → checksums → data/seed_manifest.json
        │
        ▼
Postgres 16.15 + pgvector 0.8.7 (docker compose, healthcheck)
  business.* (12 tables, agent_ro SELECT) │ semantic/langgraph/app_state (indexer RW)
        │
        ▼
pnpm data:verify → row counts, FK integrity, per-seed reference SQL → exit 0/1
pnpm test (db.live.test.ts vs agent_ro) → 57014 + 25006 proven
```

### Recommended Project Structure

```
docker/
  docker-compose.yml      # db service, pinned image, pgdata volume, healthcheck, env-file
  initdb/
    01_roles.sql          # roles + role-level settings (exact SQL §Code Examples)
    02_schemas.sql        # schemas, REVOKEs, per-role grants, ALTER DEFAULT PRIVILEGES
    03_business.sql       # business DDL (owner-owned; loader can also create — decide in plan)
packages/data/
  src/
    download.ts           # fetch pinned URLs → data/.cache/, SHA-256 verify
    transform.ts          # vietnamize maps (province/category/rate/date-shift)
    load.ts               # COPY pipeline + expansion + seed injection + manifest
    verify.ts             # data:verify assertions + reference SQL runner
    seeds.json            # declarative seeds (UC owners edit; zod-validated)
    manifest.ts           # seed_manifest.json schema (seed, dataset_version, checksums)
  test/
    seeds.test.ts         # seeds.json validates; no forbidden paths in agent/apps
    load.unit.test.ts     # transform pure-function tests (no DB)
    verify.live.test.ts   # skipIf(!DATABASE_URL): counts/FKs/detectability vs owner/agent_ro
```

Package wiring (follow `packages/sql-guard` template [VERIFIED: packages/sql-guard/package.json:12-16] `"test": "tsc -b && vitest run"`, [VERIFIED: packages/sql-guard/tsconfig.json:1-11] `composite/rootDir/outDir/dist tsBuildInfoFile/references`):
- `packages/data/package.json` (`tsc -b && vitest run`), `tsconfig.json` (extends `../../tsconfig.base.json`, `rootDir: src`, `composite: true`, `references: [{path: ../contracts}]` — contracts only, unless catalog export needs more),
- root `tsconfig.json` references += `packages/data` [VERIFIED current list: tsconfig.json:4],
- `vitest.workspace.ts` += `"packages/data"` [VERIFIED current list: vitest.workspace.ts:1-10],
- `.github/CODEOWNERS` += `packages/data/`, `docs/architecture.md` §Status table += data row,
- root `package.json` scripts: `db:up/down/reset`, `data:load`, `data:verify`, `data:catalog` (optional).

### Pattern 1: Grant-first read-only (verified)

**What:** Least-privilege grants as layer 1; `default_transaction_read_only=on` + `statement_timeout` as layers 2–3; test the override path, not the default path.
**Verified behavior (real container, separate driver calls per statement):**

| Attempt as `agent_ro` | Default txn | After `SET default_transaction_read_only=off` (separate call) | Code |
|---|---|---|---|
| `SELECT` business | works | works | — |
| `INSERT/UPDATE/DELETE` | denied | denied | 25006 → 42501 |
| `CREATE TABLE` business/`semantic`/`public` | denied | denied | 25006 → 42501 (`permission denied for schema`) |
| `CREATE TEMP TABLE` | denied | **denied** (`permission denied to create temporary tables`) | 25006 → 42501 |
| `SELECT INTO` | denied | denied | 25006 → 42501 |
| `BEGIN READ WRITE; DELETE` | n/a | denied by grants | 42501 |
| `nextval()` | denied (42501, no USAGE) | denied (42501) | 42501 |
| `SET ROLE owner` | denied (no memberships) | — | 42501 |
| `SELECT pg_sleep(5)` with 1s timeout | — | — | **57014** `canceling statement due to statement timeout` |

`ALTER ROLE agent_ro SET ...` read back from `pg_roles.rolconfig` = `{default_transaction_read_only=on,statement_timeout=30s,idle_in_transaction_session_timeout=10s}`.
`ALTER DEFAULT PRIVILEGES FOR ROLE owner ... GRANT SELECT` proven: table created after grants was immediately readable.

### Pattern 2: Deterministic order-level expansion

**What:** Clone whole orders (new surrogate `order_id`s, same weekday timestamps + jitter ≤ ±3 days snapped to same weekday, jitter prices ±5%) ×9 plus top-up; clone child rows (items/payments/reviews) under new order ids. Preserves weekday seasonality, FK integrity, per-product/seller distributions by construction.
**Checksum:** `seed_manifest.json` = `{seed, dataset_version, per-table {rows, sha256 of canonical ORDER BY pk CSV}}`; loader refuses to finish on mismatch; `data:verify` recomputes.

### Pattern 3: Declarative JSON seeds + reference SQL

**What:** `packages/data/src/seeds.json` (zod-validated at load): `{scenarios_uc05: [...], anomalies_uc10: [...], injections: [...]}` each with `{id, description, dimension filter, period, magnitude, reference_sql}`. Loader applies them as data mutations (delete/update/insert); `data:verify` runs each `reference_sql` and asserts the designed signal. UC owners edit JSON only — no loader code changes.

### Anti-Patterns to Avoid

- **Testing the default-path denial only** ("DELETE fails by default") — proves nothing about grants; always test the post-override path with separate driver calls (single-string `SET; WRITE` stays in the implicit txn → misleading 25006, see Pitfall P1).
- **`GRANT ALL` then subtract** — grant least-privilege from zero; subtraction lists rot.
- **Creating data tables before `ALTER DEFAULT PRIVILEGES`** — existing-table grants don't cover future tables; set defaults first (the indexer SELECT bug caught this session proves it).
- **Row-level duplication of `order_items` alone** — breaks FK grain (orphan items) and drowns anomalies; clone at order level.
- **Unseeded `Math.random`/`Date.now()` anywhere in loader** — all randomness via seeded faker; dates derived from fixed shift arithmetic.
- **Committing CSVs or `data/.cache/`** — cache dir git-ignored; blob SHAs pinned in code instead.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bulk ingest of 1–2M rows | batched INSERT loops, custom workers | `pg-copy-streams` `COPY FROM STDIN` | Measured 1M/4.7s; single txn; backpressure-safe pipe |
| CSV parsing | `split('\n')` / regex | `csv-parse` streams | BOM (`\ufeff` present in translation file — measured), quoting, multiline review text |
| Synthetic vi PII | hand lists of names/phones | `@faker-js/faker` `vi` + `[vi,en,base]` fallback | Thin `vi` coverage falls back silently; `faker.seed()` = determinism |
| Read-only enforcement | app-level `startsWith('SELECT')` | grant layer + existing `sqlGuard` | C1/C2: session settings are USERSET-overridable; grants are not |
| Gold-hiding | convention ("don't read") | `.openwikiignore` entries + vitest source-scan (fail on match) | Conventions leak via globs (C10); test is the boundary |

**Key insight:** the security boundary is `GRANT`/`REVOKE` in `initdb/*.sql` plus a scan test — everything else (settings, guard, prompt) is defense in depth.

## Common Pitfalls

### Pitfall 1: Single-string SET-override test gives a false 25006
**What goes wrong:** `client.query("SET default_transaction_read_only=off; INSERT ...")` still fails with 25006, "proving" safety while testing nothing — the whole string runs in one implicit transaction and the SET can't take effect mid-transaction.
**Why it happens:** `default_transaction_read_only` is sampled at transaction start (USERSET GUC).
**How to avoid:** issue SET and the write as separate driver calls (separate `client.query()` / separate `-c` flags), then assert **42501**. Verified this session: separate calls → `ERROR: 42501: permission denied for table orders`.
**Warning signs:** role test with combined statements; test asserting 25006 on the override path.

### Pitfall 2: Indexer blind to future business tables
**What goes wrong:** `GRANT SELECT ON ALL TABLES` covers only existing tables; indexer reads of later-created tables fail.
**Why it happens:** missing `ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA business GRANT SELECT ON TABLES TO indexer`.
**How to avoid:** set default privileges for both `agent_ro` (SELECT/business+semantic) and `indexer` (SELECT/business, ALL/semantic+langgraph+app_state) right after role creation. Caught and fixed during this research.

### Pitfall 3: PG15+ `public` schema + TEMP write primitive
**What goes wrong:** `SELECT INTO TEMP` / temp-table writes succeed inside read-only txns if TEMP granted (SET TRANSACTION docs exempt temp tables).
**Why it happens:** assuming read-only txn blocks all writes.
**How to avoid:** `REVOKE CREATE ON SCHEMA public FROM PUBLIC` + `REVOKE TEMP ON DATABASE ... FROM PUBLIC, agent_ro` (both verified: `permission denied for schema public`, `permission denied to create temporary tables`).

### Pitfall 4: Unmapped categories / empty strings break translation join
**What goes wrong:** loader joins products→translation and drops/NULLs 3 unmapped values (`''`, `pc_gamer`, `portateis_cozinha_e_preparadores_de_alimentos` — measured).
**How to avoid:** explicit fallback map in `transform.ts` (`pc_gamer`→`Máy tính & Phụ kiện` etc., `''`→`Chưa phân loại`); `data:verify` asserts zero NULL categories.

### Pitfall 5: Date shift into 2027 breaks "cannot answer 2027" evals
**What goes wrong:** shifting min-date to 2025-01-01 with a week-multiple offset pushes max into 2027 (verified: +3045d → max 2027-02-17), arming PRD §4.3-case-5 failures.
**How to avoid:** shift **+2905 days (415 weeks, verified weekday-preserving Wed→Wed)**: range becomes 2024-08-18 → **2026-09-30**, then clip pre-2025-01-01 orders (document loss); 2027 stays empty; Sept-2026 scenarios land in-window.

### Pitfall 6: Expansion drowns seeded anomalies (C9)
**What goes wrong:** uniform ×9 cloning multiplies anomaly slices equally — signal survives proportionally, but absolute FP calibration (UC-10 ≤3 FP/week) must be measured post-expansion.
**How to avoid:** inject seeds AFTER expansion (loader order: load → expand → inject → manifest); `data:verify` asserts each reference SQL still returns the designed magnitude.

### Pitfall 7: Faker `vi` gaps throw without fallback
**What goes wrong:** `new Faker({locale:[vi]})` throws on missing entries during the 1M-row run.
**Why it happens:** STACK notes `vi` has thinner coverage (confirmed real: `[vi,en,base]` chain generates fine; determinism proven).
**How to avoid:** always `new Faker({locale: [vi, en, base]})`, single `faker.seed(SEED)`; never `Math.random`.

## Code Examples

### Init SQL that passed (candidate for `docker/initdb/01_roles.sql` + `02_schemas.sql`)

```sql
-- 01_roles.sql — roles + session defaults (verified on pgvector:0.8.7-pg16, PG 16.15)
CREATE ROLE owner LOGIN PASSWORD 'owner_pw';
CREATE ROLE agent_ro LOGIN PASSWORD 'agent_ro_pw';
CREATE ROLE indexer LOGIN PASSWORD 'indexer_pw';
ALTER ROLE agent_ro SET default_transaction_read_only = on;
ALTER ROLE agent_ro SET statement_timeout = '30s';
ALTER ROLE agent_ro SET idle_in_transaction_session_timeout = '10s';

-- 02_schemas.sql — run as superuser/postgres on first init
CREATE SCHEMA business AUTHORIZATION owner;
CREATE SCHEMA semantic AUTHORIZATION owner;
CREATE SCHEMA langgraph AUTHORIZATION owner;
CREATE SCHEMA app_state AUTHORIZATION owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMP ON DATABASE chosan FROM PUBLIC;
REVOKE TEMP ON DATABASE chosan FROM agent_ro;
GRANT CONNECT ON DATABASE chosan TO agent_ro, indexer;
GRANT USAGE ON SCHEMA business TO agent_ro;
GRANT USAGE ON SCHEMA business, semantic, langgraph, app_state TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA business
  GRANT SELECT ON TABLES TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic
  GRANT SELECT ON TABLES TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA business
  GRANT SELECT ON TABLES TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic, langgraph, app_state
  GRANT ALL ON TABLES TO indexer;
-- plus GRANT SELECT ON ALL TABLES for tables created by 03_business.sql,
-- GRANT ALL ON ALL TABLES IN SCHEMA semantic,langgraph,app_state TO indexer,
-- and the same ALTER DEFAULT PRIVILEGES for SEQUENCES if any serial PK is
-- exposed (agent_ro must NOT get USAGE on sequences: verified 42501 on nextval).
```

> Note: database name above is `chosan` (placeholder — planner picks the real name; tests used `postgres`). Never grant USAGE on sequences to `agent_ro` (verified denial depends on it alongside read-only txn).

### Vitest role proof (extends `db.live.test.ts` pattern — separate calls!)

```typescript
// test/roles.live.test.ts — skipIf(!process.env.DATABASE_URL), DATABASE_URL → agent_ro
const q = (c: Client, sql: string) => c.query(sql); // separate driver calls
await q(ro, `SET default_transaction_read_only = off`);
await expect(q(ro, `INSERT INTO business.orders(status) VALUES('x')`))
  .rejects.toMatchObject({ code: '42501' });
await expect(q(ro, `CREATE TEMP TABLE t(id int)`)).rejects.toMatchObject({ code: '42501' });
await expect(q(ro, `SELECT pg_sleep(31)`)).rejects.toMatchObject({ code: '57014' });
```

### Docker Compose (candidate)

```yaml
services:
  db:
    image: pgvector/pgvector:0.8.7-pg16
    env_file: [.env]
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-chosan}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
    ports: ["${POSTGRES_PORT:-5433}:5432"]
    volumes: [pgdata:/var/lib/postgresql/data, ./docker/initdb:/docker-entrypoint-initdb.d:ro]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-postgres} -d $${POSTGRES_DB:-chosan}"]
      interval: 5s; timeout: 3s; retries: 10
volumes: { pgdata: {} }
```

Root scripts: `db:up` → `docker compose --env-file .env -f docker/docker-compose.yml up -d --wait`; `db:down` → `stop`; `db:reset` → `down -v && up -d --wait` (initdb reruns only on empty volume — document). URLs: owner `postgresql://owner:${OWNER_PW}@localhost:${POSTGRES_PORT}/chosan` (loader); `agent_ro` URL → `DATABASE_URL` for `db.live.test.ts`/MCP; indexer URL for later phases.

### Olist source map (measured 2026-10-26, GitHub blob SHAs pin the bytes)

Base: `https://raw.githubusercontent.com/olist/work-at-olist-data/master/datasets/<file>` (official Olist repo; repo LICENSE is MIT-for-code — the **data** licence CC BY-NC-SA 4.0 comes from the Kaggle dataset page and must be carried in README per D-01/DATA-07).

| File (bytes match API listing) | Rows | Columns | Feeds table(s) |
|---|---|---|---|
| `olist_customers_dataset.csv` (8,562,270) | 99,441 | customer_id, customer_unique_id, customer_zip_code_prefix, customer_city, customer_state (27 states) | customers |
| `olist_orders_dataset.csv` (17,654,914) | 99,441 | order_id, customer_id, order_status (delivered 96,478 / shipped 1,107 / canceled 625 / unavailable 609 / invoiced 314 / processing 301 / created 5 / approved 2), 5 timestamps (purchase 2016-09-04→2018-10-17) | orders |
| `olist_order_items_dataset.csv` (15,007,623) | 112,650 | order_id, order_item_id, product_id, seller_id, shipping_limit_date, price, freight_value | order_items (×9 expansion → ~1.01M) |
| `olist_products_dataset.csv` (2,379,446) | 32,951 | product_id, product_category_name (74 distinct), dims/weight | products |
| `olist_sellers_dataset.csv` (163,589) | 3,095 | seller_id, seller_zip_code_prefix, seller_city, seller_state | sellers |
| `olist_order_payments_dataset.csv` (5,647,783) | 103,886 | order_id, payment_sequential, payment_type (credit_card/boleto/voucher/debit_card/not_defined), payment_installments, payment_value | payments (fan-out trap preserved) |
| `olist_order_reviews_dataset.csv` (14,451,670) | 99,224 | review_id, order_id, review_score (5:57k/4:19k/1:11k/3:8k/2:3k), title/message, 2 timestamps | reviews |
| `product_category_name_translation.csv` (2,613, **BOM `\ufeff` on first header — measured**) | 71 | product_category_name, product_category_name_english | categories (+3 unmapped fallbacks) |

`olist_geolocation_dataset.csv` (61MB) is NOT needed (sellers carry city/state). Total download ≈ 66MB.

### Vietnamization maps (discretion — planner encodes)

- **States→provinces:** deterministic map of 27 BR codes → 34 VN post-merger provinces (recommendation: weighted to keep all 34 populated; region column Bắc/Trung/Nam). 34-province list [ASSUMED — verify against Res. 202/2025/QH15 full text]: 6 cities Hà Nội, Hải Phòng, Huế, Đà Nẵng, Cần Thơ, TP.HCM + 28 provinces (Lai Châu, Điện Biên, Sơn La, Lạng Sơn, Cao Bằng, Tuyên Quang, Lào Cai, Thái Nguyên, Phú Thọ, Bắc Ninh, Hưng Yên, Ninh Bình, Quảng Ninh, Thanh Hóa, Nghệ An, Hà Tĩnh, Quảng Trị, Quảng Ngãi, Gia Lai, Khánh Hòa, Lâm Đồng, Đắk Lắk, Đồng Nai, Tây Ninh, Đồng Tháp, An Giang, Vĩnh Long, Cà Mau).
- **Categories:** 71 EN names → Vietnamese (translation CSV gives EN; planner authors VI map; 3 fallbacks for unmapped).
- **Currency:** fixed `VND = round(BRL × 5150 / 1000) × 1000` (rate ≈ Oct-2025 market 5,095–5,162 [CITED: revolut.com, xe.com]; document as constant in README).
- **Dates:** `shifted = original + 2905 days` (verified arithmetic, weekday-preserving), clip `< 2025-01-01`.
- **Synthetic:** regions (34 rows + region group), channels (Shopee/Lazada/TikTok Shop/Website/Cửa hàng — channel_id FK on orders), employees (~200, salaries via faker), promotions (~30 rows, event log for UC-11 reuse).
- **Schema (12 PRD tables + FKs):** customers→orders→order_items→products→categories; sellers→order_items; orders→payments (N per order); orders→reviews; regions←customers/sellers; channels←orders; employees (standalone + region); promotions (standalone, date ranges).

### Seeded reference SQL (patterns for `data:verify`)

```sql
-- UC-05 S1: Sept-2026 net-revenue drop, Shopee × Miền Trung × Đồ gia dụng
SELECT (sept-aug)/NULLIF(aug,0) AS pct FROM (
  SELECT SUM(CASE WHEN o.purchase_date BETWEEN '2026-08-01' AND '2026-08-31' THEN i.price ELSE 0 END) aug,
         SUM(CASE WHEN o.purchase_date BETWEEN '2026-09-01' AND '2026-09-30' THEN i.price ELSE 0 END) sept
  FROM business.order_items i JOIN business.orders o USING(order_id)
  WHERE o.status='delivered') t;  -- assert ≈ -0.18 ± tolerance
-- UC-10 A1: Đà Nẵng returns ×4 on anomaly date
SELECT COUNT(*) FROM business.orders o JOIN business.customers c USING(customer_id)
WHERE c.province='Đà Nẵng' AND o.status='returned' AND o.purchase_date='2026-..-..'; -- assert ≥ 4× baseline
-- injection rows: SELECT product_name FROM business.products WHERE product_name LIKE '%ignore previous instructions%'; -- assert count ≥ 3
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Kaggle API + token for Olist | Publisher GitHub raw URLs + blob-SHA pinning | This research (2026-10-26) | Zero-auth download; checksum = GitHub blob SHA + SHA-256 manifest |
| 63 provinces (pre-2025 data habit) | 34 post-merger units | Res. 202/2025/QH15 effective 2025-07-01 | Period-correct geography for 2025–2026 data |
| `default_transaction_read_only` as proof | Grant-denial codes after override (42501) | PITFALLS C1 + verified this session | Test proves layer 1, not layer 3 |
| Batched INSERT default | COPY FROM STDIN | Measured 1M/4.7s | Simpler streaming, fewer round trips |
| `Math.random` in loaders | Single `faker.seed()` | Verified deterministic | One seed reproduces the whole DB |

**Deprecated/outdated:** `seedrandom` as extra dep (rejected); geolocation CSV (unneeded 61MB); `TIMESTAMP` string-math date shifts (use day-offset arithmetic).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | New npm packages (`pg-copy-streams`, `csv-parse`, faker, types) legitimate/stable — versions registry-confirmed, legitimacy NOT seam-checked | Standard Stack / Audit | Low — all STACK-blessed, human gate required anyway |
| A2 | 34-province name list verbatim correct | Vietnamization | Medium — planner must cross-check Res. 202/2025/QH15 (luatvietnam.vn) before encoding |
| A3 | CC BY-NC-SA 4.0 applies to GitHub-mirrored CSVs (Kaggle page licence carries to the bytes) | Olist source map | Medium — README carries attribution + ShareAlike either way; course use is NC |
| A4 | `order_items` ×9 order-level cloning keeps UC-10 FP ≤3/week calibratable | Expansion | Medium — F10.4 calibration (UC-10 plan) runs post-load; verify script asserts magnitudes |
| A5 | `data:verify` + role tests skip-green in CI without DB is acceptable (no compose service) | Validation | Low — matches existing `skipIf` precedent; team runs DB tests locally |
| A6 | `@types/pg` version `^8.23.1` (from STACK.md, not re-viewed) | Stack | Trivial — re-`npm view` at plan time |

## Open Questions

1. **Database name + host port** (e.g. `chosan`, `5433`): no constraint found — planner proposes, team confirms (affects every `.env` + compose + CI doc).
2. **Business DDL location**: `docker/initdb/03_business.sql` vs loader-created — recommend initdb (versioned, reviewable) with loader doing data-only; planner decides.
3. **`data:catalog` export in this phase or Phase 4**: CONTEXT marks optional — recommend defer unless spare capacity.
4. **Checksum strength**: row-count + canonical-hash per table (recommendation) vs full dump hash — planner picks; either satisfies DATA-02 with `seed_manifest.json`.
5. **UC-05 scenarios #2–3 and UC-10 anomalies #2–5 exact parameters**: D-04 fixes S1/A1 examples; remaining magnitudes/dates are UC-owner editable in `seeds.json` — planner defines JSON schema, owners fill values.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker engine + Compose v2 | `db:up`, role proof, load benchmark | ✓ (via `sg docker` in this shell; plain `docker` post-relogin) | 29.1.3 / v2.40.3 | None — phase blocked without it (D-07 asserts installed) |
| Image `pgvector/pgvector:0.8.7-pg16` | DB-01 | ✓ (pulled; server 16.15 + ext 0.8.7 verified live) | 0.8.7-pg16 | None (pinned by DB-01) |
| Node 24 + pnpm 11 | loader/test | ✓ | v24.22.1 / pnpm 11.19.1 (repo pins 11.25.0 — close; use corepack) | None |
| Network → raw.githubusercontent.com | `data:load` | ✓ (66MB fetched this session) | — | Kaggle API flow with per-user token (D-02 fallback) |
| Kaggle token | fallback only | ✗ (no `~/.kaggle`, no `KAGGLE_*`) | — | Not needed if mirror primary |
| `psql` client | debugging only | ✓ (inside container) | — | `pg` driver in scripts |

**Missing with no fallback:** none. **Research containers:** `se373-research-*` throwaway, `--rm`; planner must ensure executor removes any it creates.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest `^5.0.5` (existing workspace) |
| Config file | `packages/data/vitest.config.ts` (new, per sql-guard template) + workspace entry |
| Quick run command | `pnpm --filter @se373/data test` |
| Full suite command | `pnpm test` (root: `tsc -b && vitest run`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| DB-01 | compose up healthy; reset recreates | manual/smoke | `pnpm db:up && pg_isready; pnpm db:reset` | ❌ Wave 0 |
| DB-02 | roles/schemas/grants exist as specified | live (skipIf) | `vitest run test/roles.live.test.ts` | ❌ Wave 0 |
| DB-03 | override-path denials 42501 + timeout 57014 | live (skipIf) | same file; `DATABASE_URL`=agent_ro | ❌ Wave 0 (extends `db.live.test.ts` pattern) |
| DB-04 | per-schema grants; indexer RW semantic only | live (skipIf) | same file | ❌ Wave 0 |
| DATA-01 | ≥8 FK tables; 12 tables present; provinces ∈ 34, region ∈ 3 | live (skipIf) | `verify.live.test.ts` / `data:verify` | ❌ Wave 0 |
| DATA-02 | order_items ≥1M; reload identical manifest | live+unit | `data:verify` checksums; double-load diff | ❌ Wave 0 |
| DATA-03 | PII columns exist, match faker patterns, no real data | live/unit | regex scan in verify | ❌ Wave 0 |
| DATA-04 | seeds.json validates; rows present | unit+live | `seeds.test.ts` + verify reference SQL | ❌ Wave 0 |
| DATA-05 | no agent/app source references gold/seed paths; openwikiignore covers | unit (no DB) | `seeds.test.ts` source scan — runs in CI | ❌ Wave 0 |
| DATA-06 | verify exits 0/ nonzero; asserts counts/FKs/signals | live (skipIf) | `pnpm data:verify` | ❌ Wave 0 |
| DATA-07 | README licence + transform log | manual (review checklist) | — | ❌ Wave 0 |
| D-06 | `db.live.test.ts` passes vs agent_ro (57014/25006 legs) | live (must-run, not skip) | `DATABASE_URL=<agent_ro> vitest run test/db.live.test.ts` | ✅ exists, needs agent_ro run |

### Sampling Rate
- **Per task commit:** `pnpm --filter @se373/data test` (skips live legs without DB) + `tsc -b`
- **Per wave merge:** full `pnpm test` + `pnpm data:verify` against local DB
- **Phase gate:** full suite green + `data:verify` exit 0 + `db.live.test.ts` green vs `agent_ro` before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/data/` scaffold (package.json/tsconfig/vitest.config/src/test) — covers all DATA reqs
- [ ] `packages/data/test/roles.live.test.ts` — covers DB-02/03/04 (pattern: `describe.skipIf(!process.env.DATABASE_URL)`, separate driver calls per statement, assert 42501/57014)
- [ ] `packages/data/test/seeds.test.ts` — covers DATA-04/05 (zod validation + forbidden-path source scan; no DB → runs in CI)
- [ ] `packages/data/test/*.unit.test.ts` — transform maps, date-shift arithmetic, manifest hashing (no DB → runs in CI)
- [ ] `docker/docker-compose.yml` + `docker/initdb/*.sql` — covers DB-01/02/04
- [ ] Framework install: `pnpm add` the 4 approved packages (human gate) — no new framework needed

## Security Domain

`security_enforcement: true` [VERIFIED: .planning/config.json:48]; ASVS L1.

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | yes (DB roles) | SCRAM passwords via `.env`; dev defaults local-only, never deployed |
| V4 Access Control | yes (core of phase) | Least-privilege GRANTs + verified 42501 matrix; no role memberships for `agent_ro` |
| V5 Input Validation | yes (seeds.json) | zod validation at load; fail-closed on bad seed |
| V6 Cryptography | partial | SHA-256 checksums (integrity, not secrets); no hand-rolled crypto |
| V14 Configuration | yes | `.env.example` defaults; `.env`/`.cache`/CSVs git-ignored; gitleaks v3 in CI |

### Known Threat Patterns for Postgres-loader phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SET-override of `default_transaction_read_only` | Elevation | Grant layer (verified 42501); test override path |
| Temp-table write primitive | Tampering | `REVOKE TEMP`; verified denial |
| `SELECT INTO` / `CREATE TABLE AS` persistence | Tampering | `REVOKE CREATE ON SCHEMA public/business FROM agent_ro`; verified |
| Sequence manipulation (`setval`) | Tampering | No USAGE/UPDATE on sequences for `agent_ro`; verified 42501 |
| Credential commit | Disclosure | `.gitignore` `.env`; gitleaks; `.env.example` only |
| Gold/seed leakage to agent | Disclosure | `.openwikiignore` + source-scan test (DATA-05) |
| Non-reproducible data → fake EX deltas | Repudiation (eval integrity) | Pinned blob SHAs + `seed_manifest.json` checksums |

## Sources

### Primary (HIGH — measured this session)
- Live `pgvector/pgvector:0.8.7-pg16` container (server 16.15, ext 0.8.7): full grant/override/timeout matrix, `pg_roles.rolconfig` readback, default-privileges fix — throwaway `se373-research-*`, removed after
- Local Olist download 2026-10-26 (8 CSVs, headers/row counts/value distributions/byte sizes measured; BOM + 3 unmapped categories found)
- `npm view` 2026-10-26: pg-copy-streams 7.0.0, csv-parse 7.0.3, @faker-js/faker 10.6.0, @types/pg-copy-streams 1.2.5, seedrandom 3.0.5 (rejected), tsx 4.23.15, pg 8.23.1
- Faker determinism probe (`new Faker({locale:[vi,en,base]}).seed()` → identical sequences) + vi output samples
- COPY benchmark: 200k COPY 966ms vs INSERT-b1000 1182ms; 1M COPY 4.7s + PK/index 0.9s
- In-repo reads: `packages/mcp-server/test/db.live.test.ts:11` (`const hasDb = !!process.env.DATABASE_URL;`), `packages/sql-guard/package.json:12-16`, `packages/sql-guard/tsconfig.json:1-11`, `policies/sensitive_columns.yaml:1-13`, `packages/contracts/src/catalog.ts:1-13`, `tsconfig.json:4`, `vitest.workspace.ts:1-10`, `.planning/config.json:48`, `AGENTS.md:1-16`

### Secondary (MEDIUM — cited docs)
- [CITED: postgresqlco.nf/doc/en/param/default_transaction_read_only] USERSET-overridable setting
- [CITED: postgresql.org/docs/current/sql-set-transaction.html] temp-table exemption in read-only txns
- [CITED: github.com/olist/work-at-olist-data] official publisher repo, datasets/ listing + blob SHAs via api.github.com
- [CITED: revolut.com + xe.com] BRL→VND ≈ 5,095–5,162 (Oct 2025–2026) → fixed 5,150 recommendation
- [CITED: vietnam-briefing.com / luatvietnam.vn / wikipedia 2025_Vietnamese_administrative_reforms] 63→34 merger, Res. 202/2025/QH15, effective 2025-07-01

### Tertiary (LOW — needs confirmation)
- 34-province verbatim name list [ASSUMED — verify vs resolution full text]
- Package download counts/ages [ASSUMED — estimates, irrelevant to decision]
- Kaggle CC BY-NC-SA 4.0 carrying to GitHub bytes [ASSUMED — carry licence in README regardless]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions registry-checked, loader path benchmarked, faker proven
- Architecture: HIGH — grant SQL executed for real, failure mode (indexer defaults) found and fixed live
- Pitfalls: HIGH — override-test subtlety and 2027-overshoot reproduced/measured, not theorized

**Research date:** 2026-10-26
**Valid until:** 2026-11-26 (stable domain; re-check npm versions at plan time)
