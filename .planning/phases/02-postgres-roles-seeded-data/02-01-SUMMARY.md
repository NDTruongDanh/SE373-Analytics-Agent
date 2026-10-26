---
phase: 02-postgres-roles-seeded-data
plan: 1
subsystem: database
tags: [postgres, pgvector, docker, roles, copy, vitest, faker, csv-parse]

# Dependency graph
requires:
  - phase: 01-monorepo-contracts-freeze
    provides: workspace wiring conventions (tsconfig refs, vitest workspace, CODEOWNERS, architecture doc)
provides:
  - Healthy `chosen` database on 5433 with owner/agent_ro/indexer roles and 12-table business DDL
  - Wired `@se373/data` package with COPY loader, zod manifest, and role-proof suite
  - Proven grant layer: 42501-after-override matrix plus 57014 timeout, both live suites green
affects: [02-02 downloader, 02-03 full load, 02-04 verifier and CI job, phase-4 catalog]

# Actuals (#2632) — same estimateTokens scale (chars/4 over realized diff)
actuals:
  tokens: 12100
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: [pg-copy-streams@7.0.0, csv-parse@7.0.3, "@faker-js/faker@10.6.0", "@types/pg-copy-streams@1.2.5 (dev)", "@types/node@^24.19.2 (dev, shared with access-policy)"]
  patterns: [owner-pool COPY loader, strict-zod manifest with mismatch refusal, separate-driver-call override tests]

key-files:
  created:
    - docker/docker-compose.yml
    - docker/initdb/01_roles.sh
    - docker/initdb/02_schemas.sql
    - docker/initdb/03_business.sql
    - packages/data/package.json
    - packages/data/tsconfig.json
    - packages/data/vitest.config.ts
    - packages/data/src/copy.ts
    - packages/data/src/load.ts
    - packages/data/src/manifest.ts
    - packages/data/test/roles.live.test.ts
  modified:
    - package.json
    - tsconfig.json
    - vitest.workspace.ts
    - pnpm-lock.yaml
    - .github/CODEOWNERS
    - .env.example
    - .gitignore
    - .openwikiignore
    - docs/architecture.md

key-decisions:
  - "Compose uses --project-directory . so ./docker/initdb resolves from the repo root and the root .env is picked up when present; clean clones fall back to :- defaults"
  - "03_business.sql runs DDL as SET ROLE owner plus SET search_path TO business so tables are owner-owned and default privileges fire"
  - "Loader reset uses DELETE FROM, not TRUNCATE CASCADE, so FK-referencing tables never wipe dependents"
  - "Shell marker (src/index.ts + shell.test.ts) follows the repo shell-package convention because vitest exits 1 on zero test files"

patterns-established:
  - "Owner-pool COPY pattern: createOwnerPool fail-fast, withOwnerTx BEGIN/COMMIT/ROLLBACK/release, copyTable streaming rows via pg-copy-streams, one redacting error funnel"
  - "Manifest pattern: strict-zod {version, seed, dataset_version, tables}, canonical ORDER BY pk CSV sha256, comparator the loader calls to refuse finishing on mismatch"
  - "Override-path test pattern: one fresh pg Client per write leg, SET and write as separate driver calls, assert 42501; timeout leg uses SET LOCAL 2s plus pg_sleep(5) expecting 57014"

requirements-completed: [DB-01, DB-02, DB-03, DB-04, DATA-01]

# Coverage (#1602) — every deliverable backed by a passing verification
coverage:
  - id: D1
    description: "Healthy chosen database on 5433 with three roles, four schemas, and 12-table DDL"
    requirement: "DB-01"
    verification:
      - kind: other
        ref: "pnpm db:up then container pg_isready accepting connections plus 12 business tables owner-owned"
        status: pass
    human_judgment: false
  - id: D2
    description: "@se373/data scaffold wired into workspace with all Phase 2 installs in one lockfile"
    requirement: "DB-02"
    verification:
      - kind: other
        ref: "pnpm install plus pnpm typecheck plus pnpm lint, all green"
        status: pass
      - kind: unit
        ref: "packages/data/test/shell.test.ts#data shell"
        status: pass
    human_judgment: false
  - id: D3
    description: "Tracer COPY load: 34 regions rows through the real pipeline with seed manifest"
    requirement: "DATA-01"
    verification:
      - kind: other
        ref: "pnpm data:load prints loaded regions: 34 rows plus data/seed_manifest.json with matching sha256"
        status: pass
    human_judgment: false
  - id: D4
    description: "Grant layer proven: full 42501-after-override matrix plus 57014 timeout"
    requirement: "DB-03"
    verification:
      - kind: integration
        ref: "packages/data/test/roles.live.test.ts (14 legs, separate driver calls per statement)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Phase 3 db.live.test.ts runs green against agent_ro (D-06 deferred proof closed)"
    requirement: "DB-04"
    verification:
      - kind: integration
        ref: "packages/mcp-server/test/db.live.test.ts#runs a bounded read with truncated false"
        status: pass
    human_judgment: false

# Metrics
duration: 7min
completed: 2026-10-26
status: complete
commits: 3
plan_head_before: 5b9c59906ea446657d6e46fdc4a03906d6aa71e3
plan_head_after: ffe7b2d2b0cf5a2d2659098032a06672d2d5d29b
---

# Phase 2 Plan 1: Compose plus tracer slice Summary

**Pinned pgvector database on 5433 with three roles and 12-table DDL, wired @se373/data package COPY-loading regions, and a 14-leg role-proof suite green with 42501/57014 codes**

## Performance

- **Duration:** 7 min
- **Started:** 2026-10-26T05:49:02Z
- **Completed:** 2026-10-26T05:56:29Z
- **Tasks:** 3 completed
- **Files modified:** 22

## Accomplishments

- `pnpm db:up` brings a healthy `chosen` database to host port 5433: owner/agent_ro/indexer roles, business/semantic/langgraph/app_state schemas, 12 FK-linked tables owner-owned
- `@se373/data` scaffold wired (package.json, tsconfig, vitest config, root refs, workspace entry, CODEOWNERS) with all Phase 2 installs in a single lockfile commit
- Regions COPY-loaded through `pg-copy-streams` (34 rows, sha256 manifest at git-ignored `data/seed_manifest.json`)
- 14-leg role-proof matrix green: agent_ro SELECT works, every write path fails 42501 after `SET default_transaction_read_only=off` and after `BEGIN`/`READ WRITE`, nextval/`SET ROLE`/CREATE/TEMP/SELECT INTO denied, 57014 timeout proven, indexer RW scoped correctly
- Phase 3 `db.live.test.ts` runs (not skips) and passes against `agent_ro`, closing the D-06 deferred proof

## Task Commits

Each task was committed atomically:

1. **Task 1: Compose plus initdb** - `b60ef30` (feat)
2. **Task 2: packages/data scaffold plus single lockfile commit** - `8536bb1` (feat)
3. **Task 3: Tracer load path plus role-proof tests** - `ffe7b2d` (feat)

**Plan metadata:** pending `docs(02-01)` commit (STATE.md, ROADMAP.md, this file)

## Files Created/Modified

- `docker/docker-compose.yml` - pinned `pgvector/pgvector:0.8.7-pg16` service, volume, ro initdb mount, healthcheck
- `docker/initdb/01_roles.sh` - executable role/session-default wrapper with local-only dev defaults
- `docker/initdb/02_schemas.sql` - four schemas, public/TEMP revokes, least-privilege grants, default privileges
- `docker/initdb/03_business.sql` - 12-table FK-linked DDL with inline PKs, secondary indexes, owner-owned via SET ROLE
- `packages/data/src/copy.ts` - owner pool, transactional COPY, redacting error funnel
- `packages/data/src/manifest.ts` - strict-zod seed manifest with writer/reader/comparator
- `packages/data/src/load.ts` - TABLE_LOADERS registry (`--tables` filter), 34-province regions slice, manifest write
- `packages/data/test/roles.live.test.ts` - 14-leg 42501/57014 matrix gated on all three role URLs
- `packages/data/src/index.ts`, `packages/data/test/shell.test.ts` - shell marker following repo shell-package convention
- `package.json` - `db:up/down/reset`, `data:load/verify` root scripts
- `.env.example` - DB block with dev defaults, never-reuse and reset-after-password-change notes
- `.gitignore` / `.openwikiignore` - loader cache, seed manifest, seeds doc hiding (DATA-05)
- `docs/architecture.md` - section 7 database details plus packages/data status-table row

## Decisions Made

- `--project-directory .` on all `db:*` scripts: keeps `./docker/initdb` resolving from the repo root and picks up the root `.env` when present while clean clones work on defaults
- Unqualified DDL in `03_business.sql` runs under `SET search_path TO business` after `SET ROLE owner`, so tables land owner-owned in the right schema and default privileges fire
- Loader reset uses `DELETE FROM` instead of `TRUNCATE … CASCADE` (regions is FK-referenced; CASCADE would be a footgun once dependents load)
- Shell marker added per the repo shell-package convention (`shell.test.ts` + `*_SHELL` export): vitest exits 1 on zero test files, so the plan's "empty suite passes" assumption needed a one-test scaffold

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Unqualified CREATE TABLE defaulted to revoked `public` schema**
- **Found during:** Task 1 (first `db:up` against fresh volume)
- **Issue:** `SET ROLE owner` does not change `search_path`, so `CREATE TABLE regions` targeted `public`, where CREATE was revoked — init failed with `permission denied for schema public`
- **Fix:** Added `SET search_path TO business;` after `SET ROLE owner` in `03_business.sql`
- **Files modified:** docker/initdb/03_business.sql
- **Verification:** `pnpm db:reset` healthy; 12 tables present, all owner-owned in `business`
- **Committed in:** b60ef30 (Task 1 commit)

**2. [Rule 1 - Bug] TRUNCATE blocked by FK references on empty dependent tables**
- **Found during:** Task 3 (first `data:load`)
- **Issue:** `TRUNCATE business.regions` fails with 0A000 because customers/sellers/employees FK-reference it, even while empty
- **Fix:** Reset via `DELETE FROM` with a comment noting 02-03 may switch to an ordered whole-registry TRUNCATE
- **Files modified:** packages/data/src/load.ts
- **Verification:** `pnpm data:load` prints `loaded regions: 34 rows` with matching manifest
- **Committed in:** ffe7b2d (Task 3 commit)

**3. [Rule 3 - Blocking] Vitest exits 1 with zero test files, failing the Task 2 verify**
- **Found during:** Task 2 (`pnpm --filter @se373/data test`)
- **Issue:** Plan assumed the empty suite passes, but vitest reports `No test files found, exiting with code 1`
- **Fix:** Added `src/index.ts` (`DATA_SHELL` marker) plus `test/shell.test.ts`, copying the `mcp-server`/`access-policy` shell-package convention from the Phase 1 quick fix
- **Files modified:** packages/data/src/index.ts, packages/data/test/shell.test.ts
- **Verification:** Per-package suite passes (1 test); Task 3 adds the real suite alongside it
- **Committed in:** 8536bb1 (Task 2 commit)

**4. [Rule 3 - Blocking] `pg_isready` absent on host, port-check adapted**
- **Found during:** Task 1 verify
- **Issue:** Prescribed `pg_isready -h localhost` cannot run — no Postgres client on the host
- **Fix:** Verified health the narrowest equivalent way: container-side `pg_isready` (accepting connections), compose `Healthy` state, plus direct `psql` counts (12 tables, owner-owned, `rolconfig` readback) and the grep-count legs verbatim
- **Files modified:** none (verify environment only)
- **Verification:** All acceptance criteria met; documented here for the record
- **Committed in:** n/a (no code change)

---

**Total deviations:** 4 auto-fixed (2 bugs, 2 blocking)
**Impact on plan:** All auto-fixes preserve plan scope — no new packages, no schema changes beyond the planned 12 tables, no root-wiring changes beyond plan file lists. Later plans touch no lockfile and no root wiring owned here.

## Package Approval Record

Human APPROVED (no holds) before execution for `@se373/data`: `pg-copy-streams@7.0.0`, `csv-parse@7.0.3`, `@faker-js/faker@10.6.0`, `@types/pg-copy-streams@1.2.5` (dev), `@types/node@^24` (dev); `pg`/`@types/pg` already in the lockfile. Installed exactly this set (plus the already-locked `@se373/contracts` workspace dep and the shared `zod` copy — no new packages). Before installing, re-ran `npm view` for each new specifier (all resolved to the approved versions) and printed each `postinstall` entry (all empty) — install proceeded only on that clean result.

## Issues Encountered

None beyond the auto-fixed deviations above. Tracer gate: `end-of-phase` mode with automated-only verify — re-ran the full gate end-to-end (compose up, regions COPY, both live suites) green, no checkpoint. DB left running for later plans; `data/seed_manifest.json` regenerates per load and stays git-ignored.

## User Setup Required

None - no external service configuration required. Optional: `cp .env.example .env` for key-holding runs; `sg docker -c "…"` wrapper only if the shell predates the `docker` group (documented in architecture §7).

## Next Phase Readiness

- Ready for 02-02 (Olist downloader): `TABLE_LOADERS` registry, `copyTable` streaming, and manifest plumbing accept new tables without loader rewrites
- Ready for 02-03 (full load): reset semantics (`DELETE FROM`) and `--tables` filter support incremental table onboarding
- Watch for 02-04: `data:verify` script entry exists but `packages/data/src/verify.ts` is not yet written; CI db-live job likewise pending
- Blockers: none

---
*Phase: 02-postgres-roles-seeded-data*
*Completed: 2026-10-26*

## Self-Check: PASSED

All 9 key files exist on disk; all 3 task commits are ancestors of HEAD. No stubs, no threat flags beyond the plan's threat register (T-2-01 dev passwords documented as local-only).
