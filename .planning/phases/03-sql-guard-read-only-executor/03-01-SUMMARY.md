---
phase: 03-sql-guard-read-only-executor
plan: 1
subsystem: database
tags: [pgsql-parser, sql-guard, vitest, pnpm, zod, eslint-trust-boundary]
requires:
  - phase: 01-monorepo-contracts-freeze
    provides: workspace wiring idioms (tsconfig refs, vitest workspace, eslint ban, CODEOWNERS, contracts barrel)
provides:
  - Single-lockfile install of all Phase 3 dependencies (parser, driver, yaml, zod)
  - Additive SchemaCatalog contract type consumed by the guard
  - Production-quality pure @se373/sql-guard package (warmup + allowlist walk + catalog check)
  - ESLint pg/pg-cursor ban scope for sql-guard, CODEOWNERS line, architecture doc entries
  - Agent-side guard pre-flight test proving the D-01 dual-consumer layout
affects: [03-02-guard-matrix, 03-03-read-only-executor, 03-04-policy-seam, phase-4-mcp-server]
actuals:
  tokens: 6876
  tasks: 3
  commits: 2
  plan_head_before: c55e7857177f1fdaadd797ba5dd2c8aff4631ee1
  plan_head_after: 98a5f9bb0615fa8e761cc691ed0a8e64c803b565
tech-stack:
  added: [pgsql-parser@18.3.1, @pgsql/traverse@18.8.1, pg@8.23.1, pg-cursor@2.22.1, @types/pg@8.23.1, @types/pg-cursor@2.7.2, yaml@2.9.1, zod@4.6.7(access-policy)]
  patterns: [AST allowlist walk with ctx.abort, injected-catalog validator, exact-first/lowercase-fallback identifier lookup, per-package eslint trust-boundary scope]
key-files:
  created: [packages/sql-guard/src/guard.ts, packages/sql-guard/src/denylist.ts, packages/sql-guard/src/index.ts, packages/sql-guard/test/guard.test.ts, packages/contracts/src/catalog.ts, packages/contracts/test/catalog.test.ts, packages/agent/test/guard-preflight.test.ts]
  modified: [pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.json, vitest.workspace.ts, eslint.config.mjs, .github/CODEOWNERS, docs/architecture.md, packages/contracts/src/index.ts, packages/mcp-server/package.json, packages/access-policy/package.json, packages/agent/package.json]
key-decisions:
  - "Empty/whitespace SQL is INVALID_SQL at character 0 (parser throws position-less on empty input)"
  - "FROM aliases map to real tables so qualified refs (o.id) resolve; CTE names exempt from catalog lookup"
  - "No agent tsconfig project reference to sql-guard needed: typecheck resolves via workspace dist built by root tsc -b"
requirements-completed: [GUARD-01, GUARD-02, GUARD-03]
coverage:
  - id: D1
    description: "sqlGuard accepts one aliased SELECT and rejects DELETE with FORBIDDEN_STATEMENT"
    requirement: GUARD-01
    verification:
      - kind: unit
        ref: "packages/sql-guard/test/guard.test.ts#accepts one aliased SELECT / rejects DELETE"
        status: pass
    human_judgment: false
  - id: D2
    description: "Shared SchemaCatalog zod schema in contracts, consumed by the guard"
    requirement: GUARD-02
    verification:
      - kind: unit
        ref: "packages/contracts/test/catalog.test.ts#parses a valid catalog (5 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Package resolves through workspace wiring (root tsc -b, vitest, agent import)"
    requirement: GUARD-03
    verification:
      - kind: unit
        ref: "packages/agent/test/guard-preflight.test.ts#agent guard pre-flight (2 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "ESLint pg-import ban fires inside sql-guard while the clean tree lints green"
    requirement: GUARD-03
    verification:
      - kind: other
        ref: "probe __ban_probe__.ts exited 1 with no-restricted-imports; pnpm lint exit 0"
        status: pass
    human_judgment: false
duration: 4min
completed: 2026-10-25
status: complete
---

# Phase 3 Plan 1: Tracer Slice Summary

**Pure sqlGuard package with injected catalog, single-lockfile Phase 3 installs, and trust-boundary wiring — full workspace gate green**

## Performance

- **Duration:** 4 min
- **Started:** 2026-10-25T15:26:24Z
- **Completed:** 2026-10-25T15:30:39Z
- **Tasks:** 3
- **Files modified:** 21

## Accomplishments

- All Phase 3 dependencies installed in one lockfile commit (parser, traverse, pg, pg-cursor + types, yaml, zod) with the human-approved `@launchql/protobufjs` allowBuilds entry; later plans never touch pnpm-lock.yaml
- Additive `SchemaCatalogSchema` in `@se373/contracts` (5 new tests, zod-singleton invariant still green)
- Production-quality `@se373/sql-guard`: async-parse guard with single-statement check, SelectStmt-only root, full-tree abort on DML/utility tags / intoClause / lockingClause / denylisted FuncCall / system-schema or unknown RangeVar / unknown ColumnRef, exact-first + lowercase-fallback lookup
- Trust boundary enforced: new eslint scope bans pg/pg-cursor in sql-guard (probe fired exit 1, probe removed), CODEOWNERS line, architecture doc §2/§3/§8 entries
- Agent pre-flight test imports `@se373/sql-guard` by workspace specifier, proving the D-01 dual-consumer layout without touching the DB-import ban
- Full gate green: pnpm install + typecheck + lint + test (12 files, 30 tests), no DATABASE_URL needed

## Package approval (recorded)

The orchestrator presented this plan's installs and the human replied **APPROVED** (no holds): pgsql-parser ^18.3.1, @pgsql/traverse ^18.8.1, pg ^8.23.1, pg-cursor ^2.22.1, @types/pg ^8.23.1, @types/pg-cursor ^2.7.2, yaml ^2.9.1, zod ^4.6.7 (already in workspace), plus the `allowBuilds` approval for `@launchql/protobufjs` (postinstall reviewed: version-scheme warning only). Installed exactly these specifiers; no other new packages were added.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end guard slice** - `e278ef1` (feat)
2. **Task 2: Trust-boundary wiring** - `98a5f9b` (feat)
3. **Task 3: Tracer gate** - verification-only, no file changes (probe created, fired, deleted; full gate re-run green)

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified

- `packages/sql-guard/src/guard.ts` - sqlGuard + warmupSqlGuard (allowlist walk + catalog check)
- `packages/sql-guard/src/denylist.ts` - frozen FORBIDDEN_FUNCTIONS + SYSTEM_SCHEMAS sets
- `packages/sql-guard/src/index.ts` - barrel re-exports
- `packages/sql-guard/test/guard.test.ts` - smoke set (accept + DELETE + stacked + empty INVALID_SQL)
- `packages/sql-guard/{package.json,tsconfig.json,vitest.config.ts}` - package skeleton (pure: no pg/yaml)
- `packages/contracts/src/catalog.ts` - SchemaCatalogSchema + SchemaCatalog type
- `packages/contracts/test/catalog.test.ts` - accept/reject schema tests
- `packages/agent/test/guard-preflight.test.ts` - dual-consumer pre-flight proof
- `pnpm-workspace.yaml` / `pnpm-lock.yaml` - all Phase 3 deps + protobufjs build approval
- `tsconfig.json` / `vitest.workspace.ts` - sql-guard references
- `eslint.config.mjs` - sql-guard pg/pg-cursor ban scope (agent/apps block untouched)
- `.github/CODEOWNERS` - sql-guard UC-09 owner line
- `docs/architecture.md` - §2 row, §3 arrows, §8 UC-09 row
- `packages/{mcp-server,access-policy,agent}/package.json` - Phase 3 dep specifiers

## Decisions Made

- Empty/whitespace-only SQL returns `INVALID_SQL` at character 0 via an explicit early check, because `parse("")` throws a position-less `Query cannot be empty` error with no `sqlDetails` — the plan's smoke case requires a numeric cursor position.
- `FROM` aliases (`orders o`) are mapped alias → real table during the walk so qualified refs (`o.id`) resolve; without this the smoke accept case falsely rejected with UNKNOWN_TABLE. CTE names are collected in the same pass and exempt from catalog lookup (needed for the `WITH regional AS ...` valid case in 03-02).
- No `packages/agent/tsconfig.json` project reference to sql-guard was added: root `tsc -b` builds the sql-guard reference and the agent test resolves `@se373/sql-guard` through workspace dist, so typecheck is green with the diff exactly as planned.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Empty-string parse carries no cursor position**
- **Found during:** Task 1 (sql-guard smoke test)
- **Issue:** `parse("")` throws `Error: Query cannot be empty` with no `sqlDetails`, so the `INVALID_SQL` message had no numeric position and the smoke assertion failed.
- **Fix:** Explicit early return for empty/whitespace input: `INVALID_SQL` "at character 0" in `guard.ts`.
- **Files modified:** packages/sql-guard/src/guard.ts
- **Verification:** `pnpm --filter @se373/sql-guard test` 4/4 pass
- **Committed in:** e278ef1 (part of task commit)

**2. [Rule 1 - Bug] FROM aliases broke qualified column resolution**
- **Found during:** Task 1 (sql-guard smoke test)
- **Issue:** `SELECT o.id ... FROM orders o` was rejected UNKNOWN_TABLE because only bare relnames were mapped; qualifiers use the alias. Same edit also hoisted the `aliasToTable` declaration above the walk (TDZ ReferenceError otherwise).
- **Fix:** RangeVar visitor records `alias.aliasname` → relname; declaration moved before `walk()`.
- **Files modified:** packages/sql-guard/src/guard.ts
- **Verification:** `pnpm --filter @se373/sql-guard test` 4/4 pass
- **Committed in:** e278ef1 (part of task commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs)
**Impact on plan:** Both fixes required for the plan's own smoke acceptance criteria. No scope creep; remaining work (38-case matrix) stays in 03-02.

## Issues Encountered

None beyond the two auto-fixed bugs above; installs, typecheck, lint, and tests were green on first full run after the fixes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for 03-02 (guard matrix expansion: 38-case suite, fixtures module, full catalog).
- Ready for 03-03 (executor) and 03-04 (policy seam): all their dependencies are already in the lockfile; those plans must not touch pnpm-lock.yaml.
- No blockers. No DATABASE_URL needed for any gate in this plan.

## Self-Check: PASSED

- All 10 key created files exist on disk; both task commits are ancestors of HEAD; no deletions in either commit; probe file confirmed removed (`packages/sql-guard/src/` holds only denylist.ts, guard.ts, index.ts).

---
*Phase: 03-sql-guard-read-only-executor*
*Completed: 2026-10-25*
