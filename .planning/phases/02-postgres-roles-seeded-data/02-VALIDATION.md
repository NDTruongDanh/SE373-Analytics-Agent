---
phase: "2"
slug: "postgres-roles-seeded-data"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-26"
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^5.0.5 (existing workspace) |
| **Config file** | `packages/data/vitest.config.ts` (new, per `packages/sql-guard` template) + `vitest.workspace.ts` entry |
| **Quick run command** | `pnpm --filter @se373/data test` (live legs skip without `DATABASE_URL`) |
| **Full suite command** | `pnpm test` (root: `tsc -b && vitest run`) |
| **Estimated runtime** | unit ~10 s; `pnpm data:load` ~1–2 min; `pnpm data:verify` < 30 s |

---

## Sampling Rate

- **After every task commit:** `pnpm --filter @se373/data test` + `pnpm typecheck`
- **After every plan wave:** `pnpm test` + (once the DB exists) `pnpm data:verify` against the local `chosen` DB
- **Before `/gsd-verify-work`:** full suite green, `pnpm data:verify` exit 0, and `packages/mcp-server/test/db.live.test.ts` green (not skipped) with `DATABASE_URL` = `agent_ro` (D-06)
- **Max feedback latency:** 30 seconds (unit); DB-backed checks run per wave

---

## Per-Task Verification Map

Requirement-level map (from `02-RESEARCH.md` § Validation Architecture); planner/executor add task IDs:

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| DB-01 | `pnpm db:up` → healthy `pgvector/pgvector:0.8.7-pg16` on 5433; `pnpm db:reset` recreates | smoke | `pnpm db:up && pg_isready -h localhost -p 5433` | ❌ W0 | ⬜ pending |
| DB-02 | roles `owner`/`agent_ro`/`indexer`, schemas, grants as specified | live (skipIf) | `pnpm --filter @se373/data test` (`roles.live.test.ts`) | ❌ W0 | ⬜ pending |
| DB-03 | `agent_ro` writes denied after `SET default_transaction_read_only=off` / `BEGIN READ WRITE` (42501), timeout 57014 — separate driver calls per statement | live (skipIf) | same | ❌ W0 | ⬜ pending |
| DB-04 | per-schema grants; `indexer` writes semantic/langgraph/app_state only | live (skipIf) | same | ❌ W0 | ⬜ pending |
| DATA-01 | 12 tables, ≥ 8 FKs, provinces ∈ 34, regions ∈ 3, dates 2025–2026 | live | `pnpm data:verify` | ❌ W0 | ⬜ pending |
| DATA-02 | `order_items` ≥ 1,000,000; reload reproduces the same manifest/checksums | live + unit | `pnpm data:verify` + manifest unit tests | ❌ W0 | ⬜ pending |
| DATA-03 | PII columns exist, synthetic (faker vi patterns), no real data | live + unit | `pnpm data:verify` | ❌ W0 | ⬜ pending |
| DATA-04 | seeds file validates; each scenario/anomaly/injection row present | unit + live | `seeds.test.ts` + verify reference SQL | ❌ W0 | ⬜ pending |
| DATA-05 | no agent/app source references gold/seed paths; `.openwikiignore` covers them | unit (no DB, runs in CI) | `pnpm --filter @se373/data test` (source scan) | ❌ W0 | ⬜ pending |
| DATA-06 | `data:verify` exits 0 on a good load, non-zero on any failed assertion | live | `pnpm data:verify` | ❌ W0 | ⬜ pending |
| DATA-07 | README: source, CC BY-NC-SA 4.0 attribution, transform log | review | — | ❌ W0 | ⬜ pending |
| D-06 | Phase 3 `db.live.test.ts` runs and passes against `agent_ro` | live (must run) | `DATABASE_URL=<agent_ro url> pnpm --filter @se373/mcp-server test` | ✅ exists | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/data/` scaffold (package.json, tsconfig with `tsBuildInfoFile` + references, vitest.config, src, test) wired into root tsconfig, `vitest.workspace.ts`, CODEOWNERS, `docs/architecture.md`
- [ ] `docker/docker-compose.yml` + `docker/initdb/01_roles.sql`, `02_schemas…`, `03_business.sql` (D-10); root scripts `db:up` / `db:down` / `db:reset`
- [ ] `packages/data/test/roles.live.test.ts` (DB-02/03/04)
- [ ] `packages/data/test/seeds.test.ts` (DATA-04/05 — zod validation + forbidden-path source scan, no DB)
- [ ] Unit tests for transform maps, date shift, manifest hashing (no DB)
- [ ] Human-approved installs: `pg-copy-streams`, `csv-parse`, `@faker-js/faker`, `@types/pg-copy-streams`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| README licence + transformation log | DATA-07 | Documentation content | Check README section names source URL, CC BY-NC-SA 4.0, attribution, every transform step |
| Docker lifecycle on a teammate machine | DB-01 | Needs Docker | `pnpm db:up`, `pnpm data:load`, `pnpm data:verify`, `pnpm db:reset` on a fresh clone |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s (unit)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
