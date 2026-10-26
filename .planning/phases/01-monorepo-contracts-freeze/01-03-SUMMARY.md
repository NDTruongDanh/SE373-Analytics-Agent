---
phase: 01-monorepo-contracts-freeze
plan: 03
subsystem: infra
tags: [pnpm, typescript, project-references, codeowners, ci, gitleaks, eslint]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Root workspace configs, solution-file pattern, agent-shell pattern, ESLint DB-import ban"
provides:
  - "Four buildable shells (mcp-server, access-policy, apps/api, apps/web) wired into tsc -b"
  - "Per-path CODEOWNERS routing with UC-owner TODO placeholders"
  - "ci.yml PR pipeline: typecheck + lint + test + gitleaks v3"
affects: ["all later phases build packages in place without renaming paths", "phase 2+ CI enforcement"]

# Actuals (#2632) — same estimateTokens scale (chars/4 over realized diff)
actuals:
  tokens: 2366
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns: ["apps/* + packages/* shells share one composite-tsconfig shape (outDir dist, rootDir src, include src only, contracts reference)", "CI jobs mirror the OpenWiki setup pattern (pnpm 11.25.0, Node 24, pnpm cache, frozen lockfile)"]

key-files:
  created: ["packages/mcp-server/package.json", "packages/mcp-server/tsconfig.json", "packages/mcp-server/src/index.ts", "packages/access-policy/package.json", "packages/access-policy/tsconfig.json", "packages/access-policy/src/index.ts", "apps/api/package.json", "apps/api/tsconfig.json", "apps/api/src/index.ts", "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/src/index.ts", ".github/workflows/ci.yml"]
  modified: ["tsconfig.json", ".github/CODEOWNERS", "pnpm-lock.yaml"]

key-decisions:
  - "Tracer gate auto-continued: end-of-phase mode with automated-only verify re-ran green (pnpm install && pnpm typecheck), logged expansion, no checkpoint"
  - "api/web shells created under apps/ (not packages/): UC-09 section 0.3, PROJECT.md, must-have truths, acceptance criteria, Task 3 probe path, CODEOWNERS paths, and the eslint ban all require apps/api + apps/web; the plan's files list was inconsistent"
  - "ci.yml uses floating v4 action tags per the plan text (not SHA pins); OpenWiki workflow untouched"

patterns-established:
  - "Shell entry exports a <NAME>_SHELL marker naming its implementing phase plus a DbToolError-aliased type"

requirements-completed: [REPO-02, REPO-04, REPO-05, REPO-06]

# Coverage (#1602) — every deliverable proven by passing automated verification
coverage:
  - id: D1
    description: "mcp-server, access-policy, api, web shells build inside tsc -b and resolve the contracts import; dist output exists for all four"
    requirement: "REPO-02"
    verification:
      - kind: other
        ref: "pnpm install && pnpm typecheck (exit 0) + dist/index.js present in all four shells"
        status: pass
    human_judgment: false
  - id: D2
    description: "DB-import ban fires from an apps path (pg-cursor probe in apps/api) with no-restricted-imports; clean tree lints green"
    requirement: "REPO-05"
    verification:
      - kind: other
        ref: "pnpm lint (exit 0) + __ban_probe__.ts probe (exit 1, no-restricted-imports), probe deleted after"
        status: pass
    human_judgment: false
  - id: D3
    description: ".github/workflows/ci.yml runs typecheck + lint + test + gitleaks v3 on pull_request and push to main with Node 24, pnpm 11.25.0, frozen lockfile"
    requirement: "REPO-04"
    verification:
      - kind: other
        ref: "pnpm test (15 tests pass) + grep pins: gitleaks/gitleaks-action@v3, node-version 24, pnpm test, typecheck, lint"
        status: pass
    human_judgment: false
  - id: D4
    description: "CODEOWNERS keeps the global star rule and routes packages/contracts, packages/mcp-server, packages/access-policy, packages/agent, apps/api, apps/web, policies/ with UC-owner TODO placeholders"
    requirement: "REPO-06"
    verification:
      - kind: other
        ref: "7 greps (six paths + TODO(UC-) marker) all match"
        status: pass
    human_judgment: false

# Metrics
duration: 2min
completed: 2026-10-25
status: complete
commits: 4
plan_head_before: 7fd6383246a0e5a2a231b8711f71cd6b0c282a35
plan_head_after: 2fce461a378291c5efd55a0db190421c9b4fc186
---

# Phase 1 Plan 3: Shells, CODEOWNERS, CI Summary

**Four buildable shells (mcp-server, access-policy, apps/api, apps/web) in the solution build, per-path CODEOWNERS with UC-owner TODOs, and a ci.yml pipeline (typecheck + lint + test + gitleaks v3) — full root gate green and the DB-import ban proven from apps/api.**

## Performance

- **Duration:** 2 min
- **Started:** 2026-10-25T12:32:14Z
- **Completed:** 2026-10-25T12:33:37Z
- **Tasks:** 3
- **Files modified:** 16

## Accomplishments

- `packages/mcp-server` 0.1.0 shell (`MCP_SERVER_SHELL`, Phase 4) wired into the `tsc -b` solution with a `workspace:*` contracts link — tracer slice proven end-to-end
- `packages/access-policy` (`ACCESS_POLICY_SHELL`, Phase 3 seam), `apps/api` (`API_SHELL`, Phase 7 SSE), `apps/web` (`WEB_SHELL`, Phase 7 UI) shells in the UC-09 section 0.3 layout, all typechecking with `dist/` emit
- `.github/CODEOWNERS` keeps the global `*` rule and adds seven per-path lines (contracts, mcp-server, access-policy, agent, apps/api, apps/web, policies/) defaulting to @NDTruongDanh + @HungPham-VNU with UC-09 paths listing HungPham-VNU first and every line carrying a `TODO(UC-xx owner)` placeholder
- `.github/workflows/ci.yml` triggers on `pull_request` and `push` to main with four jobs (typecheck, lint, test, secrets) mirroring the OpenWiki setup pattern; `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (15 tests) all exit 0
- Ban proven from an apps path: temporary `pg-cursor` probe in `apps/api/src` fails eslint with `no-restricted-imports`, then deleted; `openwiki-update.yml` byte-identical to HEAD

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end mcp-server shell wired into the solution build** - `182e5ea` (feat)
2. **Task 2: Remaining shells plus per-path CODEOWNERS routing** - `2dee65d` (feat)
3. **Task 3: CI pipeline plus whole-phase gate** - `2fce461` (feat)

**Plan metadata:** committed separately below (docs: complete plan).

## Files Created/Modified

- `packages/mcp-server/*` - Shell manifest, composite tsconfig (contracts reference), entry with Phase 4 marker
- `packages/access-policy/*` - Shell manifest, composite tsconfig, entry with Phase 3 marker
- `apps/api/*` - Shell manifest, composite tsconfig (relative `../../packages/contracts` reference), entry with Phase 7 marker
- `apps/web/*` - Shell manifest, composite tsconfig, entry with Phase 7 marker
- `tsconfig.json` - Solution references appended for all four shells, existing entries untouched
- `.github/CODEOWNERS` - Global rule kept as line 1 plus seven per-path lines with TODO placeholders
- `.github/workflows/ci.yml` - New PR pipeline (typecheck/lint/test/secrets, Node 24, pnpm 11.25.0, frozen lockfile, gitleaks v3)
- `pnpm-lock.yaml` - Workspace-link importers only, no new external packages

## Decisions Made

- Tracer feedback gate (Task 1): `human_verify_mode` is end-of-phase and the tracer `<verify>` carries only `<automated>` — re-ran `pnpm install && pnpm typecheck` green, logged expansion, continued with no checkpoint (checkpoints.md row 3)
- api/web shells live under `apps/` per every authoritative source in the plan (UC-09 section 0.3 layout, must-have truth, acceptance criteria `apps/web/dist and apps/api/dist`, Task 3 probe `apps/api/src`, CODEOWNERS `apps/` paths, eslint `apps/**/*.ts` scope) — see deviations
- ci.yml uses floating `v4` action tags as the plan text specifies (`actions/setup-node version 4`), rather than the SHA pins the OpenWiki workflow uses; OpenWiki workflow file never touched

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] api/web shells created under apps/ instead of the plan's files-listed packages/**
- **Found during:** Task 2 (read_first cross-check before writing)
- **Issue:** The plan's `<files>` list and `files_modified` frontmatter say `packages/api` and `packages/web`, but every verifiable requirement says `apps/api` and `apps/web`: UC-09 section 0.3 layout, PROJECT.md monorepo requirement, the must-have truth ("Workspace contains apps/web, apps/api ..."), acceptance criteria (`apps/web/dist and apps/api/dist exist`), Task 3's probe path (`apps/api/src/__ban_probe__.ts`), CODEOWNERS paths (`apps/api/`, `apps/web/`), and the eslint ban scope (`apps/**/*.ts`). Following the files list literally would fail the plan's own acceptance criteria.
- **Fix:** Created `apps/api/*` and `apps/web/*` (tsconfig references use the `../../packages/contracts` relative path, the only shape difference from the Task 1 pattern). No `packages/api` or `packages/web` directories exist.
- **Files modified:** apps/api/package.json, apps/api/tsconfig.json, apps/api/src/index.ts, apps/web/package.json, apps/web/tsconfig.json, apps/web/src/index.ts
- **Verification:** `pnpm typecheck` exits 0; `apps/api/dist/index.js` and `apps/web/dist/index.js` exist; ban probe fires from `apps/api/src`
- **Committed in:** 2dee65d (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking inconsistency)
**Impact on plan:** Required for the plan's own acceptance criteria to pass — no scope creep; shell shape, names, versions, and marker semantics match the plan exactly.

## Issues Encountered

None beyond the deviation above — each verify/gate passed on first run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 1 complete: workspace layout matches UC-09 section 0.3 with all six packages building, contracts frozen and documented, ban enforced from both agent and apps paths, CI + CODEOWNERS guarding main
- Later phases build in place: Phase 3 owns `packages/access-policy` + `policies/`, Phase 4 owns `packages/mcp-server`, Phase 7 owns `apps/api` + `apps/web` — no path renames needed
- Watch item from 01-01 still holds: composite tsconfigs include `src` only, so shell tests (if added later) run under vitest, not tsc

---
*Phase: 01-monorepo-contracts-freeze*
*Completed: 2026-10-25*

## Self-Check: PASSED
