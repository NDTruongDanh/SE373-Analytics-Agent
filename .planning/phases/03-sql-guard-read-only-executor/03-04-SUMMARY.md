---
phase: 03-sql-guard-read-only-executor
plan: 4
subsystem: database
tags: [access-policy, zod, yaml, fail-fast, vitest, node-types]
requires:
  - phase: 03-01
    provides: Phase 3 dependency installs (yaml, zod) plus workspace wiring idioms
provides:
  - AccessPolicy interface plus fail-closed pass-through ColumnScopePolicy stub
  - Strict zod sensitive-columns loader (pure + file wrapper) and validated policies/sensitive_columns.yaml
  - Green full-workspace gate (install + typecheck + lint + test) with regenerated interface docs
affects: [phase-4-mcp-server, UC-09-milestone]
actuals:
  tokens: 4044
  tasks: 3
  commits: 2
  plan_head_before: 867db267b18e35a9ff0842cddb089063b405562c
  plan_head_after: d5b75c57af8a1000961e83f928a97ed1ca9539fb
tech-stack:
  added: [@types/node@^24.19.2 (dev, access-policy only)]
  patterns: [strict zod config schema with fail-fast constructor, pure-parser plus fs-wrapper split for testability, pass-through stub seam for future enforcement]
key-files:
  created:
    - packages/access-policy/src/policy.ts
    - packages/access-policy/src/sensitive-columns.ts
    - packages/access-policy/test/policy.test.ts
    - packages/access-policy/test/sensitive-columns.test.ts
    - policies/sensitive_columns.yaml
  modified:
    - packages/access-policy/src/index.ts
    - packages/access-policy/package.json
    - packages/access-policy/tsconfig.json
    - pnpm-lock.yaml
key-decisions:
  - "ColumnScopePolicy constructor re-validates defensively (structural check, no loader dependency) so an invalid config can never build a runnable policy"
  - "loadSensitiveColumnsFile resolves explicit path, else SENSITIVE_COLUMNS_PATH, else the module-relative default so dist and src layouts both work"
  - "@types/node@^24 (not ^26) as a devDependency of @se373/access-policy only, plus types node in that package tsconfig — human-approved TS2591 fix"
requirements-completed: [GUARD-06]
coverage:
  - id: D1
    description: "AccessPolicy interface plus pass-through ColumnScopePolicy stub that constructs from valid config, throws on invalid config, and claims no enforcement"
    requirement: GUARD-06
    verification:
      - kind: unit
        ref: "packages/access-policy/test/policy.test.ts#construct/throw/pass-through (12 tests total in package)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Sensitive-columns loader plus policies/sensitive_columns.yaml holding the four UC-09 columns, valid YAML loads, invalid shapes throw"
    requirement: GUARD-06
    verification:
      - kind: unit
        ref: "packages/access-policy/test/sensitive-columns.test.ts#valid fixture, missing version, wrong literal, empty table, strictness, malformed YAML, file loading"
        status: pass
      - kind: other
        ref: "test $(grep -c 'column' policies/sensitive_columns.yaml) -ge 4 → 6"
        status: pass
    human_judgment: false
  - id: D3
    description: "Full workspace gate green with docs regenerated and no drift"
    requirement: GUARD-06
    verification:
      - kind: other
        ref: "pnpm install + typecheck + lint + test → 161 passed, 1 skipped (live test skips without DATABASE_URL)"
        status: pass
      - kind: other
        ref: "pnpm docs:interface → docs/mcp_interface.md exists, git status clean of docs drift"
        status: pass
    human_judgment: false
duration: 12min
completed: 2026-10-25
status: complete
---

# Phase 3 Plan 4: AccessPolicy Seam Summary

**AccessPolicy interface plus fail-closed ColumnScopePolicy stub, strict zod sensitive-columns loader, and the four-column YAML config — full workspace gate green at 161 passed with docs regenerated**

## Performance

- **Duration:** 12 min
- **Started:** 2026-10-25T15:47:00Z
- **Completed:** 2026-10-25T15:58:55Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- `AccessPolicy` interface plus `ColumnScopePolicy` pass-through stub: constructor validates the config structurally and throws fail-fast, `apply()` always allows with `maskedColumns: []` and is explicitly documented as non-enforcing with full masking deferred to UC09-01
- Pure `loadSensitiveColumns` (YAML text in, validated config out) plus `loadSensitiveColumnsFile` IO wrapper (explicit path beats `SENSITIVE_COLUMNS_PATH` beats module-relative default), governed by a strict zod schema (`version: literal(1)`, non-empty table/column entries, no extra keys)
- `policies/sensitive_columns.yaml` with `version: 1` and exactly the four UC-09 entries (`customers.phone/email/address`, `employees.salary`); every invalid shape (missing version, wrong literal, empty names, extra keys, malformed YAML) throws
- Final phase gate green with no `DATABASE_URL`: install + typecheck + lint + `pnpm test` (16 files passed, 1 skipped — the gated live test), `pnpm docs:interface` regenerates cleanly with zero docs drift

## Task Commits

Each task was committed atomically:

1. **Task 1: AccessPolicy interface plus pass-through ColumnScopePolicy stub** - `709b70f` (feat)
2. **Task 2: Sensitive-columns loader plus YAML config** - `d5b75c5` (feat)
3. **Task 3: Phase gate — full workspace green with docs regression check** - verification-only, no file changes (gate re-ran green, docs regen produced no diff)

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified

- `packages/access-policy/src/policy.ts` - `AccessPolicy`/`PolicyInput`/`PolicyAllow`/`ColumnScopeConfig` types plus `ColumnScopePolicy` stub (fail-fast constructor, pass-through `apply()`)
- `packages/access-policy/src/sensitive-columns.ts` - `SensitiveColumnsSchema`, `loadSensitiveColumns`, `loadSensitiveColumnsFile`, `DEFAULT_SENSITIVE_COLUMNS_PATH`
- `packages/access-policy/test/policy.test.ts` - construct/throw/pass-through stub-behavior evidence
- `packages/access-policy/test/sensitive-columns.test.ts` - valid fixture, all five rejection shapes, malformed YAML, default-path and env-override file loading
- `policies/sensitive_columns.yaml` - version 1 plus the four UC-09 sensitive columns
- `packages/access-policy/src/index.ts` - barrel re-exports for `policy.js` and `sensitive-columns.js` (shell exports kept intact)
- `packages/access-policy/package.json` - `@types/node@^24` devDependency (human-approved, Rule 3)
- `packages/access-policy/tsconfig.json` - `"types": ["node"]` so the installed types are picked up (human-anticipated follow-up)
- `pnpm-lock.yaml` - `@types/node` (with its `undici-types` dep) resolution entries only

## Decisions Made

- The stub constructor re-validates the config structurally instead of importing the zod schema, keeping `policy.ts` dependency-free (no loader, no fs, no zod) so the seam stays a pure type plus a guard clause UC-09 can extend without touching the future server pipeline.
- The file wrapper's precedence is explicit-path > `SENSITIVE_COLUMNS_PATH` env > module-relative default resolved from `import.meta.url`, so tests, relocated deployments, and both `src`/`dist` layouts resolve the repo `policies/` file without the guard path ever reading disk.
- `@types/node@^24` (not ^26) scoped as a devDependency of `@se373/access-policy` only, matching the Node 24 runtime; types-only, no install script. No other package gains node types.

## Known Stubs

- `ColumnScopePolicy.apply()` (`packages/access-policy/src/policy.ts`) is an intentional pass-through stub: always `{ allowed: true, maskedColumns: [] }`, `enforcesMasking: false`. Full masking with `resolveColumns` plus AST rewrite/deparse is UC09-01 scope (UC-09 milestone), which consumes this seam without changing the server call site. Not a defect — the plan's must-have truth is "the stub never claims enforcement".

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] pnpm typecheck failed with TS2591 (no Node types)**
- **Found during:** Task 2 (first `pnpm typecheck` after the loader landed: `Cannot find name 'node:fs' / 'node:url' / 'process'`)
- **Issue:** This is the first package in the repo to import `node:` builtins, and no package carried `@types/node`; the pre-existing lockfile had no node-types entry. The plan's "no new specifiers" note (threat T-3-SC) assumed no install would be needed.
- **Fix:** Human-approved at the checkpoint: `pnpm --filter @se373/access-policy add -D @types/node@^24` (types-only, no install script). The install alone did not clear the error under this repo's pnpm-strict layout with TS 6.0.3, so the human-anticipated follow-up was applied: `"types": ["node"]` in `packages/access-policy/tsconfig.json` only.
- **Files modified:** packages/access-policy/package.json, packages/access-policy/tsconfig.json, pnpm-lock.yaml
- **Verification:** `pnpm typecheck` exit 0, `pnpm lint` exit 0, `pnpm --filter @se373/access-policy test` 12/12 pass
- **Committed in:** d5b75c5 (part of task commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 blocking, human-approved package addition overriding the plan's "no new specifiers" note)
**Impact on plan:** Required for the plan's own typecheck acceptance; `@types/node` is the official DefinitelyTyped node declaration package (not a functional dependency), scoped to one package's devDependencies. No scope creep; remaining work (UC09-01 masking) is out of Phase 3 by CONTEXT design.

## Issues Encountered

None beyond the single TS2591 deviation above; the package suite (12/12) and the full workspace suite (161 passed / 1 skipped) were green on first run after the types fix, and docs regeneration produced zero drift.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 is complete: guard (03-01/03-02), read-only executor (03-03), and policy seam (03-04) are all committed green; Phase 4 can build the `run_query` pipeline (guard → policy → executor) against these exact seams.
- UC09-01 (UC-09 milestone) owns full masking enforcement via this stub's `AccessPolicy` interface; no server call-site change needed.
- No blockers. No `DATABASE_URL` needed for any gate in this plan; the live executor test unskips automatically once Phase 2 provides it.

## Self-Check: PASSED

- All 5 created files exist on disk (`policy.ts`, `sensitive-columns.ts`, both test files, `sensitive_columns.yaml`); both task commits (`709b70f`, `d5b75c5`) are ancestors of HEAD; no deletions in either commit; package suite 12/12 green; workspace suite 161 passed / 1 skipped; typecheck and lint exit 0.

---
*Phase: 03-sql-guard-read-only-executor*
*Completed: 2026-10-25*
