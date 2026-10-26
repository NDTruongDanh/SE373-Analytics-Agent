---
phase: "3"
slug: "sql-guard-read-only-executor"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-25"
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^5.0.5 (per-package projects via root `vitest.workspace.ts`) |
| **Config file** | `packages/sql-guard/vitest.config.ts` (new — parser warm-up setup) + existing `packages/mcp-server`, `packages/access-policy` configs |
| **Quick run command** | `pnpm --filter @se373/sql-guard test` / `pnpm --filter @se373/mcp-server test` / `pnpm --filter @se373/access-policy test` |
| **Full suite command** | `pnpm test` (must be green both with and without `DATABASE_URL`) |
| **Estimated runtime** | ~10 seconds (unit only; live suite skipped without `DATABASE_URL`) |

---

## Sampling Rate

- **After every task commit:** Run the affected package's quick command + `pnpm lint`
- **After every plan wave:** Run `pnpm test` (full workspace) + `pnpm typecheck`
- **Before `/gsd-verify-work`:** Full suite must be green, plus `pnpm typecheck` and `pnpm lint`
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

Filled by the planner/executor per task; requirement-level map from `03-RESEARCH.md` § Validation Architecture:

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| GUARD-01 | Single SelectStmt incl. WITH/UNION accepted; DDL/DML/multi-statement/SELECT INTO/FOR UPDATE/data-modifying CTE → `FORBIDDEN_STATEMENT` | unit | `pnpm --filter @se373/sql-guard test` | ❌ W0 | ⬜ pending |
| GUARD-02 | Denylisted functions (incl. `pg_catalog.`-qualified, case variants) → `FORBIDDEN_FUNCTION`; system schemas / unknown tables or columns → `UNKNOWN_TABLE` | unit | `pnpm --filter @se373/sql-guard test` | ❌ W0 | ⬜ pending |
| GUARD-03 | ≥30 guard cases green; guard importable from the agent path without any `pg` import | unit + lint | `pnpm --filter @se373/sql-guard test && pnpm lint` | ❌ W0 | ⬜ pending |
| GUARD-04 | Executor sequence BEGIN READ ONLY → SET LOCAL statement_timeout → cursor read(maxRows+1) → truncated → ROLLBACK → release always; output shape | unit (fakes) + live (auto-skip) | `pnpm --filter @se373/mcp-server test` | ❌ W0 | ⬜ pending |
| GUARD-05 | 57014 → `TIMEOUT`; no host/user/password/DSN/path/stack in any client-facing error (canary test) | unit | `pnpm --filter @se373/mcp-server test` | ❌ W0 | ⬜ pending |
| GUARD-06 | `AccessPolicy` / `ColumnScopePolicy` stub loads valid `policies/sensitive_columns.yaml`, throws on invalid; pass-through behavior | unit | `pnpm --filter @se373/access-policy test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/sql-guard/{package.json,tsconfig.json,vitest.config.ts,src/*.ts,test/guard.test.ts}` — GUARD-01/02/03
- [ ] Workspace wiring: root `tsconfig.json` reference, `vitest.workspace.ts` entry, `pnpm-workspace.yaml` `allowBuilds` += `@launchql/protobufjs` (install blocker found in research), `eslint.config.mjs` ban on `pg`/`pg-cursor` for `packages/sql-guard/**`, `.github/CODEOWNERS` line, `docs/architecture.md` updates, lockfile
- [ ] `packages/contracts/src/catalog.ts` — additive `SchemaCatalogSchema` + re-export + test (D-05)
- [ ] `packages/mcp-server/src/{db.ts,errors.ts}` + `test/{db.test.ts,errors.test.ts,db.live.test.ts}` (live file `describe.skipIf(!process.env.DATABASE_URL)`) — GUARD-04/05
- [ ] `packages/access-policy/src/{policy.ts,sensitive-columns.ts}` + tests; `policies/sensitive_columns.yaml` — GUARD-06
- [ ] Shared Olist-modelled fixture catalog for guard tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Executor against a real read-only Postgres role (timeout 57014, write rejected 25006) | GUARD-04, GUARD-05 | No Postgres/Docker until Phase 2 (D-04); live suite auto-skips | After Phase 2: set `DATABASE_URL` for `agent_ro`, run `pnpm --filter @se373/mcp-server test`, confirm `db.live.test.ts` runs (not skipped) and passes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
