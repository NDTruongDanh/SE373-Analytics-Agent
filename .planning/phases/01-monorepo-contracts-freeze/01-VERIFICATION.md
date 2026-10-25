---
phase: 01-monorepo-contracts-freeze
verified: 2026-10-25T12:40:24Z
status: gaps_found
score: 8/10 must-haves verified
covered_files: [".github/CODEOWNERS", ".github/workflows/ci.yml", ".planning/phases/01-monorepo-contracts-freeze/01-01-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-01-SUMMARY.md", ".planning/phases/01-monorepo-contracts-freeze/01-02-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-02-SUMMARY.md", ".planning/phases/01-monorepo-contracts-freeze/01-03-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-03-SUMMARY.md", "apps/api/src/index.ts", "apps/web/src/index.ts", "docs/mcp_interface.md", "eslint.config.mjs", "package.json", "packages/access-policy/src/index.ts", "packages/agent/src/index.ts", "packages/agent/test/shell.test.ts", "packages/contracts/README.md", "packages/contracts/src/answers.ts", "packages/contracts/src/benchmark.ts", "packages/contracts/src/errors.ts", "packages/contracts/src/index.ts", "packages/contracts/src/semantic.ts", "packages/contracts/src/tools.ts", "packages/contracts/src/trace.ts", "packages/contracts/test/schemas.test.ts", "packages/contracts/test/tools.test.ts", "packages/contracts/test/zod-singleton.test.ts", "packages/mcp-server/src/index.ts", "pnpm-workspace.yaml", "scripts/generate-interface.mjs", "tsconfig.base.json", "tsconfig.json", "vitest.workspace.ts"]
covered_digest: "v3:sha256:81502bf145ed4e5769e2556018bfe95e3bbad4f72b9568deeed4dd9459f78399"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Owner can run pnpm install, pnpm typecheck, pnpm lint, pnpm test at root and per package, all green on Node 24"
    status: failed
    reason: "Per-package `pnpm test` exits 1 for all four shell packages (mcp-server, access-policy, api, web): `vitest run` with no test files. Root gate is green, per-package typecheck is green for all six packages, but SC1 requires per-package test green too."
    artifacts:
      - path: "packages/mcp-server/package.json"
        issue: "`test: vitest run` with no test files present exits 1 (verified live: 'No test files found, exiting with code 1')"
      - path: "packages/access-policy/package.json"
        issue: "same — no test files, exit 1"
      - path: "apps/api/package.json"
        issue: "same — no test files, exit 1"
      - path: "apps/web/package.json"
        issue: "same — no test files, exit 1"
    missing:
      - "Add `--passWithNoTests` to the four shell packages' test scripts, or add one trivial marker test per shell (matching the agent shell-test pattern)"
      - "Document that per-package lint is covered by root `pnpm lint` (no per-package lint script exists by design)"
human_verification:
  - test: "Push to GitHub and confirm the new ci.yml runs green on a PR (typecheck + lint + test + secrets jobs)"
    expected: "All four jobs pass on the PR; gitleaks v3 secrets job completes"
    why_human: "CI workflow is verified statically and its commands verified locally, but no GitHub Actions run has occurred since ci.yml was added (nothing pushed). A live runner can differ (action versions, cache, fetch-depth)."
---

# Phase 1: Monorepo + Contracts Freeze Verification Report

**Phase Goal:** Every UC owner builds against one frozen set of contracts and one enforced repo layout
**Verified:** 2026-10-25T12:40:24Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Owner can run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` at root and per package, all green on Node 24 | ✗ FAILED | Root: install/typecheck/lint/test all exit 0 (15 tests pass). Per-package typecheck 6/6 green. Per-package test: contracts ✓, agent ✓, but mcp-server/access-policy/api/web exit 1 (`No test files found`). See Gaps. |
| 2 | Owner can import the 5 db-tool schemas from `@se373/contracts` | ✓ VERIFIED | Live tsx probe from `@se373/agent`: all 5 input schemas parse; barrel re-exports all modules |
| 3 | Owner can import 11 error codes with `DbToolError`, `ErrorCodes`, `RETRYABLE_CODES`, `dbToolError` | ✓ VERIFIED | Live probe: `ErrorCodes.length === 11`, TIMEOUT retryable, SCOPE_DENIED not; `CONTRACTS_VERSION === 0.1.0` |
| 4 | Owner can import `SQLAnswerSchema` with citations + telemetry | ✓ VERIFIED | Live probe: minimal valid answer parses; attempts>3 and preview>50 rejected (contracts suite, 5 tests) |
| 5 | Owner can import the trace event envelope | ✓ VERIFIED | Live probe: valid event parses, empty `runId` rejected |
| 6 | Owner can import semantic chunk metadata | ✓ VERIFIED | Live probe: full metadata parses (6 doc_types, sensitivity enum, `updated_at` ISO) |
| 7 | `docs/mcp_interface.md` regenerates via `pnpm docs:interface`, docs never drift | ✓ VERIFIED | `pnpm docs:interface` exit 0; `git diff --exit-code docs/mcp_interface.md` clean; names all 5 tools + RATE_LIMITED |
| 8 | A PR importing `pg`, `pg-cursor`, or mcp-server internals from `packages/agent` or `apps/*` fails lint | ✓ VERIFIED | Temp probes (deleted after): `pg` in agent → exit 1 `no-restricted-imports`; `pg-cursor` in apps/api → exit 1; `@se373/mcp-server` in agent → exit 1; clean tree `pnpm lint` exit 0 |
| 9 | Every PR runs CI (typecheck + lint + test + gitleaks v3) | ✓ VERIFIED (static) + human_needed (live) | ci.yml: triggers `pull_request` + `push: main`; 4 jobs mirror OpenWiki setup (pnpm 11.25.0, Node 24, `--frozen-lockfile`, pnpm cache); `gitleaks/gitleaks-action@v3`; openwiki-update.yml byte-identical to HEAD. Never run on GitHub → see Human Verification. |
| 10 | CODEOWNERS routes each package to its owner with UC-owner TODO placeholders | ✓ VERIFIED | Global `*` rule kept line 1; 7 per-path lines all present with `TODO(UC-` markers; mcp-server/access-policy/policies list @HungPham-VNU first; defaults @NDTruongDanh + @HungPham-VNU |

**Score:** 8/10 truths verified (truths 1 and 9 carry the gap / live-run caveat)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/contracts/src/errors.ts` | 11 codes, DbToolErrorSchema, factory | ✓ VERIFIED | Substantive; 4 unit tests pass; imported by agent shell |
| `packages/contracts/src/tools.ts` | 5 tool I/O pairs | ✓ VERIFIED | Bounds (sql ≤20000, table ≤128, maxRows ≤1000, sample n ≤5); 4 round-trip tests |
| `packages/contracts/src/answers.ts` | SQLAnswer + SqlAttempt | ✓ VERIFIED | camelCase canon, attempts ≤3, preview ≤50, 4-member status enum |
| `packages/contracts/src/trace.ts` | Trace event envelope | ✓ VERIFIED | runId/threadId/userId/role/node/type/ts/durationMs + payload |
| `packages/contracts/src/semantic.ts` | Chunk metadata | ✓ VERIFIED | 6 doc_types, sensitivity aligned with future policy file |
| `packages/contracts/src/benchmark.ts` | BenchmarkRow | ✓ VERIFIED | PRD 2.2 shape; unknown difficulty rejected by test |
| `packages/contracts/src/index.ts` | Barrel + CONTRACTS_VERSION | ✓ VERIFIED | Re-exports all 6 modules; version 0.1.0 |
| `packages/contracts/README.md` | Additive-only governance | ✓ VERIFIED | Contains `additive-only` (2×) + `CONTRACTS_VERSION` (2×), 11-code table, camelCase rule |
| `scripts/generate-interface.mjs` | z.toJSONSchema docs generator | ✓ VERIFIED | `z.toJSONSchema` used; regenerates byte-stable output |
| `docs/mcp_interface.md` | Generated interface docs | ✓ VERIFIED | Generated header, per-tool scope notes, error table, run_query example |
| `eslint.config.mjs` | DB-import ban | ✓ VERIFIED | `no-restricted-imports` scoped to agent + apps; ban proven firing from both paths |
| `.github/workflows/ci.yml` | PR pipeline | ✓ VERIFIED (static) | 4 jobs; live run still needed |
| `.github/CODEOWNERS` | Per-path routing | ✓ VERIFIED | 7 per-path lines + global rule |
| `packages/agent/src/index.ts` | Agent shell + contracts link | ✓ VERIFIED | `AGENT_SHELL` marker; `DbToolError` type import; 1 test passes |
| 4 shell entries (mcp-server, access-policy, api, web) | Buildable shells in solution build | ✓ VERIFIED | All emit `dist/index.js`; `tsc -b` references all 6 projects; markers name owning phases |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `packages/agent/src/index.ts` | `packages/contracts/src/errors.ts` | `workspace:*` import of `DbToolError` | ✓ WIRED | `from '@se373/contracts'` present; typecheck + runtime probe pass |
| `eslint.config.mjs` | `packages/agent/**/*.ts`, `apps/**/*.ts` | `no-restricted-imports` files scope | ✓ WIRED | Ban fires exit 1 from both scopes; clean tree green |
| `tsconfig.json` | all 6 package tsconfigs | project references | ✓ WIRED | `tsc -b` builds full graph; all `dist/index.js` emitted |
| `scripts/generate-interface.mjs` | `packages/contracts/src/tools.ts` | `z.toJSONSchema()` over frozen schemas | ✓ WIRED | `toJSONSchema` present; regen is byte-stable |
| `packages/contracts/src/index.ts` | all schema modules | barrel re-export | ✓ WIRED | `export * from` ×6; single import surface proven by probes |
| `.github/workflows/ci.yml` | root package.json scripts | CI invokes same commands | ✓ WIRED | `pnpm typecheck` / `pnpm lint` / `pnpm test` all referenced |
| `.github/CODEOWNERS` | `packages/contracts/` | mandatory review on contracts | ✓ WIRED | Per-path line present |

### Data-Flow Trace (Level 4)

N/A — this phase produces schemas, shells, and config, not data-rendering components. No rendered value traces to a data source. The closest data flow (schemas → generated docs) is verified byte-stable via regeneration.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Root gate green | `pnpm install && pnpm typecheck && pnpm lint && pnpm test` | All exit 0; 15/15 tests pass | ✓ PASS |
| Per-package typecheck | `pnpm --filter <each of 6> typecheck` | 6/6 exit 0 | ✓ PASS |
| Per-package test | `pnpm --filter <each> test` | contracts ✓, agent ✓, 4 shells exit 1 (no test files) | ✗ FAIL → gap |
| Contract import surface | tsx probe (10 assertions: codes, schemas, edge rejections) | 10/10 PASS | ✓ PASS |
| Docs regeneration | `pnpm docs:interface` + `git diff --exit-code` | exit 0, diff clean | ✓ PASS |
| Ban probe (agent/pg) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` | ✓ PASS |
| Ban probe (apps/pg-cursor) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` | ✓ PASS |
| Ban probe (agent/@se373/mcp-server) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` | ✓ PASS |

### Probe Execution

No probe scripts (`scripts/*/tests/probe-*.sh`) declared by any plan; conventional location empty. SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REPO-02 | 01-01, 01-03 | Workspace layout + strict TS refs + single zod | ✓ SATISFIED | 6 projects build; one `zod@4.6.7` (singleton test passes) |
| REPO-03 | 01-01 | Root + per-package typecheck/lint/test | ⚠️ PARTIAL | Root green; per-package typecheck green; per-package test fails for 4 shells → gap |
| REPO-04 | 01-03 | PR CI (typecheck+lint+test+gitleaks v3) | ⚠️ PARTIAL | ci.yml statically correct; live GitHub run still needed → human item |
| REPO-05 | 01-01, 01-03 | ESLint ban on pg/pg-cursor/mcp-server internals | ✓ SATISFIED | Proven firing from agent + apps paths; clean tree green |
| REPO-06 | 01-03 | CODEOWNERS per-package routing | ✓ SATISFIED | 7 per-path lines + TODO placeholders |
| CONT-01 | 01-02 | 5 db-tool schemas | ✓ SATISFIED | Live-parse verified |
| CONT-02 | 01-01 | 11 error codes + DbToolError | ✓ SATISFIED | 11 codes; retryable semantics probed |
| CONT-03 | 01-02 | SQLAnswerSchema + citations + telemetry | ✓ SATISFIED | Live-parse verified; edge rejections tested |
| CONT-04 | 01-02 | Trace event envelope | ✓ SATISFIED | Live-parse verified |
| CONT-05 | 01-02 | Semantic chunk metadata | ✓ SATISFIED | Live-parse verified |
| CONT-06 | 01-02 | Generated docs/mcp_interface.md | ✓ SATISFIED | Regen byte-stable |

All 11 Phase 1 requirement IDs from PLAN frontmatter are accounted for; REQUIREMENTS.md maps exactly these 11 to Phase 1 — no orphans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `scripts/generate-interface.mjs` | 135 | `console.log` | ℹ️ Info | Legitimate CLI stdout (`wrote <path>`); not a stub |
| (none) | — | TBD/FIXME/XXX/HACK/placeholder/empty-return | — | None found in phase files |
| CODEOWNERS/SUMMARY TODOs | — | `TODO(UC-xx owner)` | ℹ️ Info | Intentional per locked decision (placeholders now, real handles at review) |

### Orchestrator Observations (evaluated, not pre-judged)

- (a) Commit-scope naming (`01-monorepo-contracts-freeze-01` vs `01-01`): commits `a490973`/`df211b8`/`72473e6` all exist in history (verified via `git log --grep`). Cosmetic only; no missing work. Not a gap.
- (b) api/web under `apps/` vs plan's `packages/api` file list:Deviation `2dee65d` is justified — every normative source in the plan (UC-09 §0.3, must-have truth, acceptance criteria, Task 3 probe path, CODEOWNERS paths, eslint scope) requires `apps/`. The files list was internally inconsistent. Accept; not a gap.
- (c) CI never run on GitHub: confirmed (no push since ci.yml added). Recorded as the human-verification item above, not a silent pass.

### Locked User Decisions (01-CONTEXT.md compliance)

| Decision | Status | Evidence |
|----------|--------|----------|
| `@se373/*` scope | ✓ | All 6 manifests use `@se373/*` + `workspace:*` internal deps |
| Additive-only governance in README + CODEOWNERS enforcement | ✓ | README has rule; `packages/contracts/` CODEOWNERS line present |
| CODEOWNERS placeholders with defaults + TODO(UC-xx) | ✓ | `@NDTruongDanh @HungPham-VNU` defaults + TODO markers on all 7 lines |
| mcp-server/access-policy/policies → HungPham-VNU first | ✓ | HungPham-VNU listed first on all three lines |

### Human Verification Required

### 1. Live CI run on GitHub

**Test:** Push the branch / open a PR and confirm the `ci` workflow runs all four jobs (typecheck, lint, test, secrets) green.
**Expected:** All jobs pass; gitleaks v3 scan completes with no findings.
**Why human:** No GitHub Actions run has occurred since ci.yml was added; static content and local command equivalence are verified, but runner behavior (action versions, cache, fetch-depth) can only be proven live.

### Gaps Summary

One actionable gap blocks a clean pass: **per-package `pnpm test` is red for the four shell packages** (`packages/mcp-server`, `packages/access-policy`, `apps/api`, `apps/web`) because `vitest run` exits 1 when no test files exist. ROADMAP SC1 requires `pnpm test` green "at root and per package". Root suite (15/15) and all per-package typechecks are green, so this is a one-line-per-package fix (`--passWithNoTests` or trivial marker tests), not a design problem. Separately, the CI workflow needs its first live GitHub run (human item, not a code gap).

---

_Verified: 2026-10-25T12:40:24Z_
_Verifier: the agent (gsd-verifier)_
