---
phase: 02-postgres-roles-seeded-data
plan: 2
subsystem: database
tags: [postgres, olist, vietnamization, faker, zod, vitest, data-hiding]
requires:
  - phase: 02-01
    provides: wired @se373/data package with COPY loader, zod manifest, role-proof suite
provides:
  - Pinned Olist downloader with triple byte verification into git-ignored cache
  - Pure Vietnamization transforms plus strict-zod seeds file with 3/5/3 scenarios
  - Unit plus DATA-05 hiding tests green with no DATABASE_URL
affects: [02-03 full load, 02-04 verifier and CI job]

actuals:
  tokens: 12554
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns: [author-time blob-SHA pinning with size+sha256 triple verify, pure-transform input layer with no pg/fs imports, declarative zod seeds file UC owners edit, source-scan test as hiding boundary]

key-files:
  created:
    - packages/data/src/download.ts
    - packages/data/src/transform.ts
    - packages/data/src/seeds.ts
    - packages/data/src/seeds.json
    - packages/data/test/load.unit.test.ts
    - packages/data/test/seeds.test.ts
    - data/seeded_scenarios.md
  modified:
    - packages/data/src/download.ts

key-decisions:
  - "Verify size plus git blob SHA-1 plus SHA-256 (not size alone): the GitHub contents API was reachable so every entry uses mode blob-sha with all three pins embedded"
  - "Uniform SeedEntry schema across UC-05, UC-10, and injections with an optional payload field, so one strict validator enforces the D-04 3/5/3 minima at load"
  - "Injection reference SQL uses products.name (the real DDL column), not the research-draft product_name"
  - "DATA-05 scan roots are packages/agent plus apps only: packages/data is operator tooling and legitimately references the seeds paths"

patterns-established:
  - "Downloader idiom: pure verifyDownloadedBytes plus thin fetch wrapper with explicit-arg beats env beats default, fail-fast errors naming the file and the retry action"
  - "Transform purity: data in, data out, no pg or node:fs imports, so UC owners can read every mapping without touching loader code"
  - "Hiding enforcement: source-scan test over agent/apps trees plus .openwikiignore assertion, both running with no database so CI enforces them"

requirements-completed: [DATA-03, DATA-04, DATA-05]

coverage:
  - id: D1
    description: "Pinned Olist downloader with byte verification into git-ignored cache"
    requirement: "DATA-04"
    verification:
      - kind: unit
        ref: "live download of translation CSV via downloadFile plus triple verify (size, blob SHA, sha256)"
        status: pass
      - kind: other
        ref: "pnpm typecheck green with eight-entry OLIST_FILES and cache under data/.cache"
        status: pass
    human_judgment: false
  - id: D2
    description: "Pure Vietnamization transforms (maps, shift, VND, status fold, seeded faker)"
    requirement: "DATA-03"
    verification:
      - kind: unit
        ref: "packages/data/test/load.unit.test.ts (province coverage, fallbacks, shift arithmetic, faker determinism)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Declarative seeds file with UC-05, UC-10, and injection scenarios plus scenario doc"
    requirement: "DATA-04"
    verification:
      - kind: unit
        ref: "packages/data/test/seeds.test.ts#loadSeeds validation matrix (real seeds file holds 3 UC-05, 5 UC-10, 3 injections)"
        status: pass
    human_judgment: false
  - id: D4
    description: "DATA-05 hiding boundary proven by automation with no database"
    requirement: "DATA-05"
    verification:
      - kind: unit
        ref: "packages/data/test/seeds.test.ts#DATA-05 hiding enforcement (agent/apps scan plus openwikiignore assertion, DATABASE_URL unset)"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-10-26
status: complete
plan_head_before: 8448b78b88234a0493f17a2ea13b512f8c54f992
plan_head_after: db9478ebe12d25a2d845a53a2a6834444bcb4061
---

# Phase 2 Plan 2: Pinned Olist Input Layer Summary

**Pinned publisher-byte downloader with triple verification, pure 34-province Vietnamization transforms, and a zod-validated seeds file with 11 scenarios — all covered by database-free tests**

## Performance

- **Duration:** 5 min
- **Started:** 2026-10-26T06:00:11Z
- **Completed:** 2026-10-26T06:05:34Z
- **Tasks:** 3 completed
- **Files modified:** 7

## Accomplishments

- `download.ts` pins all eight Olist CSVs (publisher blob SHA + byte size + SHA-256, resolved at author time from the live GitHub API) and verifies every byte stream before any parse, streaming into git-ignored `data/.cache/` with no Kaggle token or browser step
- `transform.ts` implements the deterministic input layer as pure functions: 27-code → 34-province map with Bắc/Trung/Nam groups, 71-entry English→Vietnamese category map with three explicit P4 fallbacks, +2905-day weekday-preserving shift with pre-2025 clipping, fixed 5150 VND rate, eight-to-three status fold, seeded `[vi, en, base]` faker factory
- `seeds.json` declares 3 UC-05 variance scenarios (incl. Shopee × Miền Trung × Đồ gia dụng stop from 05/09/2026), 5 UC-10 anomaly points (incl. Đà Nẵng returns ×4), and 3 prompt-injection product rows, each with dimension filter, period, magnitude, and SELECT-only reference SQL using real DDL columns
- `data/seeded_scenarios.md` documents every scenario, its business rationale, and the detection shape UC owners can extend by editing `seeds.json` only
- Full per-package suite green with no `DATABASE_URL` (24 passed, 14 live legs skip as designed); `typecheck` and `lint` green

## Task Commits

Each task was committed atomically:

1. **Task 1: Pinned Olist downloader** - `1a2178b` (feat)
2. **Task 2: Pure transforms plus seeds file and scenario doc** - `b382942` (feat)
3. **Task 3: Unit tests plus DATA-05 scan** - `db9478e` (feat)

**Plan metadata:** pending `docs(02-02)` commit (STATE.md, ROADMAP.md, this file)

## Files Created/Modified

- `packages/data/src/download.ts` - eight-entry FILE table, streaming fetch, triple byte verification, cache-dir resolution
- `packages/data/src/transform.ts` - pure province/category/date/currency/status/faker transforms
- `packages/data/src/seeds.ts` - strict-zod seeds loader in the SensitiveColumns idiom
- `packages/data/src/seeds.json` - declarative UC-05/UC-10/injection scenarios (3/5/3)
- `data/seeded_scenarios.md` - scenario documentation, business rationale, editing guide (DATA-05 hidden)
- `packages/data/test/load.unit.test.ts` - pure transform tests, faker determinism, manifest hash stability
- `packages/data/test/seeds.test.ts` - validation matrix plus DATA-05 agent/apps source scan

## Decisions Made

- Triple verification (size + blob SHA-1 + SHA-256) since the contents API was reachable — all eight entries pinned in `blob-sha` mode with the mode recorded per entry
- Uniform `SeedEntry` schema with optional `payload` for injections, letting one validator enforce the 3/5/3 minima
- Injection `reference_sql` targets `products.name` per the real `03_business.sql` DDL
- Hiding scan covers `packages/agent` + `apps` only; `packages/data` is operator tooling and may reference seed paths

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Injection reference SQL used a non-DDL column**
- **Found during:** Task 2 (grounding `reference_sql` against `03_business.sql`)
- **Issue:** Research-draft SQL used `products.product_name`; the real DDL column is `products.name` — verify (02-04) would fail on every injection leg
- **Fix:** Rewrote all three injection `reference_sql` clauses to `WHERE name LIKE ...`
- **Files modified:** packages/data/src/seeds.json
- **Verification:** SQL shapes re-checked against DDL column list; seeds validation test green
- **Committed in:** b382942 (Task 2 commit)

**2. [Rule 1 - Bug] Unused `existsSync` import broke lint**
- **Found during:** Task 3 (`pnpm lint`)
- **Issue:** Task 1 cleanup left the top-level `node:fs` `existsSync` import unused after `downloadAll` switched to a scoped dynamic import
- **Fix:** Removed the unused name from the top-level import
- **Files modified:** packages/data/src/download.ts
- **Verification:** `pnpm lint` clean, per-package suite still green
- **Committed in:** db9478e (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both auto-fixes preserve plan scope — no new packages, no schema or root-wiring changes, no committed CSVs or cache data.

## Issues Encountered

None beyond the auto-fixed deviations above. Precondition held: both `raw.githubusercontent.com` and `api.github.com` reachable, so all eight blob SHAs were resolved live at author time (no byte-size fallback mode needed). DB left running for later plans; `data/.cache/` in the repo tree untouched (live-download probe used a `/tmp` cache).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for 02-03 (full loader): `downloadAll` + `loadSeedsFile` + pure transforms are the exact inputs the COPY pipeline, ×9 expansion, and seed injection need
- Ready for 02-04 (verifier): every `reference_sql` is a single SELECT against real DDL columns; the DATA-05 scan already guards agent/apps trees
- Watch for 02-03: the 7 provinces beyond the first 27 carry no Olist code and must be populated by synthetic expansion; early Olist orders (pre-2017-01-18 purchase dates) clip to null per the documented pre-2025 rule — the loader must count and log the clipped loss
- Blockers: none

---
*Phase: 02-postgres-roles-seeded-data*
*Completed: 2026-10-26*

## Self-Check: PASSED

All 7 key files exist on disk; all 3 task commits are ancestors of HEAD. No stubs, no threat flags beyond the plan's threat register (T-2-05 downloader egress, T-2-06 seeds shape, T-2-07 synthetic PII — all carry the planned disposition).
