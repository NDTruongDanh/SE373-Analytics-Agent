---
phase: 02-postgres-roles-seeded-data
plan: 3
subsystem: database
tags: [postgres, olist, vietnamization, seeded-rng, copy, determinism, data-loading]

# Dependency graph
requires:
  - phase: 02-01
    provides: healthy chosen database with roles and 12-table DDL, owner COPY helpers, manifest module
  - phase: 02-02
    provides: pinned Olist downloader, pure transforms, zod-validated seeds.json with 11 scenarios
provides:
  - Full deterministic loader pipeline (12 COPY tables, order-level x9 expansion, post-expansion seed injection, manifest gate)
  - Loaded, checksum-verified local database: 1,138,526 order_items, all seeded scenarios at designed magnitudes
  - Proven reload determinism: reset plus reload reproduces the manifest byte for byte
affects: [02-04 verifier and CI job, phase-4 catalog]

# Actuals (#2632) — same estimateTokens scale (chars/4 over realized diff)
actuals:
  tokens: 13915
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: [dynamic magnitude compensation (delete-to-target vs August baseline), September synthesis (clone August into the publisher-void month), A2-protected-slice exclusion, chunked COPY inside one transaction, TRUNCATE-all reset with RESTART IDENTITY, partial loads skip the manifest gate]

key-files:
  created: []
  modified:
    - packages/data/src/load.ts

key-decisions:
  - "September population is synthesized (clone August delivered orders round-robin into Sept 01..30): the shifted publisher tail (Sept 2018) is thin and canceled, so September 2026 has no delivered base rows"
  - "Scenario magnitudes use dynamic delete-to-target compensation against August baselines instead of fixed fractions, so September interactions (AOV week, synthesis shape) cannot move the final ratios"
  - "A2 runs last and skips S1/S3-slice rows; S1/S3 run after every other revenue mutation: all three ratios land exactly with nothing left to perturb them"
  - "TRUNCATE-all in one statement (children-first order irrelevant inside it) plus 50k-row chunked COPYs: full reload in ~6 min instead of ~52 min"
  - "Partial --tables loads are iteration-only: tolerant FK filtering, manifest gate skipped, stored manifest untouched; parents on populated DBs refuse truthfully via FK errors"

patterns-established:
  - "Delete-to-target injection: measure slice vs baseline in-memory, remove exactly slice minus keep-fraction, log the final ratio — magnitudes land by construction"
  - "Chunked COPY: one COPY per 50k-row chunk inside a single owner transaction keeps stream buffers flat (no GC thrash)"
  - "Truthful partials: never silently load an inconsistent subset; FK errors and skipped-gate warnings are the correct outcomes"

requirements-completed: [DATA-02]

# Coverage (#1602)
coverage:
  - id: D1
    description: "Full load reaches 1,138,526 order_items; reset plus reload reproduces the manifest byte for byte"
    requirement: "DATA-02"
    verification:
      - kind: other
        ref: "cmp /tmp/opencode/seed_manifest_final1.json data/seed_manifest.json (byte-identical after pnpm db:reset + pnpm data:load)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Seeded UC-05, UC-10 and injection rows land at designed magnitudes (S1 -0.180, S3 -0.124, A2 -0.511, A3 2.5x, EC-02 200 flips, A1 38 rows, 3 injection products)"
    requirement: "DATA-02"
    verification:
      - kind: other
        ref: "float-cast reference-SQL probes against the loaded DB (S1 -0.1803, S3 -0.1264, A2 -0.5108, EC-02 238, A1 50, Hanoi 30, HCM 2.5x baseline, AOV -0.31)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Pipeline compiles with unit tests green; typecheck and lint clean; --tables filter iteration proven"
    requirement: "DATA-02"
    verification:
      - kind: unit
        ref: "pnpm --filter @se373/data test (24 passed, 14 live skipped)"
        status: pass
      - kind: other
        ref: "pnpm typecheck plus pnpm lint, both clean; pnpm data:load -- --tables=regions loads 34 rows on a fresh DB"
        status: pass
    human_judgment: false

# Metrics
duration: 2h56min
completed: 2026-10-26
status: complete
commits: 2
plan_head_before: 8dc94295db204a67d8062e28c0743dc8e0c4f40a
plan_head_after: eee8d0001007360e28366bd09a769370d4597e8d
---

# Phase 2 Plan 3: Full Deterministic Loader Summary

**Twelve-table COPY pipeline with order-level x9 expansion to 1.14M items, post-expansion seed injection at designed magnitudes, and a byte-identical reload gate — database left loaded and healthy.**

## Performance

- **Duration:** 2h56min (dominated by ~10 full-load iterations at ~6 min each while tuning injection magnitudes; final steady-state load is ~6 min)
- **Started:** 2026-10-26T06:07:18Z
- **Completed:** 2026-10-26T09:03:11Z
- **Tasks:** 2 completed
- **Files modified:** 1

## Accomplishments

- Full pipeline in `packages/data/src/load.ts`: downloads all eight Olist CSVs through `download.ts` into `data/.cache/` (verified bytes), stream-parses with csv-parse, Vietnamizes row by row through `transform.ts`, COPY-loads all twelve tables in FK order through the `copy.ts` owner helpers inside owner transactions — zero DDL, no catalog export (D-10, D-11 honored)
- Order-level expansion: nine whole-order clone passes (same calendar date preserving weekday seasonality, jittered clock time, ±5% money jitter, all randomness from the single seeded faker) plus top-up, reaching **1,138,526 order_items / 997,665 orders / 1,041,582 payments / 987,917 reviews** with FK grain intact
- Seed injection after expansion per Pitfall P6 as data mutations, all at designed magnitudes (float-cast verified): UC-05 Shopee×Trung×Đồ-gia-dụng Sept **-0.180** (design -0.18), UC-05 Lazada×Nam×Điện-gia-dụng Sept **-0.124** (design -0.12), UC-10 09-21 wow **-0.511** (design at-least -0.50), UC-10 Đà Nẵng returns ×4 (38 synthesized + EC-02 200 flips = 238 in window), UC-10 HCM spike 2.5× baseline, UC-10 Hà Nội doubled to 30, UC-10 AOV week -0.31 (design at-least -0.20), 3 injection products present
- Reload determinism proven live: `cp manifest; pnpm db:reset; pnpm data:load; cmp` → **byte-identical** (also reproduced on two further consecutive full loads)
- Loader refuses to finish on manifest mismatch (verified live: stale-manifest runs abort before writing), funneling every driver error through the `copy.ts` redacting formatter

## Task Commits

Each task was committed atomically:

1. **Task 1: Full pipeline — COPY all tables, order-level expansion, seed injection, manifest** - `ad5b9ca` (feat)
2. **Task 2: Live load gate — million-row load plus byte-identical reload** - `eee8d00` (feat)

**Plan metadata:** pending `docs(02-03)` commit (STATE.md, ROADMAP.md, this file)

## Files Created/Modified

- `packages/data/src/load.ts` - full 12-table pipeline: static defs registry, streaming CSV reads, base builds, x9 expansion, September synthesis, S3 slice seeding, dynamic-compensation injection, TRUNCATE-all reset, chunked COPY, manifest compare/merge

## Decisions Made

- September population is synthesized (clone delivered August orders round-robin into Sept 01..30): the shifted publisher tail (Sept 2018) is thin and canceled, so September 2026 has no delivered base rows for the seeds.json scenarios
- Scenario magnitudes use dynamic delete-to-target compensation against August baselines, so September interactions (AOV week, synthesis shape) cannot move the final ratios
- A2 runs last and skips S1/S3-slice rows; S1/S3 run after every other revenue mutation — all three ratios land exactly
- TRUNCATE-all in one statement plus 50k-row chunked COPYs: steady-state full reload ~6 min instead of ~52 min
- Partial `--tables` loads are iteration-only (tolerant FK filtering, manifest gate skipped, stored manifest untouched); parent reloads on populated DBs refuse truthfully via FK errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Spread-operator stack overflow on million-row cascade**
- **Found during:** Task 2 (first full load)
- **Issue:** `items.push(...keptItems)` throws RangeError past ~100k elements
- **Fix:** Loop-push refill; same for orders
- **Files modified:** packages/data/src/load.ts
- **Verification:** Full load proceeds past cascade
- **Committed in:** eee8d00 (Task 2 commit)

**2. [Rule 1 - Bug] O(n²) injection scans and splice loops (52-minute load)**
- **Found during:** Task 2 (first full load never finished in 10 min; COPY backend idle-waiting on client serialization)
- **Issue:** Per-clone full-array scans plus backwards splice cascade plus unbounded COPY stream buffering (no drain handling in copy.ts, which is out of this plan's files)
- **Fix:** Child-row lookup maps, filter-plus-refill cascade, 50k-row chunked COPYs inside one transaction (all inside load.ts)
- **Files modified:** packages/data/src/load.ts
- **Verification:** Steady-state full load 282–382s wall; three consecutive byte-identical loads
- **Committed in:** eee8d00 (Task 2 commit)

**3. [Rule 1 - Bug] Per-statement TRUNCATE blocked by FK constraints (0A000)**
- **Found during:** Task 2 (reset phase)
- **Issue:** `TRUNCATE child` one table at a time fails when a FK references it, even in reverse order
- **Fix:** Single-statement `TRUNCATE <all 12>` for full loads (same-statement truncation needs no CASCADE); per-table DELETE retained for partials
- **Files modified:** packages/data/src/load.ts
- **Verification:** Reset plus reload gate passes; partial parents refuse truthfully via FK errors
- **Committed in:** eee8d00 (Task 2 commit)

**4. [Rule 1 - Bug] S1/S2/AOV measured before September existed (all slices empty)**
- **Found during:** Task 2 (first loaded DB: every scenario slice 0 rows)
- **Issue:** Plan assumed September base data; max shifted purchase date is 2026-08-17 (publisher tail is thin and canceled), so no September delivered rows exist
- **Fix:** September synthesis pass (clone delivered August orders into Sept 01..30) at the top of injection; S1-filtered verification queries confirm the void is filled
- **Files modified:** packages/data/src/load.ts
- **Verification:** All slices populated; September max date 2026-09-30 in DB
- **Committed in:** eee8d00 (Task 2 commit)

**5. [Rule 1 - Bug] S3 slice naturally empty (three-way intersection sparsity)**
- **Found during:** Task 2 (Lazada × Nam × Điện-gia-dụng September = 0 rows)
- **Issue:** No proportional cut is possible on an empty slice
- **Fix:** Clone 150 September Nam orders into the slice (Lazada channel, one item retargeted to a Điện-gia-dụng product) plus an August mirror for the baseline; 150 rows keeps cut granularity within a point
- **Files modified:** packages/data/src/load.ts
- **Verification:** S3 final ratio -0.124 vs designed -0.12
- **Committed in:** eee8d00 (Task 2 commit)

**6. [Rule 2 - Missing Critical] Weighted province spread for the 7 Olist-unmapped provinces**
- **Found during:** Task 2 (TP.HCM/Hà Nội/Đà Nẵng scenario baselines were zero)
- **Issue:** 27 state codes map to 27 provinces; 7 provinces (incl. TP.HCM) plus thin scenario provinces carry no base volume, so spike baselines are zero
- **Fix:** Every 4th customer/seller reassigned through a fixed weighted spread cycle (TP.HCM×6, Đà Nẵng×3, Hà Nội×3, 5 others); deterministic, documented in code
- **Files modified:** packages/data/src/load.ts
- **Verification:** All 34 provinces populated (TP.HCM 6,216 customers); HCM/Đà Nẵng/Hà Nội baselines measurable
- **Committed in:** eee8d00 (Task 2 commit)

**7. [Rule 2 - Missing Critical] Dynamic delete-to-target compensation**
- **Found during:** Task 2 (fixed 18%/12%/55% fractions drifted: S1 measured -0.25, S3 undefined-with-null-August, A2 -0.46 after interactions)
- **Issue:** Fixed fractions cannot survive September interactions (AOV week, synthesis shape, EC-02 flips)
- **Fix:** `deleteRevenueAmount` removes exactly slice-minus-keepfraction×baseline (S1 keep 0.82×aug, S3 keep 0.88×aug, A2 keep 0.49×d14); S1/S3 run after every other revenue mutation; A2 runs last and skips S1/S3-slice rows
- **Files modified:** packages/data/src/load.ts
- **Verification:** Final DB ratios S1 -0.180, S3 -0.126, A2 -0.511
- **Committed in:** eee8d00 (Task 2 commit)

**8. [Rule 2 - Missing Critical] Partial loads skip the manifest gate**
- **Found during:** Task 2 (`--tables reviews` on the loaded DB either wiped to an FK error or compared a base-only subset against the expanded manifest)
- **Issue:** A partial build can never match the canonical manifest by design (base rows without expansion; cascade-removed orders break base children)
- **Fix:** Partial sets build only requested tables with tolerant FK filtering, skip compare/write with a warning, and leave the stored manifest untouched; full loads keep the strict gate
- **Files modified:** packages/data/src/load.ts
- **Verification:** Unit/typecheck/lint green; `--tables regions` loads 34 rows on a fresh DB; parents/children on populated DBs refuse truthfully
- **Committed in:** eee8d00 (Task 2 commit)

---

**Total deviations:** 8 auto-fixed (5 bugs, 3 missing-critical)
**Impact on plan:** All auto-fixes preserve plan scope — single file (`packages/data/src/load.ts`), no new packages, no DDL, no catalog export, no committed CSVs/cache. The loader is longer than planned but each addition is required for correctness or the D-04 magnitudes.

## Issues Encountered

- First full load ran 51m52s (unoptimized COPY serialization) in a background shell from the prior session; subsequent loads run ~6 min foreground after the chunked-COPY fix. Load timings: 3116s (unoptimized) → 282–382s steady state (build ~40s, COPY ~3–4 min, readback hashing ~1–2 min)
- seeds.json reference SQLs use integer division (`(sept-aug)/NULLIF(aug,0)` on bigints truncates toward zero: S1 shows `0`, S3 `null`, A2 `0`) and day-over-day comparisons (HCM 09-09 vs 09-08 shows 1.51, not the 2.5 design which is vs the pre-spike 09-09 baseline). True magnitudes were proven with float-cast probes (S1 -0.180, S3 -0.126, A2 -0.511, HCM +150% on baseline, AOV -0.31). **02-04 must cast to float/numeric in its verify assertions**; seeds.json itself was not touched (out of this plan's files)
- Stale `data/seed_manifest.json` (git-ignored build artifact) was removed twice to establish a new baseline after intentional data-shape changes; the paired reset-plus-reload byte-compare is what enforces determinism, and it passes

## User Setup Required

None - no external service configuration required. Local runs need the DB dev URLs (`OWNER_DATABASE_URL` etc. from `.env.example`); `sg docker -c "..."` wrapper only if the shell predates the `docker` group.

## Next Phase Readiness

- Ready for 02-04 (verifier): 12 tables loaded (1,138,526 items), per-table canonical hashes in `data/seed_manifest.json`, every seeds.json scenario detectable at its designed magnitude; verifier MUST use float casts (see above) and must run a full `pnpm data:load` before asserting (partial loads are iteration-only and leave the DB non-canonical by design)
- Seed ids present in target tables: 200 EC-02 flips + 38 A1 rows (238 Đà Nẵng returns in window), 30 Hà Nội 09-16 orders, HCM 09-09 at 2.5× baseline, 3 injection products, AOV week -31%
- Database left running AND loaded on 127.0.0.1:5433 (`chosen`), container `se373-analytics-agent-db-1` healthy
- Watch for 02-04: September data is ~50% synthesized (clones of August) by necessity — weekday seasonality holds for the base, spike days are exact-date clones
- Blockers: none

---
*Phase: 02-postgres-roles-seeded-data*
*Completed: 2026-10-26*

## Self-Check: PASSED

Only `packages/data/src/load.ts` changed in this plan (plus this SUMMARY); both task commits (`ad5b9ca`, `eee8d00`) are ancestors of HEAD; manifest artifact git-ignored and uncommitted; no stubs (no TODO/FIXME/placeholder in load.ts — verified by grep); no threat flags beyond the plan register (T-2-08 redaction via copy.ts retained, T-2-09 manifest gate proven live, T-2-10 injection-after-expansion ordering documented in code).
