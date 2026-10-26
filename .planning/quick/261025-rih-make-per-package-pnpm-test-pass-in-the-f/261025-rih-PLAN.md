---
phase: 01-monorepo-contracts-freeze
plan: quick-per-package-test-gap
type: execute
wave: 1
depends_on: []
files_modified: ["packages/mcp-server/test/shell.test.ts", "packages/access-policy/test/shell.test.ts", "apps/api/test/shell.test.ts", "apps/web/test/shell.test.ts", "vitest.workspace.ts"]
autonomous: true
requirements: [REPO-03]
user_setup: []

estimate:
  tokens: 12000
  raw_tokens: 12000
  tasks: 2
  confidence: low

must_haves:
  truths:
    - "Owner can run pnpm test inside each of the four shell packages and every run exits 0"
    - "Root pnpm test still exits 0 and now also runs the four new shell tests"
    - "Root pnpm typecheck and pnpm lint still exit 0; contracts and agent behavior unchanged"
  artifacts:
    - "packages/mcp-server/test/shell.test.ts"
    - "packages/access-policy/test/shell.test.ts"
    - "apps/api/test/shell.test.ts"
    - "apps/web/test/shell.test.ts"
    - "vitest.workspace.ts (lists all six test-bearing projects)"
  key_links:
    - "Each new shell.test.ts imports its shell marker from ../src/index.js, mirroring packages/agent/test/shell.test.ts"
---

<objective>
Close the Phase 1 verification gap (01-VERIFICATION.md truth 1 / REPO-03): per-package `pnpm test` exits 1 with "No test files found" in the four empty shell packages.

Purpose: Make `pnpm test` green at root AND per package on Node 24 without weakening any existing gate.
Output: Four marker test files plus a workspace registration update; full gate re-verified green.
</objective>

<execution_context>
@/home/honolulu0630/.config/openchamber/gsd-core/workflows/execute-plan.md
@/home/honolulu0630/.config/openchamber/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/01-monorepo-contracts-freeze/01-VERIFICATION.md
@packages/agent/test/shell.test.ts
@packages/agent/src/index.ts
@vitest.workspace.ts
</context>

<tasks>

<task type="auto">
  <name>Add marker shell tests and register shells in the vitest workspace</name>
  <files>packages/mcp-server/test/shell.test.ts, packages/access-policy/test/shell.test.ts, apps/api/test/shell.test.ts, apps/web/test/shell.test.ts, vitest.workspace.ts</files>
  <action>Chosen approach: one trivial marker test per shell following the existing agent shell-test pattern, NOT --passWithNoTests. Rationale: --passWithNoTests would keep exit 0 even if a future change accidentally deletes every test file in a shell, hiding the regression; marker tests assert a real (if minimal) property, match the established convention from packages/agent/test/shell.test.ts, and keep the test/ directory plus default vitest include pattern as the discoverable home for future real tests. Create four test files, each a line-for-line adaptation of packages/agent/test/shell.test.ts: import { describe, expect, it } from vitest; import the shell marker const from ../src/index.js (MCP_SERVER_SHELL for mcp-server, ACCESS_POLICY_SHELL for access-policy, API_SHELL for apps/api, WEB_SHELL for apps/web); one describe/it asserting typeof marker is string and length greater than 0. Then extend the default-exported array in vitest.workspace.ts to list all six projects: packages/contracts, packages/agent, packages/mcp-server, packages/access-policy, apps/api, apps/web. This is proven safe by precedent: packages/agent has no vitest.config.ts yet is discovered both per-package and via this workspace list. Do NOT touch packages/contracts or packages/agent in any way. Do NOT add any vitest.config.ts files (none of the shells need one; defaults suffice as proven by agent). Do NOT change any package.json test script. Do NOT change any tsconfig (composite configs include src only by locked decision; test files stay invisible to tsc -b exactly like the agent test today).</action>
  <verify>
    <automated>export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; hash -r; pnpm --filter @se373/mcp-server test && pnpm --filter @se373/access-policy test && pnpm --filter @se373/api test && pnpm --filter @se373/web test</automated>
    <fails_when>any of the four per-package test commands exits non-zero, or any reports "No test files found"</fails_when>
  </verify>
  <done>Four shell.test.ts files exist importing their respective markers; all four per-package pnpm test runs exit 0 with 1 passed test each</done>
</task>

<task type="auto">
  <name>Re-run the full Phase 1 gate: root test, typecheck, lint, all per-package tests</name>
  <files>vitest.workspace.ts</files>
  <action>Prove no existing gate regressed. Run root pnpm test and confirm the total is 19 passing (15 pre-existing plus the 4 new marker tests) with zero failures. Run root pnpm typecheck (tsc -b over all six project references) and root pnpm lint (eslint .) and confirm both exit 0. Confirm packages/contracts and packages/agent test files are byte-identical to HEAD via git status/diff (no modifications allowed). If the root total is not exactly 19 passed, stop and report which project is missing rather than editing further files.</action>
  <verify>
    <automated>export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; hash -r; pnpm test && pnpm typecheck && pnpm lint && pnpm --filter @se373/contracts test && pnpm --filter @se373/agent test</automated>
    <fails_when>root pnpm test exits non-zero or shows fewer than 19 passed tests, or pnpm typecheck exits non-zero, or pnpm lint exits non-zero, or either contracts/agent per-package test exits non-zero</fails_when>
  </verify>
  <done>Root suite 19/19 green; typecheck and lint exit 0; all six per-package test runs green; git diff shows changes only in the four new test files plus vitest.workspace.ts</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| test file → shell entry | New tests import only the shell marker const; no untrusted input crosses |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-01-07 | Tampering | vitest.workspace.ts project list | low | mitigate | Task 2 asserts the root suite runs exactly 19 tests, so a dropped or phantom project entry fails loudly instead of silently narrowing coverage |
</threat_model>

<verification>
Root `pnpm test` 19/19 green; `pnpm typecheck` exit 0; `pnpm lint` exit 0; per-package `pnpm test` green in all six packages; git diff limited to the four new test files and vitest.workspace.ts.
</verification>

<success_criteria>
01-VERIFICATION.md truth 1 per-package leg is satisfied: mcp-server, access-policy, api, and web each pass `pnpm test`; REPO-03 moves from PARTIAL to SATISFIED pending verifier re-run; no contracts/agent behavior changed.
</success_criteria>

<output>
Create `.planning/quick/261025-rih-make-per-package-pnpm-test-pass-in-the-f/261025-rih-SUMMARY.md` when done
</output>
