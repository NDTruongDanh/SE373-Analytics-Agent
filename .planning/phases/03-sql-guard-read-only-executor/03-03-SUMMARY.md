---
phase: 03-sql-guard-read-only-executor
plan: 3
subsystem: database
tags: [pg, pg-cursor, read-only-executor, error-sanitization, vitest]

# Dependency graph
requires:
  - phase: 03-01
    provides: sqlGuard allowlist package plus all Phase 3 npm installs
provides:
  - Guard-first read-only executor (BEGIN READ ONLY through ROLLBACK with release-in-finally) in the only driver-touching module
  - Single sanitizeError choke point with PG-code map and redaction
  - DATABASE_URL-gated live tests that stay green by skipping
affects: [03-04-policy-seam, phase-4-mcp-server]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 6216
  tasks: 3
  commits: 3
  plan_head_before: 2a68eb85803ec6b4fd27018eb345fe8cd43be04d
  plan_head_after: fc7832f00d9d43ebb123d27cdf4c08f5a042d969

# Tech tracking
tech-stack:
  added: []
  patterns: [structural PoolLike/ClientLike/CursorLike seams with hand fakes, guard-before-checkout executor, single error-formatting choke point, describe.skipIf DATABASE_URL gate]

key-files:
  created:
    - packages/mcp-server/src/errors.ts
    - packages/mcp-server/src/db.ts
    - packages/mcp-server/test/errors.test.ts
    - packages/mcp-server/test/db.test.ts
    - packages/mcp-server/test/db.live.test.ts
  modified:
    - packages/mcp-server/package.json
    - packages/mcp-server/tsconfig.json
    - pnpm-lock.yaml

key-decisions:
  - "runQuery returns RunQueryOutput | DbToolError: guard rejection returns the guard's DbToolError directly, distinguishable by the code field"
  - "Error path attempts ROLLBACK before the sanitized return (in addition to release in finally) so a failed statement never poisons the pooled session"
  - "Path redaction applies to detail/hint only, never message, so SQL division (10/2) survives the sanitizer"
  - "Option validation (maxRows 1..1000, timeoutMs 1..300000) returns INVALID_PARAMS before the guard, so bad server-side config never reaches checkout either"

patterns-established:
  - "Structural driver seams: production pg/pg-cursor code lives behind PoolLike/ClientLike/CursorLike; tests inject hand fakes and never import the driver (except the gated live file)"
  - "Guard-before-checkout: runQuery validates options, runs sqlGuard, and only then connects — rejected SQL never touches a connection"

requirements-completed: [GUARD-04, GUARD-05]

# Coverage metadata (#1602) — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "sanitizeError choke point mapping PG codes to contract codes with DSN/host/IP/path redaction and 500-char cap"
    requirement: GUARD-05
    verification:
      - kind: unit
        ref: "packages/mcp-server/test/errors.test.ts#sanitizeError PG-code map / redaction / cap (25 tests)"
        status: pass
      - kind: other
        ref: "pnpm lint exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "Guard-first read-only executor proving exact command order, always-release on all error paths, truncation boundary, and sanitized TIMEOUT"
    requirement: GUARD-04
    verification:
      - kind: unit
        ref: "packages/mcp-server/test/db.test.ts#runQuery happy path / truncation / guard-first / validation / always-release (17 tests)"
        status: pass
      - kind: other
        ref: "pnpm typecheck exit 0; pnpm lint exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "DATABASE_URL-gated live executor tests that skip green without a database"
    requirement: GUARD-04
    verification:
      - kind: integration
        ref: "pnpm --filter @se373/mcp-server test → 43 passed, 1 skipped (db.live.test.ts skipped, no connection attempted)"
        status: pass
    human_judgment: false

# Metrics
duration: 6min
completed: 2026-10-25
status: complete
---

# Phase 3 Plan 3: Read-Only Executor Summary

**Guard-first read-only executor with cursor-bounded reads plus the single sanitizeError choke point, proven by fake-injected unit tests and DATABASE_URL-gated live tests — full workspace suite green at 150 passed with the live file skipped**

## Performance

- **Duration:** 6 min
- **Started:** 2026-10-25T15:38:43Z
- **Completed:** 2026-10-25T15:44:21Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- `sanitizeError()` single choke point: PG SQLSTATE map (57014→TIMEOUT, 42601→INVALID_SQL, 42P01/42703/3D000/3F000→UNKNOWN_TABLE, 25006/42501→FORBIDDEN_STATEMENT, class-08/53xxx→INTERNAL_ERROR, default INTERNAL_ERROR), DSN/host/IP/user redaction on message-like fields, path redaction on detail/hint only, stacks dropped, 500-char cap — 25 tests including the canary DSN case
- `runQuery` guard-first executor in `db.ts`, the only file importing `pg`/`pg-cursor`: validated maxRows/timeoutMs, sqlGuard before any pool checkout, BEGIN READ ONLY → SET LOCAL statement_timeout → cursor read(maxRows+1) → truncated flag → close → ROLLBACK, release in finally with rollback attempt on error paths — 17 fake-injected tests proving exact order, truncation boundary, guard-rejection with zero connects, and sanitized TIMEOUT
- `db.live.test.ts` gated on `describe.skipIf(!process.env.DATABASE_URL)`: builds a real pg Pool inside the gated block only; suite reports 43 passed / 1 skipped with no DATABASE_URL and no connection attempted
- Full workspace gate green: 150 passed / 1 skipped, `pnpm typecheck` and `pnpm lint` exit 0

## Task Commits

Each task was committed atomically:

1. **Task 1: sanitizeError choke point plus redaction tests** - `668b5b2` (feat)
2. **Task 2: Guard-first read-only executor plus fake-injected lifecycle tests** - `5e39004` (feat)
3. **Task 3: DATABASE_URL-gated live tests that stay green by skipping** - `fc7832f` (feat)

**Plan metadata:** this commit (docs: complete plan)

_Note: Task 2's commit also carries the workspace wiring fix (package.json/tsconfig.json/pnpm-lock.yaml) documented below as a Rule 3 deviation._

## Files Created/Modified

- `packages/mcp-server/src/errors.ts` - `sanitizeError(unknown): DbToolError`, the only DB error formatter
- `packages/mcp-server/src/db.ts` - `PoolLike`/`ClientLike`/`CursorLike` seams, `PgPoolAdapter`, guard-first `runQuery`
- `packages/mcp-server/test/errors.test.ts` - Per-code map, canary redaction, 500-char cap, retryable flags, fallbacks
- `packages/mcp-server/test/db.test.ts` - Order, truncation, guard-first, option validation, four always-release paths
- `packages/mcp-server/test/db.live.test.ts` - `DATABASE_URL`-gated bounded-read test, skips without a DB
- `packages/mcp-server/package.json` - Added `@se373/sql-guard: workspace:*` (Rule 3 fix, see deviations)
- `packages/mcp-server/tsconfig.json` - Project reference to `../sql-guard` for build ordering (Rule 3 fix)
- `pnpm-lock.yaml` - 3-line importer entry for the workspace link; no new npm specifier, no version churn

## Decisions Made

- `runQuery` returns `RunQueryOutput | DbToolError`: guard rejection returns the guard's `DbToolError` directly; callers discriminate on the `code` field (only `DbToolError` carries one). Keeps the guard's exact code/message instead of re-wrapping.
- Error path attempts `ROLLBACK` before the sanitized return (swallowing rollback failure), in addition to `release()` in `finally`: satisfies T-3-10 on every path — a failed statement never poisons the pooled session with `25P02`.
- Path redaction applies to `detail`/`hint` only, never `message`: a `/` in message text may be SQL division (`SELECT 10/2`), and the canary test locks that `10/2` survives while `/var/lib/...` in detail is redacted.
- Option validation (`maxRows` 1..1000 mirroring `RunQueryInputSchema`, `timeoutMs` 1..300000) returns `INVALID_PARAMS` before the guard: neither bad config nor rejected SQL ever reaches pool checkout.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] mcp-server was missing the @se373/sql-guard workspace dependency**
- **Found during:** Task 2 (executor needs guard-first ordering; `packages/mcp-server/node_modules/@se373/` held only `contracts`)
- **Issue:** 03-01 installed `pg`/`pg-cursor` into mcp-server but never added the `@se373/sql-guard: workspace:*` link, so `import { sqlGuard } from "@se373/sql-guard"` in `db.ts` could not resolve at typecheck or test runtime. Without it the plan's must-have truth "guard runs inside runQuery before any pool checkout" is unreachable.
- **Fix:** Added `"@se373/sql-guard": "workspace:*"` to `packages/mcp-server/package.json`, a `../sql-guard` project reference to `packages/mcp-server/tsconfig.json` (D-03 build ordering), and ran `pnpm install`. The lockfile diff is exactly the 3-line importer entry — no new npm specifier (T-3-SC holds: nothing to legitimacy-review), no version churn. `packages/mcp-server/test/*` still never imports `pg` except the gated live file, which the plan requires.
- **Files modified:** packages/mcp-server/package.json, packages/mcp-server/tsconfig.json, pnpm-lock.yaml
- **Verification:** `pnpm --filter @se373/mcp-server test` 43 passed, `pnpm typecheck` exit 0, `pnpm lint` exit 0
- **Committed in:** 5e39004 (part of task commit)

**2. [Rule 1 - Bug] Executing tests used the real pg-cursor via the default factory and hung**
- **Found during:** Task 2 (first `db.test.ts` run: 7 timeouts at 5000 ms each)
- **Issue:** Tests that reach execution never passed `cursorFactory`, so `runQuery` built a real `new Cursor(sql)`; `read()` on an unsubmitted cursor never settles instead of throwing.
- **Fix:** Added an `exec()` helper injecting `cursorFactory: () => f.cursor` at every executing call site; the production default factory now never runs in unit tests.
- **Files modified:** packages/mcp-server/test/db.test.ts
- **Verification:** `pnpm --filter @se373/mcp-server test` 43/43 green in ~300 ms
- **Committed in:** 5e39004 (part of task commit)

**3. [Rule 1 - Bug] PgClientAdapter typed its client as pg Client, which has no release()**
- **Found during:** Task 2 (`pnpm typecheck`: `TS2339: Property 'release' does not exist on type 'Client'`)
- **Issue:** `release()` exists on `PoolClient` (pool-attached), not the base `Client` type.
- **Fix:** Adapter holds `PoolClient`; `Pool.connect()` already returns that type.
- **Files modified:** packages/mcp-server/src/db.ts
- **Verification:** `pnpm typecheck` exit 0
- **Committed in:** 5e39004 (part of task commit)

---

**Total deviations:** 3 auto-fixed (1 blocking wiring fix, 2 bugs)
**Impact on plan:** All three required for the plan's own acceptance criteria (guard-first ordering, green suite, clean typecheck). No scope creep: no new npm packages, `pnpm-lock.yaml` touched only by the 3-line workspace-link entry, sibling 03-04 files untouched.

## Issues Encountered

None beyond the three auto-fixed deviations above; the malicious-free executor path passed on its second run after the cursor-factory fix, and the full workspace suite (150 passed / 1 skipped) confirms no regressions in sql-guard, contracts, access-policy, or agent packages.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for 03-04 (policy seam): the executor's `maskedColumns: []` and guard-then-execute order are exactly the seam Phase 4's `run_query` pipeline extends; no executor API changes needed.
- Live 57014/25006 proof stays deferred to Phase 2 per D-04: `db.live.test.ts` will unskip automatically once `DATABASE_URL` (agent_ro) exists; no test edits needed.
- No blockers. No DATABASE_URL needed for any gate in this plan.

## Self-Check: PASSED

- All 5 created files exist on disk (`errors.ts`, `db.ts`, `errors.test.ts`, `db.test.ts`, `db.live.test.ts`); all 3 task commits (`668b5b2`, `5e39004`, `fc7832f`) are ancestors of HEAD; no deletions in any commit; full suite 150 passed / 1 skipped; typecheck and lint exit 0.

---
*Phase: 03-sql-guard-read-only-executor*
*Completed: 2026-10-25*
