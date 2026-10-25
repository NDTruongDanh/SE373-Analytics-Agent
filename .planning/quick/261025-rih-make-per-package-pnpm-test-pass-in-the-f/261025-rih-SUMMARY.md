---
phase: 01-monorepo-contracts-freeze
plan: quick-261025-rih
subsystem: testing
tags: [vitest, monorepo, pnpm, shell-tests]

# Dependency graph
requires:
  - phase: 01-monorepo-contracts-freeze
    provides: [six-package solution build, agent shell-test pattern, vitest workspace with two projects]
provides:
  - Per-package `pnpm test` green in all six @se373 packages (19 tests total)
  - vitest workspace covering all six test-bearing projects
affects: [phase-2-db-tools, phase-3-access-policy, ci-verification]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 610
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: ["marker shell test per package (mirror of packages/agent/test/shell.test.ts)"]

key-files:
  created:
    - packages/mcp-server/test/shell.test.ts
    - packages/access-policy/test/shell.test.ts
    - apps/api/test/shell.test.ts
    - apps/web/test/shell.test.ts
  modified:
    - vitest.workspace.ts

key-decisions:
  - "Marker tests over --passWithNoTests: a deleted test file fails loudly instead of passing silently"

patterns-established:
  - "Shell marker test: import the package's *_SHELL const from ../src/index.js, assert typeof string and length > 0"

requirements-completed: [REPO-03]

# Coverage metadata (#1602)
coverage:
  - id: D1
    description: "Four marker shell tests, one per empty shell package"
    requirement: "REPO-03"
    verification:
      - kind: unit
        ref: "pnpm --filter @se373/mcp-server test / access-policy / api / web (1 passed each)"
        status: pass
    human_judgment: false
  - id: D2
    description: "vitest.workspace.ts lists all six test-bearing projects; root suite runs 19 tests"
    requirement: "REPO-03"
    verification:
      - kind: unit
        ref: "pnpm test (9 files, 19 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "No existing gate regressed: typecheck, lint, contracts/agent suites green, contracts+agent untouched"
    requirement: "REPO-03"
    verification:
      - kind: unit
        ref: "pnpm typecheck && pnpm lint && pnpm --filter @se373/contracts test (14 passed) && pnpm --filter @se373/agent test (1 passed)"
        status: pass
    human_judgment: false

# Metrics
plan_head_before: 4361385b4e8743034e9129e84c7796b713cdc153
plan_head_after: 28f77a83b4aaae77f7d186a1240827f919db2376
duration: ~10min
completed: 2026-10-25
status: complete
---

# Quick 261025-rih: Per-package `pnpm test` green in the four shell packages Summary

**Four marker shell tests close the Phase 1 verification gap: `pnpm test` now exits 0 in all six packages and at root (19/19), with typecheck and lint still green.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-10-25T12:42:00Z
- **Completed:** 2026-10-25T12:51:51Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Created one marker `shell.test.ts` per empty shell package (mcp-server, access-policy, api, web), each asserting its `*_SHELL` const is a non-empty string — line-for-line adaptation of the agent shell-test pattern
- Extended `vitest.workspace.ts` from 2 to all 6 test-bearing projects
- Root suite now runs 9 files / 19 tests, all passing (15 pre-existing + 4 new)
- All six per-package `pnpm test` runs exit 0; root `pnpm typecheck` and `pnpm lint` exit 0

## Task Commits

Each task was committed atomically:

1. **Task 1: Add marker shell tests and register shells in the vitest workspace** - `20f1561` (test)
2. **Task 2: Re-run the full Phase 1 gate** - `28f77a8` (test, --allow-empty: verification-only, no file changes)

**Plan metadata:** `docs(quick-261025-rih)` commit includes PLAN.md + this SUMMARY.md

## Files Created/Modified

- `packages/mcp-server/test/shell.test.ts` - Asserts `MCP_SERVER_SHELL` is a non-empty string
- `packages/access-policy/test/shell.test.ts` - Asserts `ACCESS_POLICY_SHELL` is a non-empty string
- `apps/api/test/shell.test.ts` - Asserts `API_SHELL` is a non-empty string
- `apps/web/test/shell.test.ts` - Asserts `WEB_SHELL` is a non-empty string
- `vitest.workspace.ts` - Workspace project list extended to all six packages

## Decisions Made

- Marker tests over `--passWithNoTests` (per plan rationale): a future accidental deletion of every test file in a shell fails loudly instead of passing silently, and the pattern matches the established agent shell-test convention.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 1 truth 1 per-package leg is now satisfied on all six packages; REPO-03 ready for verifier re-run (moves PARTIAL → SATISFIED, closing the code gap — the live-CI human item in 01-VERIFICATION.md is unaffected).
- No contracts/agent behavior changed: both trees byte-identical to HEAD (`git diff HEAD -- packages/contracts packages/agent` empty).

---
*Phase: 01-monorepo-contracts-freeze (quick-261025-rih)*
*Completed: 2026-10-25*

## Self-Check: PASSED

- [x] `packages/mcp-server/test/shell.test.ts` FOUND
- [x] `packages/access-policy/test/shell.test.ts` FOUND
- [x] `apps/api/test/shell.test.ts` FOUND
- [x] `apps/web/test/shell.test.ts` FOUND
- [x] `vitest.workspace.ts` lists all six projects (verified by 19-test root run)
- [x] `20f1561` ancestor of HEAD
- [x] `28f77a8` ancestor of HEAD (= HEAD)
