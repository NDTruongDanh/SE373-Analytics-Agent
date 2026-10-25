---
phase: 01-monorepo-contracts-freeze
verified: 2026-10-25T13:05:01Z
status: gaps_found
score: 9/10 must-haves verified
covered_files: [".github/CODEOWNERS", ".github/workflows/ci.yml", ".planning/phases/01-monorepo-contracts-freeze/01-01-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-01-SUMMARY.md", ".planning/phases/01-monorepo-contracts-freeze/01-02-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-02-SUMMARY.md", ".planning/phases/01-monorepo-contracts-freeze/01-03-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-03-SUMMARY.md", "apps/api/package.json", "apps/api/src/index.ts", "apps/api/test/shell.test.ts", "apps/api/tsconfig.json", "apps/web/package.json", "apps/web/src/index.ts", "apps/web/test/shell.test.ts", "apps/web/tsconfig.json", "docs/mcp_interface.md", "eslint.config.mjs", "package.json", "packages/access-policy/package.json", "packages/access-policy/src/index.ts", "packages/access-policy/test/shell.test.ts", "packages/access-policy/tsconfig.json", "packages/agent/package.json", "packages/agent/src/index.ts", "packages/agent/test/shell.test.ts", "packages/agent/tsconfig.json", "packages/contracts/README.md", "packages/contracts/package.json", "packages/contracts/src/answers.ts", "packages/contracts/src/benchmark.ts", "packages/contracts/src/errors.ts", "packages/contracts/src/index.ts", "packages/contracts/src/semantic.ts", "packages/contracts/src/tools.ts", "packages/contracts/src/trace.ts", "packages/contracts/test/errors.test.ts", "packages/contracts/test/schemas.test.ts", "packages/contracts/test/tools.test.ts", "packages/contracts/test/zod-singleton.test.ts", "packages/contracts/tsconfig.json", "packages/contracts/vitest.config.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/index.ts", "packages/mcp-server/test/shell.test.ts", "packages/mcp-server/tsconfig.json", "pnpm-workspace.yaml", "scripts/generate-interface.mjs", "tsconfig.base.json", "tsconfig.json", "vitest.workspace.ts"]
covered_digest: "v3:sha256:2619b1004da84488df2bab0bbe3baad11206c0cfa0e7057cc8ef5c740f35095d"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 8/10
  gaps_closed:
    - "Per-package `pnpm test` red in the four shell packages (mcp-server, access-policy, api, web): all six per-package suites now exit 0 (contracts 14, agent 1, each shell 1; root 19/19)"
  gaps_remaining:
    - "Every PR runs green CI: live PR #10 run 40195800824 has secrets job FAILURE (gitleaks-action v3 requires GITHUB_TOKEN on pull_request events; ci.yml does not pass it)"
  regressions: []
gaps:
  - truth: "Every PR runs green CI (typecheck + lint + test + gitleaks v3)"
    status: failed
    reason: "Live CI on PR #10 (run 40195800824): typecheck/lint/test pass, but the secrets job FAILS. gitleaks-action v3 aborts on pull_request events without GITHUB_TOKEN ('GITHUB_TOKEN is now required to scan pull requests'); ci.yml secrets job passes no env token."
    artifacts:
      - path: ".github/workflows/ci.yml"
        issue: "secrets job invokes gitleaks/gitleaks-action@v3 with no `env: GITHUB_TOKEN`, so every PR run fails the secrets job"
    missing:
      - "Pass the automatic token to the scan step (e.g. `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` per the gitleaks-action README), then re-run CI on the PR until all four jobs are green"
---

# Phase 1: Monorepo + Contracts Freeze Verification Report

**Phase Goal:** Every UC owner builds against one frozen set of contracts and one enforced repo layout
**Verified:** 2026-10-25T13:05:01Z
**Status:** gaps_found
**Re-verification:** Yes — after gap closure (quick 261025-rih, commits 20f1561, 28f77a8, 2f07327 + docs 6b3f3fa) and live CI on PR #10

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Owner can run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` at root and per package, all green on Node 24 | ✓ VERIFIED (gap closed) | Re-run live: root `pnpm test` 9 files/19 passed exit 0; `pnpm typecheck` exit 0; `pnpm lint` exit 0; per-package `pnpm test` 6/6 exit 0 (contracts 14, agent 1, mcp-server/access-policy/api/web 1 each); per-package `pnpm typecheck` 6/6 OK. Node v24.22.1, pnpm 11.25.0 |
| 2 | Owner can import the 5 db-tool schemas from `@se373/contracts` | ✓ VERIFIED | Fresh tsx probe from `packages/agent`: all 5 input schemas parse valid input (12-assertion probe ALL PASS), barrel re-exports all modules |
| 3 | Owner can import 11 error codes with `DbToolError`, `ErrorCodes`, `RETRYABLE_CODES` | ✓ VERIFIED | Same probe: `ErrorCodes.length === 11`, TIMEOUT retryable, SCOPE_DENIED not retryable, `CONTRACTS_VERSION === 0.1.0` |
| 4 | Owner can import `SQLAnswerSchema` (with citations + telemetry) | ✓ VERIFIED | Same probe: minimal valid answer parses; contracts suite (5 schema tests) rejects 4th attempt and 51-row preview |
| 5 | Owner can import the trace event envelope | ✓ VERIFIED | Same probe: valid event parses, empty `runId` rejected |
| 6 | Owner can import semantic chunk metadata | ✓ VERIFIED | Same probe: full metadata parses (6 doc_types, sensitivity enum, `updated_at` ISO) |
| 7 | `docs/mcp_interface.md` regenerates via `pnpm docs:interface`, docs never drift | ✓ VERIFIED | `pnpm docs:interface` exit 0; regen is byte-stable (`diff` clean); names all 5 tools + RATE_LIMITED |
| 8 | A PR importing `pg`, `pg-cursor`, or mcp-server internals from `packages/agent` or `apps/*` fails lint | ✓ VERIFIED | Fresh probes (deleted after): `pg` in agent → exit 1 `no-restricted-imports`; `pg-cursor` in apps/api → exit 1; `@se373/mcp-server` in agent → exit 1; clean tree `pnpm lint` exit 0 |
| 9 | Every PR runs CI (typecheck + lint + test + gitleaks v3), all green | ✗ FAILED | Live PR #10 run 40195800824: typecheck ✓ (17s), lint ✓ (23s), test ✓ (19s), secrets ✗ (6s). gitleaks-action v3 errors: "GITHUB_TOKEN is now required to scan pull requests." ci.yml passes no token. See Gaps |
| 10 | CODEOWNERS routes each package to its owner with UC-owner TODO placeholders | ✓ VERIFIED | Global `*` rule kept line 1; 7 per-path lines all present with `TODO(UC-` markers (7 hits); mcp-server/access-policy/policies list HungPham-VNU first; defaults @NDTruongDanh + @HungPham-VNU |

**Score:** 9/10 truths verified (0 present-but-behavior-unverified)

### Advisory (New Scope, Unevidenced)

None. Re-verification ran; Step 7 scan of gap-closure files found no new-scope blockers (no debt markers, no placeholders, no disabled tests).

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
| `packages/contracts/README.md` | Additive-only governance | ✓ VERIFIED | `additive-only` (2×) + `CONTRACTS_VERSION` (2×), 11-code table, camelCase rule |
| `scripts/generate-interface.mjs` | z.toJSONSchema docs generator | ✓ VERIFIED | `z.toJSONSchema` used; regenerates byte-stable output |
| `docs/mcp_interface.md` | Generated interface docs | ✓ VERIFIED | Generated header, per-tool scope notes, error table, run_query example |
| `eslint.config.mjs` | DB-import ban | ✓ VERIFIED | `no-restricted-imports` scoped to agent + apps; ban proven firing from both paths |
| `.github/workflows/ci.yml` | PR pipeline | ✗ GAP | 4 jobs present with correct pins, but secrets job fails live (no GITHUB_TOKEN) |
| `.github/CODEOWNERS` | Per-path routing | ✓ VERIFIED | 7 per-path lines + global rule |
| `packages/agent/src/index.ts` | Agent shell + contracts link | ✓ VERIFIED | `AGENT_SHELL` marker; `DbToolError` type import; 1 test passes |
| 4 shell entries (mcp-server, access-policy, api, web) | Buildable shells in solution build | ✓ VERIFIED | All emit `dist/index.js`; `tsc -b` references all 6 projects; markers name owning phases |
| 4 shell tests + `vitest.workspace.ts` | Gap-closure tests, 6-project workspace | ✓ VERIFIED | Each test imports its real `*_SHELL` marker (read mcp-server + web tests); workspace lists all 6 projects; root suite 19/19 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `packages/agent/src/index.ts` | `packages/contracts/src/errors.ts` | `workspace:*` import of `DbToolError` | ✓ WIRED | `from '@se373/contracts'` present; typecheck + runtime probe pass |
| `eslint.config.mjs` | `packages/agent/**/*.ts`, `apps/**/*.ts` | `no-restricted-imports` files scope | ✓ WIRED | Ban fires exit 1 from both scopes; clean tree green |
| `tsconfig.json` | all 6 package tsconfigs | project references | ✓ WIRED | `tsc -b` builds full graph; all `dist/index.js` emitted |
| `scripts/generate-interface.mjs` | `packages/contracts/src/tools.ts` | `z.toJSONSchema()` over frozen schemas | ✓ WIRED | `toJSONSchema` present; regen is byte-stable |
| `packages/contracts/src/index.ts` | all schema modules | barrel re-export | ✓ WIRED | `export * from` ×6; single import surface proven by probes |
| `.github/workflows/ci.yml` | root package.json scripts | CI invokes same commands | ✓ WIRED | `pnpm typecheck` / `pnpm lint` / `pnpm test` all referenced; all three jobs pass live |
| `.github/CODEOWNERS` | `packages/contracts/` | mandatory review on contracts | ✓ WIRED | Per-path line present |
| `vitest.workspace.ts` | all 6 test-bearing projects | workspace project list | ✓ WIRED | Root run collects 9 files/19 tests across all packages |

### Data-Flow Trace (Level 4)

N/A — this phase produces schemas, shells, and config, not data-rendering components. No rendered value traces to a data source. The closest data flow (schemas → generated docs) is verified byte-stable via regeneration.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Root gate green | `pnpm test` / `pnpm typecheck` / `pnpm lint` | 19/19 pass; typecheck exit 0; lint exit 0 | ✓ PASS |
| Per-package test (gap re-check) | `pnpm --filter <each of 6> test` | 6/6 exit 0 (contracts 14, agent 1, 4 shells 1 each) | ✓ PASS (was ✗ FAIL) |
| Per-package typecheck | `pnpm --filter <each of 6> typecheck` | 6/6 exit 0 | ✓ PASS |
| Contract import surface | tsx probe from packages/agent (12 assertions) | 12/12 PASS | ✓ PASS |
| Docs regeneration | `pnpm docs:interface` + `diff` | exit 0, byte-stable | ✓ PASS |
| Ban probe (agent/pg) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` | ✓ PASS |
| Ban probe (apps/pg-cursor) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` | ✓ PASS |
| Ban probe (agent/@se373/mcp-server) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` | ✓ PASS |
| Live PR CI | `gh pr checks 10` + `gh run view --log-failed` | typecheck/lint/test pass, secrets fails (GITHUB_TOKEN) | ✗ FAIL → gap |

### Probe Execution

No probe scripts (`scripts/*/tests/probe-*.sh`) declared by any plan; conventional location empty. SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REPO-02 | 01-01, 01-03 | Workspace layout + strict TS refs + single zod | ✓ SATISFIED | 6 projects build; one `zod@4.6.7` (singleton test passes; two lockfile lines are the same version key in snapshots/packages sections) |
| REPO-03 | 01-01 + quick-261025-rih | Root + per-package typecheck/lint/test | ✓ SATISFIED | Root green (19/19); per-package typecheck 6/6; per-package test 6/6 — gap closed |
| REPO-04 | 01-03 | PR CI (typecheck+lint+test+gitleaks v3) | ✗ BLOCKED | ci.yml statically correct; live PR #10 run fails secrets job (missing GITHUB_TOKEN) → gap |
| REPO-05 | 01-01, 01-03 | ESLint ban on pg/pg-cursor/mcp-server internals | ✓ SATISFIED | Proven firing from agent + apps paths; clean tree green |
| REPO-06 | 01-03 | CODEOWNERS per-package routing | ✓ SATISFIED | 7 per-path lines + TODO placeholders |
| CONT-01 | 01-02 | 5 db-tool schemas | ✓ SATISFIED | Live-parse verified |
| CONT-02 | 01-01 | 11 error codes + DbToolError | ✓ SATISFIED | 11 codes; retryable semantics probed |
| CONT-03 | 01-02 | SQLAnswerSchema + citations + telemetry | ✓ SATISFIED | Live-parse verified; edge rejections tested |
| CONT-04 | 01-02 | Trace event envelope | ✓ SATISFIED | Live-parse verified |
| CONT-05 | 01-02 | Semantic chunk metadata | ✓ SATISFIED | Live-parse verified |
| CONT-06 | 01-02 | Generated docs/mcp_interface.md | ✓ SATISFIED | Regen byte-stable |

All 11 Phase 1 requirement IDs from PLAN frontmatter are accounted for; REQUIREMENTS.md maps exactly these 11 to Phase 1 — no orphans.

### Test Quality Audit

| Test File | Linked Req | Active | Skipped | Circular | Assertion Level | Verdict |
|-----------|-----------|--------|---------|----------|-----------------|---------|
| `packages/contracts/test/*.test.ts` | CONT-01..05 | 14 | 0 | none | Value (accept + reject edges) | Sufficient |
| `packages/agent/test/shell.test.ts` | REPO-03 | 1 | 0 | none | Type/existence | Sufficient for gate req |
| 4 new shell `test/shell.test.ts` | REPO-03 | 4 | 0 | none | Type/existence | Sufficient for gate req |

**Disabled tests on requirements:** 0 → no blocker.
**Circular patterns detected:** 0 → no blocker.
**Insufficient assertions:** 0 → the shell marker tests assert `typeof === 'string'` + `length > 0` over a real source import; REPO-03 demands the per-package gate *runs green*, which is proven by executing the commands (6/6 exit 0), not by assertion depth. No warning.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none in gap-closure files) | — | TBD/FIXME/XXX/HACK/placeholder/empty-return | — | None found in the 4 new test files, `vitest.workspace.ts`, or shell entries |
| `scripts/generate-interface.mjs` | 135 | `console.log` | ℹ️ Info | Legitimate CLI stdout (`wrote <path>`); not a stub (carried from prior pass) |
| CODEOWNERS/SUMMARY TODOs | — | `TODO(UC-xx owner)` | ℹ️ Info | Intentional per locked decision (placeholders now, real handles at review) |

Step 7 evidence gate: this is a re-verification pass; the scan above covers exactly the files changed since the prior `verified:` timestamp (4 shell tests + `vitest.workspace.ts` per `git log --since`). No new-scope blockers found, so no advisory entries and no contract-revert risk.

### Decision Coverage

`check.decision-coverage-verify` → `{skipped: true, reason: "no trackable decisions"}`: 01-CONTEXT.md `<decisions>` blocks carry no machine-trackable entries under the current gate config. Non-blocking by design. Manually confirmed the four locked user decisions still hold in the tree: `@se373/*` scope in all 6 manifests, additive-only governance in README + contracts CODEOWNERS line, CODEOWNERS placeholders with defaults + `TODO(UC-` markers, HungPham-VNU first on mcp-server/access-policy/policies.

### Gaps Summary

One gap blocks a clean pass, and it is a **newly evidenced CI-config defect exposed by the first live run** (the prior pass's human item asked for exactly this run):

- **Live CI is red on the secrets job.** PR #10 run 40195800824 (2026-10-25T13:02Z): typecheck, lint, and test all pass on the runner, but `secrets` fails in 6s because `gitleaks/gitleaks-action@v3` now hard-errors on `pull_request` events without a token (`##[error]🛑 GITHUB_TOKEN is now required to scan pull requests`). The checked-in `ci.yml` secrets job passes no `env: GITHUB_TOKEN`. Fix (for the orchestrator/next plan, not this report): add `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the scan step per the gitleaks-action README, push, and confirm all four jobs green on the PR. One-line config change; no code or contract impact.
- **Closed this round:** the per-package `pnpm test` gap. All four shell packages now ship a marker `shell.test.ts` mirroring the agent pattern (each imports its real `*_SHELL` const), `vitest.workspace.ts` lists all six projects, and the full gate is green locally (root 19/19, per-package 6/6, typecheck 6/6, lint clean) and in CI's test job.

---

_Verified: 2026-10-25T13:05:01Z_
_Verifier: the agent (gsd-verifier)_
