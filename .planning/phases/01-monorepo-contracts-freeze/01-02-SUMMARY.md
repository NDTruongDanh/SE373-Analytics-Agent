---
phase: 01-monorepo-contracts-freeze
plan: 02
subsystem: contracts
tags: [zod, contracts, db-tools, sqlanswer, trace, semantic, benchmark, docs-generation]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Workspace layout, @se373/contracts shell with errors module + CONTRACTS_VERSION, barrel + test conventions"
provides:
  - "Five db-tool I/O schema pairs, SQLAnswer with citations + telemetry, trace envelope, semantic chunk metadata, benchmark row"
  - "Governance README (additive-only) and pnpm docs:interface generator producing docs/mcp_interface.md"
  - "Single-zod-copy lockfile regression guard"
affects: ["all later phases importing @se373/contracts", "UC-01 M3 contract freeze", "UC-02 resources", "UC-09/UC-10 cutovers"]

# Actuals (#2632) — same estimateTokens scale (chars/4 over realized diff)
actuals:
  tokens: 7637
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: ["zod v4 strict bounds on every free-text input (sql 20000, table 128, message 500)", "z.toJSONSchema() native docs generation (never zod-to-json-schema)", "createRequire-anchored zod resolution for root scripts under pnpm strict layout"]

key-files:
  created: ["packages/contracts/src/tools.ts", "packages/contracts/src/answers.ts", "packages/contracts/src/trace.ts", "packages/contracts/src/semantic.ts", "packages/contracts/src/benchmark.ts", "packages/contracts/README.md", "packages/contracts/test/tools.test.ts", "packages/contracts/test/schemas.test.ts", "packages/contracts/test/zod-singleton.test.ts", "scripts/generate-interface.mjs", "docs/mcp_interface.md"]
  modified: ["packages/contracts/src/index.ts", "package.json", "eslint.config.mjs"]

key-decisions:
  - "Tracer gate auto-continued: end-of-phase mode with automated-only verify re-ran green, logged expansion, no checkpoint"
  - "explain_query scoped schema:read (returns plan estimates, no row data); sample_rows and run_query scoped data:read"
  - "Generator resolves zod via createRequire anchored at packages/contracts/package.json (root has no hoisted zod under pnpm)"
  - "docs:interface repointed from dangling .ts path to scripts/generate-interface.mjs; eslint now ignores **/dist/"

patterns-established:
  - "Contract tests assert both acceptance and rejection edges (overlong input, over-count arrays, unknown enum)"
  - "Generated docs carry a do-not-hand-edit header and are reproduced byte-stable by pnpm docs:interface"

requirements-completed: [CONT-01, CONT-03, CONT-04, CONT-05, CONT-06]

# Coverage (#1602) — every deliverable proven by passing automated verification
coverage:
  - id: D1
    description: "list_tables + describe_table I/O schemas parse valid input, reject overlong names, import via barrel"
    requirement: "CONT-01"
    verification:
      - kind: unit
        ref: "packages/contracts/test/tools.test.ts (4 tests pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "explain/run/sample_rows pairs, SQLAnswer with citations + telemetry, trace envelope, semantic chunk metadata, benchmark row"
    requirement: "CONT-03"
    verification:
      - kind: unit
        ref: "packages/contracts/test/schemas.test.ts (5 tests pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "docs/mcp_interface.md regenerated from schemas naming all 5 tools and all error codes incl. RATE_LIMITED"
    requirement: "CONT-06"
    verification:
      - kind: other
        ref: "pnpm docs:interface + 6 greps (list_tables, describe_table, explain_query, run_query, sample_rows, RATE_LIMITED) all match"
        status: pass
    human_judgment: false
  - id: D4
    description: "Lockfile holds exactly one distinct zod@4 version key"
    requirement: "CONT-04"
    verification:
      - kind: unit
        ref: "packages/contracts/test/zod-singleton.test.ts (1 test passes)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Governance README states additive-only rule, camelCase canon, 11-code table, generated-docs pointer"
    requirement: "CONT-05"
    verification:
      - kind: other
        ref: "grep additive-only + CONTRACTS_VERSION in packages/contracts/README.md (2 and 2 hits)"
        status: pass
    human_judgment: false

# Metrics
duration: 3min
completed: 2026-10-25
status: complete
plan_head_before: b88c7f7f5c5f464423ace6c07ce2ccedb715a37d
plan_head_after: 87f69e21661520e085a0c00e5beb5dd2249db080
---

# Phase 1 Plan 2: Shared Contract Surface Freeze Summary

**Five db-tool I/O pairs, SQLAnswer with citations + telemetry, trace envelope, semantic chunk metadata, benchmark row, additive-only README, and a z.toJSONSchema docs generator — 14 tests green, typecheck/lint clean.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-10-25T12:26:37Z
- **Completed:** 2026-10-25T12:29:55Z
- **Tasks:** 3
- **Files modified:** 14

## Accomplishments

- `packages/contracts/src/tools.ts` — all 5 db-tool I/O pairs with explicit bounds (sql ≤ 20000, table ≤ 128, maxRows ≤ 1000 default 200, sample n ≤ 5 default 5, maskedColumns default [])
- `packages/contracts/src/answers.ts` — `SqlAttemptSchema` + `SQLAnswerSchema` (camelCase canon, attempts ≤ 3, preview ≤ 50, status exactly ok/no_data/cannot_answer/error, telemetry with prompt/completion/embedding tokens + cost + latency)
- `packages/contracts/src/trace.ts`, `semantic.ts`, `benchmark.ts` — runId-keyed event envelope, 6-doc_type chunk metadata with sensitivity enum, eval row shape for the later 30-question set
- `packages/contracts/README.md` — additive-only governance, camelCase rule with UC-02 snake_case mapping note, 11-code table (E10 = truncated flag, RATE_LIMITED reserved)
- `scripts/generate-interface.mjs` + `docs/mcp_interface.md` — `pnpm docs:interface` regenerates per-tool sections (scope note + input/output JSON schema), error table, worked run_query example
- `packages/contracts/test/zod-singleton.test.ts` — lockfile asserts exactly one `zod@4` version key

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end list_tables and describe_table schemas plus docs seed** - `ac5f0af` (feat)
2. **Task 2: Remaining tool, answer, trace, semantic, and benchmark schemas** - `dc0dea9` (feat)
3. **Task 3: Governance README, generated interface docs, zod-singleton guard** - `87f69e2` (feat)

**Plan metadata:** committed separately below (docs: complete plan).

## Files Created/Modified

- `packages/contracts/src/tools.ts` - 5 db-tool I/O pairs (List/Describe in Task 1 tracer slice; Explain/Run/Sample in Task 2)
- `packages/contracts/src/answers.ts` - SqlAttempt + SQLAnswer single answer contract
- `packages/contracts/src/trace.ts` - TraceEvent envelope (PRD 4.4 fields)
- `packages/contracts/src/semantic.ts` - SemanticChunkMetadata (UC-02 1.2, sensitivity aligned)
- `packages/contracts/src/benchmark.ts` - BenchmarkRow (PRD 2.2 row shape)
- `packages/contracts/src/index.ts` - Barrel re-exports for all six modules, CONTRACTS_VERSION 0.1.0 kept
- `packages/contracts/README.md` - Additive-only governance + naming rule + error table
- `packages/contracts/test/tools.test.ts` - Tracer round-trip (ghost_table_xyz case, 129-char rejection, sensitive flag, strict-input rejection)
- `packages/contracts/test/schemas.test.ts` - Edge rejections (4th attempt, 51-row preview, empty runId, expert difficulty) + maskedColumns default
- `packages/contracts/test/zod-singleton.test.ts` - One-zod-copy lockfile guard
- `scripts/generate-interface.mjs` - z.toJSONSchema generator (node builtins + zod only)
- `docs/mcp_interface.md` - Generated interface docs (never hand-edit)
- `package.json` - docs:interface repointed to the .mjs generator (deviation)
- `eslint.config.mjs` - Ignore nested dist output (deviation)

## Decisions Made

- Tracer feedback gate (Task 1): `human_verify_mode` is end-of-phase and the tracer `<verify>` carries only `<automated>` — re-ran verify green, logged `Tracer verified end-to-end — expanding`, continued with no checkpoint (checkpoints.md row 3)
- `explain_query` documented as `schema:read` scope (returns cost/row estimates and optional plan, no row data); `sample_rows` and `run_query` as `data:read`
- Generator resolves zod via `createRequire` anchored at `packages/contracts/package.json` — root `node_modules` has no hoisted zod under pnpm's strict layout, so a bare `import "zod"` from `scripts/` fails
- Status enum frozen at exactly 4 members (ok, no_data, cannot_answer, error) per CONTEXT.md; UC-01's needs_clarification/restricted and UC-02's snake_case variants deliberately excluded, documented in README

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Repointed docs:interface from dangling .ts path to the planned .mjs generator**
- **Found during:** Task 3 (pre-run check of `pnpm docs:interface`)
- **Issue:** Root `package.json` (written in 01-01) declared `tsx scripts/generate-interface.ts`, but that file was never created; the plan specifies `scripts/generate-interface.mjs`. Running the script as-declared would fail with missing file.
- **Fix:** Created `scripts/generate-interface.mjs` per plan and updated the package.json script to `tsx scripts/generate-interface.mjs`. No other scripts touched; `wiki:*` entries verbatim.
- **Files modified:** package.json, scripts/generate-interface.mjs
- **Verification:** `pnpm docs:interface` exits 0 and writes docs/mcp_interface.md; all 6 content greps match
- **Committed in:** 87f69e2 (Task 3 commit)

**2. [Rule 1 - Bug] Corrected lockfile relative path in zod-singleton test (../../.. not ../..)**
- **Found during:** Task 3 (writing test/zod-singleton.test.ts)
- **Issue:** Plan specified reading `../../pnpm-lock.yaml`, which from `packages/contracts/test/` resolves to `packages/pnpm-lock.yaml` — nonexistent. Repo root is three levels up.
- **Fix:** Test reads `../../../pnpm-lock.yaml` via `import.meta.url`-anchored join. Same match logic the plan specified (two-space-indented `zod@` keys, dedup, one entry starting `zod@4`); `zod-to-json-schema@` lines correctly excluded by the `^  zod@` anchor.
- **Files modified:** packages/contracts/test/zod-singleton.test.ts
- **Verification:** Test passes against the real lockfile (dedup set = [`zod@4.6.7:`])
- **Committed in:** 87f69e2 (Task 3 commit)

**3. [Rule 1 - Bug] ESLint ignore did not cover nested dist output**
- **Found during:** Task 3 (`pnpm lint` after new schemas)
- **Issue:** `ignores: ["dist/"]` matches only a top-level `dist/`; `packages/*/dist/*.d.ts` (tsc emit) was still linted, and the inferred `{}` type on `z.strictObject({})` tripped `@typescript-eslint/no-empty-object-type`, leaving the tree lint-red.
- **Fix:** Changed to `"**/dist/"`. Build output is gitignored and must never be linted; no source rule changes.
- **Files modified:** eslint.config.mjs
- **Verification:** `pnpm lint` exits 0 on the clean tree
- **Committed in:** 87f69e2 (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 bugs)
**Impact on plan:** All auto-fixes required for a green tree — docs generation, the singleton guard, and lint could not pass without them. No scope creep; no new dependencies; schema bounds and enum sets match the plan exactly.

## Issues Encountered

None beyond the deviations above — each surfaced on first run and was fixed inline with passing verification.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Full contract surface frozen and importable from `@se373/contracts`; plan 01-03 (CI, CODEOWNERS, package shells) can build directly on this barrel
- Watch item: `include: ["src"]` deviation from 01-01 still holds — package tests remain vitest-only, not tsc-checked
- docs/mcp_interface.md regenerates deterministically; any schema edit must re-run `pnpm docs:interface` before commit

---
*Phase: 01-monorepo-contracts-freeze*
*Completed: 2026-10-25*

## Self-Check: PASSED
