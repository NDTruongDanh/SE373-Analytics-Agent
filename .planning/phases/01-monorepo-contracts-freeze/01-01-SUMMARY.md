---
phase: 01-monorepo-contracts-freeze
plan: 01
subsystem: infra
tags: [pnpm, typescript, zod, eslint, vitest, monorepo, contracts]

# Dependency graph
requires: []
provides:
  - "Working pnpm workspace with strict TS project references (tsc -b)"
  - "@se373/contracts with frozen 11 error codes + DbToolError"
  - "@se373/agent shell importing DbToolError via workspace:*"
  - "ESLint flat config with DB-import ban for agent/apps"
affects: ["all later phases import @se373/contracts and run under this toolchain"]

# Actuals (#2632) — same estimateTokens scale (chars/4 over realized diff)
actuals:
  tokens: 23141
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: ["typescript@~6.0.3", "eslint@^10.13.0", "typescript-eslint@^8.72.0", "vitest@^5.0.5", "tsx@^4.23.15", "zod@^4.6.7"]
  patterns: ["pnpm workspaces + TS project references (tsc -b solution file)", "ESLint flat config with no-restricted-imports trust boundary", "zod schema as single source of truth in packages/contracts"]

key-files:
  created: ["tsconfig.base.json", "tsconfig.json", "eslint.config.mjs", "vitest.workspace.ts", "packages/contracts/package.json", "packages/contracts/tsconfig.json", "packages/contracts/vitest.config.ts", "packages/contracts/src/errors.ts", "packages/contracts/src/index.ts", "packages/contracts/test/errors.test.ts", "packages/agent/package.json", "packages/agent/tsconfig.json", "packages/agent/src/index.ts", "packages/agent/test/shell.test.ts"]
  modified: ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".gitignore"]

key-decisions:
  - "Task 1 recorded as human-APPROVED (all six specifiers, no holds); no install ran before approval"
  - "Approved esbuild postinstall via allowBuilds (pnpm v11 fails install on unapproved build scripts); esbuild is a transitive dep of approved vitest, not a new package"
  - "Composite tsconfigs include src only (rootDir src + test dir = TS6059); tests run under vitest"

patterns-established:
  - "Cross-package imports use workspace:* pinned to @se373/* scope"
  - "Trust boundaries enforced by ESLint no-restricted-imports, proven by a temporary probe file"

requirements-completed: [REPO-02, REPO-03, REPO-05, CONT-02]

# Coverage (#1602) — every deliverable proven by passing automated verification
coverage:
  - id: D1
    description: "Root workspace installs, typechecks (tsc -b), lints (eslint .), and tests (vitest run) green on Node 24"
    requirement: "REPO-02"
    verification:
      - kind: other
        ref: "pnpm install && pnpm typecheck && pnpm lint && pnpm test (all exit 0)"
        status: pass
    human_judgment: false
  - id: D2
    description: "@se373/contracts exports 11 frozen error codes, DbToolErrorSchema, RETRYABLE_CODES, dbToolError, CONTRACTS_VERSION"
    requirement: "CONT-02"
    verification:
      - kind: unit
        ref: "packages/contracts/test/errors.test.ts (4 tests pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "@se373/agent shell imports DbToolError type from @se373/contracts via workspace:*"
    requirement: "REPO-03"
    verification:
      - kind: unit
        ref: "packages/agent/test/shell.test.ts (1 test passes)"
        status: pass
    human_judgment: false
  - id: D4
    description: "ESLint DB-import ban fires on pg import in packages/agent; clean tree lints green"
    requirement: "REPO-05"
    verification:
      - kind: other
        ref: "pnpm lint (exit 0) + __ban_probe__.ts probe (exit 1, no-restricted-imports)"
        status: pass
    human_judgment: false

# Metrics
duration: 4min
completed: 2026-10-25
status: complete
plan_head_before: 0b986ff2c16e6b260627bf75526949584b3163aa
plan_head_after: df211b80d51119c599fc08f005697831f81970a5
---

# Phase 1 Plan 1: Monorepo Contracts Freeze Tracer Summary

**pnpm workspace with strict TS project references, frozen 11-code DbToolError in @se373/contracts, agent shell linked via workspace:*, and a lint-enforced DB-import ban — install, typecheck, lint, and test all green.**

## Performance

- **Duration:** 4 min
- **Started:** 2026-10-25T12:21:14Z
- **Completed:** 2026-10-25T12:24:44Z
- **Tasks:** 3 (1 recorded human approval + 2 executed)
- **Files modified:** 18

## Accomplishments

- Root pnpm workspace (`apps/*`, `packages/*`) with strict `tsconfig.base.json`, `tsc -b` solution file, and vitest workspace — `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0 on Node 24
- `@se373/contracts` 0.1.0 with the frozen 11 error codes (UC-09 A.7 E1–E9 + E11, truncation as flag, RATE_LIMITED reserved), `DbToolErrorSchema`, `RETRYABLE_CODES`, `dbToolError` factory, `CONTRACTS_VERSION`
- `@se373/agent` 0.1.0 shell importing `DbToolError` type via `workspace:*`, proving cross-package linkage at typecheck and runtime
- ESLint flat config (typescript-eslint recommended + `no-restricted-imports`) banning `pg`, `pg-cursor`, and mcp-server internals from `packages/agent`/`apps/*` — probe proves the ban fires, clean tree is green
- Exactly one zod copy (`zod@4.6.7`) in the lockfile; all five `wiki:*` scripts and `mermaid`/`jsdom`/`openwiki` devDeps preserved verbatim

## Task Commits

Each task was committed atomically:

1. **Task 1: Approve npm package legitimacy** — recorded as human-APPROVED (orchestrator verified all six specifiers on npm 2026-10-25; no holds). No commit needed (no files touched).
2. **Task 2: End-to-end workspace + contracts-errors + agent-shell slice** - `a490973` (feat)
3. **Task 3: ESLint flat config with the DB-import ban** - `df211b8` (feat)

**Plan metadata:** committed separately below (docs: complete plan).

## Files Created/Modified

- `package.json` - Added typecheck/lint/test/docs:interface scripts + 5 pinned devDeps; wiki:* scripts and openwiki/mermaid/jsdom untouched
- `pnpm-workspace.yaml` - Added `apps/*` + `packages/*` globs; kept `allowBuilds` (better-sqlite3 + esbuild deviation)
- `.gitignore` - Appended `dist/` and `*.tsbuildinfo`
- `tsconfig.base.json` - Strict, ES2022, nodenext, declaration family, isolatedModules
- `tsconfig.json` - Solution file (`files: []` + references to both packages)
- `vitest.workspace.ts` - Default-exports both package projects
- `eslint.config.mjs` - Flat config: recommended + scoped DB-import ban
- `packages/contracts/*` - Package manifest (zod-only dep), composite tsconfig, vitest config, errors module, entry, 4 tests
- `packages/agent/*` - Package manifest (workspace:* contracts dep only), composite tsconfig with contracts reference, shell entry, 1 test
- `pnpm-lock.yaml` - Committed updated lockfile (single zod@4.6.7)

## Decisions Made

- Task 1 approval recorded, not re-asked: human replied APPROVED to all six specifiers (typescript ~6.0.3, eslint ^10.13.0, typescript-eslint ^8.72.0, vitest ^5.0.5, tsx ^4.23.15, zod ^4.6.7), verified on npm 2026-10-25, none deprecated, weekly downloads 59M–222M
- `allowBuilds: esbuild: true` added (deviation, see below) — pnpm v11 turns unapproved build scripts into a hard install failure
- Composite tsconfigs include `src` only (deviation, see below) — `rootDir: src` + `test` dir is a TS6059 hard error, which would have broken `pnpm typecheck` exactly as the tracer is meant to catch

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Approved esbuild postinstall script via allowBuilds**
- **Found during:** Task 2 (first `pnpm install`)
- **Issue:** pnpm v11 exits 1 on install when any dependency has an unapproved build script (`ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.28.2` postinstall `node install.js`), which also breaks every `pnpm run` via the pre-script deps check
- **Fix:** Added `esbuild: true` under `allowBuilds` in `pnpm-workspace.yaml`. esbuild is the legitimate evanw/esbuild package arriving transitively via the approved `vitest@^5.0.5`; no new package specifier added, `better-sqlite3: true` kept
- **Files modified:** pnpm-workspace.yaml
- **Verification:** `pnpm install` exits 0; postinstall `node install.js` runs Done
- **Committed in:** a490973 (Task 2 commit)

**2. [Rule 1 - Bug] Composite tsconfigs include src only instead of src + test**
- **Found during:** Task 2 (`pnpm typecheck`)
- **Issue:** Plan-specified `rootDir: src` + `include: ["src", "test"]` is a TS6059 hard error ("... is not under 'rootDir'") in both packages — `tsc -b` cannot build that combination
- **Fix:** Changed `include` to `["src"]` in both package tsconfigs. `rootDir: src` + `outDir: dist` and the `dist/index.js` exports map are preserved; tests still execute under vitest (esbuild transpile)
- **Files modified:** packages/contracts/tsconfig.json, packages/agent/tsconfig.json
- **Verification:** `pnpm typecheck` exits 0 with zero `error TS` output; both filter suites pass
- **Committed in:** a490973 (Task 2 commit)

**3. [Rule 1 - Bug] Removed stale tsc emit artifacts from test dirs**
- **Found during:** Task 2 (agent suite ran 2 files instead of 1)
- **Issue:** The first failing `tsc -b` run had already emitted `.js`/`.d.ts`/`.map` files into `packages/*/test/`; vitest picked up the duplicate `shell.test.js`
- **Fix:** Deleted the 8 stray emit files; restored single-file suites
- **Files modified:** (deleted) packages/agent/test/shell.test.{js,js.map,d.ts,d.ts.map}, packages/contracts/test/errors.test.{js,js.map,d.ts,d.ts.map}
- **Verification:** `find` shows no `.js`/`.d.ts`/`.map` outside `dist/`; suites report 4 + 1 tests
- **Committed in:** N/A (files deleted before the Task 2 commit; clean tree committed)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs)
**Impact on plan:** All auto-fixes required for correctness — without them `pnpm install` / `pnpm typecheck` / `pnpm test` cannot go green. No scope creep; no new dependencies; exports layout and ban behavior match the plan exactly.

## Issues Encountered

None beyond the deviations above — each surfaced on first run and was fixed inline with passing verification.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Workspace toolchain proven end-to-end; Phase 1 plan 01-02 can land the full contract surface (`tools.ts`, `answer.ts`, `trace.ts`, `semantic.ts`, `benchmark.ts`), `docs:interface` generator script, and CI on this foundation
- Watch item for 01-02: the `include: ["src"]` deviation means package tests are vitest-only (not tsc-checked); if 01-02 wants test typechecking, add a dedicated non-composite test tsconfig rather than touching the build configs
- `docs:interface` script is declared in root `package.json` but not implemented (planned for 01-02) — do not run it yet

---

*Phase: 01-monorepo-contracts-freeze*
*Completed: 2026-10-25*

## Self-Check: PASSED
