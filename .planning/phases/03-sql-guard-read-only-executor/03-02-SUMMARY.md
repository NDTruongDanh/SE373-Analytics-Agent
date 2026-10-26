---
phase: 03-sql-guard-read-only-executor
plan: 2
subsystem: database
tags: [sql-guard, pgsql-parser, vitest, contract-codes, bypass-matrix]
requires:
  - phase: 03-01
    provides: sqlGuard allowlist walk plus injected-catalog check, SchemaCatalog contract, workspace wiring
provides:
  - Shared Olist-modelled fixture catalog consumed by all guard tests
  - Full 82-case guard matrix (valid plus malicious plus error-shape) asserting contract codes
affects: [03-03-read-only-executor, 03-04-policy-seam, phase-4-mcp-server]
actuals:
  tokens: 4779
  tasks: 2
  commits: 2
  plan_head_before: 27ce97289d3bf999dc751cdd1446b4cce57f8f2c
  plan_head_after: 6a7dddcf80eeaf857b8d023628f9919982585834
tech-stack:
  added: []
  patterns: [shared Olist fixture module, expectReject contract-code helper, per-denylist-entry test cases]
key-files:
  created: [packages/sql-guard/test/fixtures.ts]
  modified: [packages/sql-guard/test/guard.test.ts]
key-decisions:
  - "V5/V9 group on status not region: the locked Olist fixture has no orders.region, so the RESEARCH shorthand was corrected to a real orders column with identical GROUP BY plus aggregate coverage; the fixture stays DB-faithful for Phase 2/4"
  - "dblink and dblink_exec args use dollar-quoting ($$SELECT 1$$): nested single quotes would be a SQL syntax error and test the parser instead of the denylist"
  - "M13 expanded from 10 to 16 cases so every denylist.ts entry has its own FORBIDDEN_FUNCTION case"
  - "UNION rows use real catalog tables (customers/orders): placeholder t1/t2 names would be UNKNOWN_TABLE and test the catalog instead of the UNION walk"
requirements-completed: [GUARD-01, GUARD-02, GUARD-03]
coverage:
  - id: D1
    description: "Shared Olist-modelled fixture catalog (12 tables, lowercase columns) injected into every guard test"
    requirement: GUARD-03
    verification:
      - kind: unit
        ref: "packages/sql-guard/test/guard.test.ts#sqlGuard valid shapes (16 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sixteen valid shapes pass (no-FROM, alias, JOIN, UNION/UNION ALL, CTE, subquery, DISTINCT ON, window, aggregates, public schema, quoted identifiers, comments, TABLE, case variation) plus parser version-18 tripwire"
    requirement: GUARD-01
    verification:
      - kind: unit
        ref: "packages/sql-guard/test/guard.test.ts#V1..V14 plus parser version tripwire"
        status: pass
    human_judgment: false
  - id: D3
    description: "All 24 RESEARCH bypass rows rejected with exact contract codes (M1-M24 incl schema-qualified case-varied pg_sleep, full 17-entry denylist, system schemas, unknown table/column, quoted injection-style name)"
    requirement: GUARD-02
    verification:
      - kind: unit
        ref: "packages/sql-guard/test/guard.test.ts#sqlGuard malicious matrix (63 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Empty and malformed SELECT rejected with INVALID_SQL carrying a numeric cursor position"
    requirement: GUARD-01
    verification:
      - kind: unit
        ref: "packages/sql-guard/test/guard.test.ts#sqlGuard error shapes (2 cases)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Repo lint stays green on the expanded matrix"
    requirement: GUARD-03
    verification:
      - kind: other
        ref: "pnpm lint exit 0"
        status: pass
    human_judgment: false
duration: 3min
completed: 2026-10-25
status: complete
---

# Phase 3 Plan 2: Guard Matrix Summary

**Full 82-case guard matrix over a shared Olist fixture: every RESEARCH bypass row asserted with its contract code, suite and lint green, no guard changes needed**

## Performance

- **Duration:** 3 min
- **Started:** 2026-10-25T15:32:37Z
- **Completed:** 2026-10-25T15:35:51Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Shared `fixtureCatalog` module modelling the 12 planned Olist tables (all lowercase) so Phase 2/4 can swap in the real DB-built catalog without guard changes
- Valid side: 16 cases covering all 14 RESEARCH valid rows (UNION and comment rows doubled) plus an AST `version`-starts-with-18 tripwire that fails loudly on a major parser bump
- Malicious side: 63 cases covering all 24 RESEARCH bypass rows with exact contract codes — stacked/comment-hidden statements, CTE-wrapped and nested-CTE DML, SELECT INTO (plain/TEMP/UNLOGGED), locking clauses, schema-qualified case-varied `pg_sleep`, every one of the 17 denylisted functions as its own case, COPY both directions, transaction/session/show/explain/DDL/grant/merge/listen-notify/prepare-execute utility statements, system schemas, unknown table/column, quoted injection-style table name
- Error shapes: empty input and `SELECT FROM WHERE` both yield `INVALID_SQL` with a numeric cursor position
- Full package suite 82/82 green; `pnpm lint` exit 0; no new npm packages, `pnpm-lock.yaml` untouched

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared fixture catalog plus all valid-shape cases** - `61da4db` (feat)
2. **Task 2: Full malicious matrix plus error-shape cases** - `6a7dddc` (feat)

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified

- `packages/sql-guard/test/fixtures.ts` - Shared Olist-modelled `fixtureCatalog` (12 tables, lowercase columns)
- `packages/sql-guard/test/guard.test.ts` - Full 82-case matrix: valid shapes, malicious matrix, error shapes, version tripwire

## Decisions Made

- V5/V9 group on `status` not `region`: the locked Olist fixture (RESEARCH header) has no `orders.region`, so the RESEARCH shorthand was corrected to a real `orders` column with identical GROUP BY plus aggregate coverage; the fixture stays DB-faithful for Phase 2/4.
- `dblink`/`dblink_exec` args use dollar-quoting (`$$SELECT 1$$`): nested single quotes would be a SQL syntax error and test the parser instead of the denylist.
- M13 expanded from 10 to 16 cases so every `denylist.ts` entry (all 17, with `pg_sleep` covered by M11) has its own `FORBIDDEN_FUNCTION` case.
- UNION rows use real catalog tables (`customers`/`orders`): placeholder `t1`/`t2` names would be `UNKNOWN_TABLE` and test the catalog instead of the UNION walk.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test-input correction] RESEARCH V5/V9 rows referenced orders.region, absent from the locked fixture**
- **Found during:** Task 1 (valid-side matrix, first test run: 2 failed of 17)
- **Issue:** `SELECT region ... FROM orders GROUP BY region` was rejected `UNKNOWN_TABLE` — correctly, since the RESEARCH fixture header lists `orders(id,customer_id,total,status,created_at)` with no `region` column. The guard needed no change; the test inputs mismatched the locked catalog.
- **Fix:** Grouped and selected on `status` (a real `orders` column) in V5 and V9, preserving identical coverage (single-level CTE plus grouped aggregates with star-count and HAVING). No case weakened: both still prove the intended valid shapes pass.
- **Files modified:** packages/sql-guard/test/guard.test.ts
- **Verification:** `pnpm --filter @se373/sql-guard test` 17/17 pass
- **Committed in:** 61da4db (part of task commit)

---

**Total deviations:** 1 auto-fixed (test-input correction; zero guard-code changes — the guard passed the full malicious matrix first try)
**Impact on plan:** Fixture stays byte-faithful to the RESEARCH header for Phase 2/4 reuse. No scope creep; lockfile untouched.

## Issues Encountered

None beyond the single V5/V9 input correction above; the malicious matrix (63 cases) passed on its first run with no guard fixes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for 03-03 (read-only executor) and 03-04 (policy seam): guard evidence is complete (GUARD-01/02/03), no catalog or guard API changes needed.
- No blockers. No DATABASE_URL needed for any gate in this plan.

## Self-Check: PASSED

- All key files exist on disk (`fixtures.ts`, `guard.test.ts`); both task commits (`61da4db`, `6a7dddc`) are ancestors of HEAD; no deletions in either commit; suite 82/82 green; lint exit 0.

---
*Phase: 03-sql-guard-read-only-executor*
*Completed: 2026-10-25*
