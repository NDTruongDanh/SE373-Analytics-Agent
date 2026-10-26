---
phase: 01-monorepo-contracts-freeze
verified: 2026-10-25T13:11:15Z
status: passed
score: 10/10 must-haves verified
covered_files: [".github/CODEOWNERS", ".github/workflows/ci.yml", ".planning/phases/01-monorepo-contracts-freeze/01-01-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-01-SUMMARY.md", ".planning/phases/01-monorepo-contracts-freeze/01-02-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-02-SUMMARY.md", ".planning/phases/01-monorepo-contracts-freeze/01-03-PLAN.md", ".planning/phases/01-monorepo-contracts-freeze/01-03-SUMMARY.md", "apps/api/package.json", "apps/api/src/index.ts", "apps/api/test/shell.test.ts", "apps/api/tsconfig.json", "apps/web/package.json", "apps/web/src/index.ts", "apps/web/test/shell.test.ts", "apps/web/tsconfig.json", "docs/mcp_interface.md", "eslint.config.mjs", "package.json", "packages/access-policy/package.json", "packages/access-policy/src/index.ts", "packages/access-policy/test/shell.test.ts", "packages/access-policy/tsconfig.json", "packages/agent/package.json", "packages/agent/src/index.ts", "packages/agent/test/shell.test.ts", "packages/agent/tsconfig.json", "packages/contracts/README.md", "packages/contracts/package.json", "packages/contracts/src/answers.ts", "packages/contracts/src/benchmark.ts", "packages/contracts/src/errors.ts", "packages/contracts/src/index.ts", "packages/contracts/src/semantic.ts", "packages/contracts/src/tools.ts", "packages/contracts/src/trace.ts", "packages/contracts/test/errors.test.ts", "packages/contracts/test/schemas.test.ts", "packages/contracts/test/tools.test.ts", "packages/contracts/test/zod-singleton.test.ts", "packages/contracts/tsconfig.json", "packages/contracts/vitest.config.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/index.ts", "packages/mcp-server/test/shell.test.ts", "packages/mcp-server/tsconfig.json", "pnpm-workspace.yaml", "scripts/generate-interface.mjs", "tsconfig.base.json", "tsconfig.json", "vitest.workspace.ts"]
covered_digest: "v3:sha256:be4415c128a2b8c314f444b0c83a366747939b82b22424aadcb03af194c7466f"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 9/10
  gaps_closed:
    - "Every PR runs green CI: live PR #10 run 40196254910 reports typecheck/lint/test/secrets all success (conclusion success) after commit 1004e16 added `env: GITHUB_TOKEN` to the gitleaks v3 scan step"
  gaps_remaining: []
  regressions: []
---

# Phase 1: Monorepo + Contracts Freeze Verification Report

**Phase Goal:** Every UC owner builds against one frozen set of contracts and one enforced repo layout
**Verified:** 2026-10-25T13:11:15Z
**Status:** passed
**Re-verification:** Yes — after gap closure (quick 261025-rxa, commit 1004e16) and live green CI on PR #10

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Owner can run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` at root and per package, all green on Node 24 | ✓ VERIFIED | Regression re-run: root `pnpm test` 9 files/19 passed exit 0; `pnpm typecheck` exit 0; `pnpm lint` exit 0; per-package `pnpm test` 6/6 exit 0 (contracts 14, agent 1, 4 shells 1 each); per-package `pnpm typecheck` 6/6 exit 0. Node v24.22.1, pnpm 11.25.0 |
| 2 | Owner can import the 5 db-tool schemas from `@se373/contracts` | ✓ VERIFIED | Fresh tsx probe from `packages/agent`: all 5 input schemas parse valid input (ListTables/DescribeTable/ExplainQuery/RunQuery/SampleRows) — CONTRACT_PROBE_ALL_PASS |
| 3 | Owner can import 11 error codes with `DbToolError`, `ErrorCodes`, `RETRYABLE_CODES` | ✓ VERIFIED | Same probe: `ErrorCodes.length === 11`, TIMEOUT in RETRYABLE_CODES, `CONTRACTS_VERSION === 0.1.0` |
| 4 | Owner can import `SQLAnswerSchema` (with citations + telemetry) | ✓ VERIFIED | Same probe: full-shape answer (intent/sql/tablesUsed/citations/attempts/resultPreview/answerText/status/telemetry) parses; contracts suite rejects 4th attempt and 51-row preview (prior pass) |
| 5 | Owner can import the trace event envelope | ✓ VERIFIED | Same probe: valid event parses (runId/threadId/userId/role/node/type/ts/durationMs/payload) |
| 6 | Owner can import semantic chunk metadata | ✓ VERIFIED | Same probe: full metadata parses (chunk_id, 6 doc_types via enum, sensitivity enum, `updated_at` ISO) |
| 7 | `docs/mcp_interface.md` regenerates via `pnpm docs:interface`, docs never drift | ✓ VERIFIED | `pnpm docs:interface` exit 0; sha1 identical before/after (`c4fdee5e…`); names all 5 tools + RATE_LIMITED (prior pass) |
| 8 | A PR importing `pg`, `pg-cursor`, or mcp-server internals from `packages/agent` or `apps/*` fails lint | ✓ VERIFIED | Fresh probe (deleted after): `pg` import in `packages/agent/test/` → exit 1 `no-restricted-imports` with the UC-09 F11 message; clean tree `pnpm lint` exit 0 |
| 9 | Every PR runs CI (typecheck + lint + test + gitleaks v3), all green | ✓ VERIFIED (gap closed) | Live PR #10 run 40196254910 (`gh pr checks 10` + `gh run view`): typecheck ✓ (20s), lint ✓ (16s), test ✓ (20s), secrets ✓ (11s); run conclusion `success`. Fix: commit 1004e16 adds `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the scan step (ci.yml line 97-98) |
| 10 | CODEOWNERS routes each package to its owner with UC-owner TODO placeholders | ✓ VERIFIED | Unchanged since prior pass: 7 `TODO(UC-` hits; re-grep confirms 7; global `*` rule first; mcp-server/access-policy/policies list HungPham-VNU first |

**Score:** 10/10 truths verified (0 present-but-behavior-unverified)

### Advisory (New Scope, Unevidenced)

None. Re-verification ran; Step 7 scan of the gap-closure file (`.github/workflows/ci.yml`, the only file changed since the prior `verified:` timestamp per `git log`) found no debt markers, placeholders, or disabled tests. The ci.yml diff is a 2-line `env:` addition with no permissions/license/checkout churn.

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
| `eslint.config.mjs` | DB-import ban | ✓ VERIFIED | `no-restricted-imports` scoped to agent + apps; ban proven firing from agent path |
| `.github/workflows/ci.yml` | PR pipeline | ✓ VERIFIED (was gap) | 4 jobs present with correct pins; live run 40196254910 all success; scan step carries `GITHUB_TOKEN` env |
| `.github/CODEOWNERS` | Per-path routing | ✓ VERIFIED | 7 per-path lines + global rule |
| `packages/agent/src/index.ts` | Agent shell + contracts link | ✓ VERIFIED | `AGENT_SHELL` marker; `DbToolError` type import; 1 test passes |
| 4 shell entries (mcp-server, access-policy, api, web) | Buildable shells in solution build | ✓ VERIFIED | `tsc -b` references all 6 projects; per-package typecheck 6/6 |
| 4 shell tests + `vitest.workspace.ts` | Gap-closure tests, 6-project workspace | ✓ VERIFIED | Each test imports its real `*_SHELL` const; workspace lists all six projects; root suite 19/19 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `packages/agent/src/index.ts` | `packages/contracts/src/errors.ts` | `workspace:*` import of `DbToolError` | ✓ WIRED | `from '@se373/contracts'` present; typecheck + runtime probe pass |
| `eslint.config.mjs` | `packages/agent/**/*.ts`, `apps/**/*.ts` | `no-restricted-imports` files scope | ✓ WIRED | Ban fires exit 1 from agent path; clean tree green |
| `tsconfig.json` | all 6 package tsconfigs | project references | ✓ WIRED | `tsc -b` builds full graph |
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
| Per-package test | `pnpm --filter <each of 6> test` | 6/6 exit 0 (contracts 14, agent 1, 4 shells 1 each) | ✓ PASS |
| Per-package typecheck | `pnpm --filter <each of 6> typecheck` | 6/6 exit 0 | ✓ PASS |
| Contract import surface | tsx probe from packages/agent (10 assertions) | CONTRACT_PROBE_ALL_PASS | ✓ PASS |
| Docs regeneration | `pnpm docs:interface` + sha1 before/after | exit 0, sha1 `c4fdee5e…` identical | ✓ PASS |
| Ban probe (agent/pg) | temp file → `eslint` → delete | exit 1, `no-restricted-imports` (UC-09 F11 message) | ✓ PASS |
| Live PR CI | `gh pr checks 10` + `gh run view 40196254910` | typecheck/lint/test/secrets all success; conclusion success | ✓ PASS (was ✗ FAIL) |

### Probe Execution

No probe scripts (`scripts/*/tests/probe-*.sh`) declared by any plan; conventional location empty. SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| REPO-02 | 01-01, 01-03 | Workspace layout + strict TS refs + single zod | ✓ SATISFIED | 6 projects build; one `zod@4.6.7` (singleton test passes) |
| REPO-03 | 01-01 + quick-261025-rih | Root + per-package typecheck/lint/test | ✓ SATISFIED | Root green (19/19); per-package typecheck 6/6; per-package test 6/6 |
| REPO-04 | 01-03 + quick-261025-rxa | PR CI (typecheck+lint+test+gitleaks v3) | ✓ SATISFIED | Live PR #10 run 40196254910: all 4 jobs success — gap closed |
| REPO-05 | 01-01, 01-03 | ESLint ban on pg/pg-cursor/mcp-server internals | ✓ SATISFIED | Proven firing from agent path; clean tree green |
| REPO-06 | 01-03 | CODEOWNERS per-package routing | ✓ SATISFIED | 7 per-path lines + TODO placeholders |
| CONT-01 | 01-02 | 5 db-tool schemas | ✓ SATISFIED | Live-parse verified (all 5 inputs) |
| CONT-02 | 01-01 | 11 error codes + DbToolError | ✓ SATISFIED | 11 codes; retryable semantics probed |
| CONT-03 | 01-02 | SQLAnswerSchema + citations + telemetry | ✓ SATISFIED | Live-parse verified (full shape); edge rejections tested |
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
| (gap-closure file `.github/workflows/ci.yml`) | — | TBD/FIXME/XXX/HACK/placeholder/empty-return | — | None found |
| `packages/contracts/src/` | — | TBD/FIXME/XXX/placeholder | — | None found |
| `scripts/generate-interface.mjs` | 135 | `console.log` | ℹ️ Info | Legitimate CLI stdout (`wrote <path>`); not a stub (carried from prior pass) |
| CODEOWNERS/SUMMARY TODOs | — | `TODO(UC-xx owner)` | ℹ️ Info | Intentional per locked decision (placeholders now, real handles at review) |

Step 7 evidence gate: this is a re-verification pass; the only file changed since the prior `verified:` timestamp is `.github/workflows/ci.yml` (commit 1004e16 + rxa doc commits). No new-scope blockers found, so no advisory entries and no contract-revert risk.

### Decision Coverage

`check.decision-coverage-verify` gate is non-blocking by design. Manually confirmed the four locked user decisions still hold in the tree: `@se373/*` scope in all 6 manifests, additive-only governance in README + contracts CODEOWNERS line, CODEOWNERS placeholders with defaults + `TODO(UC-` markers, HungPham-VNU first on mcp-server/access-policy/policies.

### Human Verification Required

N/A — Infrastructure/foundation phase with no user-facing elements. All acceptance criteria are verifiable programmatically. No ⚠️ PRESENT_BEHAVIOR_UNVERIFIED or abstained truths exist, so the infra auto-pass applies with no carve-out items.

### Gaps Summary

No gaps. The single prior gap (truth 9 — `secrets` job failing on PR #10 run 40195800824 because gitleaks-action v3 requires `GITHUB_TOKEN` on `pull_request` events) was closed by quick 261025-rxa commit `1004e16`, which adds exactly `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the scan step. The orchestrator pushed, and live PR #10 run 40196254910 (2026-10-25T13:08Z) reports all four jobs green with run conclusion `success`. Regression spot-checks confirm no collateral damage: root and per-package gates green, docs regen byte-stable, lint ban still fires, contracts import surface parses. Phase goal achieved — ready to proceed.

---

_Verified: 2026-10-25T13:11:15Z_
_Verifier: the agent (gsd-verifier)_
