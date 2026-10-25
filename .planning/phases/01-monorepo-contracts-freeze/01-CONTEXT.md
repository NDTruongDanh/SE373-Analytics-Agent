# Phase 1: Monorepo + Contracts Freeze - Context

**Gathered:** 2026-10-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the docs-only repo into a pnpm TypeScript monorepo every UC owner builds in, and lock the shared zod contracts (`@se373/contracts`) that all packages import. Delivers: workspace layout, strict TS + project references, ESLint flat config with the DB-import ban, vitest, CI (typecheck + lint + test + gitleaks v3), CODEOWNERS, and generated `docs/mcp_interface.md`.

Not in this phase: Docker/Postgres/data (Phase 2), sqlGuard/executor (Phase 3), MCP server runtime (Phase 4), agent graph (Phase 5), trace writer/eval runner (Phase 6), web/api behavior (Phase 7). Packages for those layers are created as **empty, buildable shells** only.
</domain>

<decisions>
## Implementation Decisions

### Package naming
<user_decisions_scope>
- npm scope is **`@se373/*`** (user choice, 2026-10-25): `@se373/contracts`, `@se373/mcp-server`, `@se373/access-policy`, `@se373/agent`, `@se373/api`, `@se373/web`. Internal deps use `workspace:*`.
</user_decisions_scope>

### Contract governance after freeze
<user_decisions_governance>
- **Additive-only + review** (user choice): new optional fields or new schemas are allowed with 1 code-owner review; breaking changes (removing/renaming fields, tightening types, changing enum members, changing error codes) require a contracts major bump (`CONTRACTS_VERSION` constant + package version) and approval from every affected UC owner.
- The rule must be written down in `packages/contracts/README.md` and enforced at least by CODEOWNERS on `packages/contracts/`.
</user_decisions_governance>

### CODEOWNERS
<user_decisions_codeowners>
- **Placeholders now** (user choice): keep the existing global rule (`* @NDTruongDanh @HungPham-VNU`), add per-path lines for each package/folder with HungPham-VNU + NDTruongDanh as defaults and a `# TODO(UC-xx owner): add handle` comment naming the intended UC owner. `packages/mcp-server/`, `packages/access-policy/`, `policies/` → HungPham-VNU (UC-09 owner). Team fills real handles during PR review.
</user_decisions_codeowners>

### Research
- Phase research skipped (user choice); planner uses project research `.planning/research/STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`, `SUMMARY.md` as the technical source.

### the agent's Discretion
- Exact tsconfig layout (root `tsconfig.base.json` + per-package `tsconfig.json`, `tsc -b` solution file), build output strategy (emit to `dist/` vs source-first with `tsx`), vitest workspace/projects config, and ESLint rule set beyond the mandatory DB-import ban.
- Contract file split inside `packages/contracts/src/` (e.g. `tools.ts`, `errors.ts`, `answer.ts`, `trace.ts`, `semantic.ts`, `benchmark.ts`).
- Whether `explain_query` output includes plan JSON or only summary numbers (keep minimal; UC-07 may extend additively).
</decisions>

<specifics>
## Specific Ideas

- Versions are prescribed in `.planning/research/STACK.md` (verified 2026-10-25): Node 24, pnpm 11.25.0, `typescript@~6.0.3` (not 7), single `zod@^4.6.7`, eslint 10 flat + typescript-eslint 8.x, `vitest@^5`, `gitleaks/gitleaks-action@v3`. Use `z.toJSONSchema()` (never `zod-to-json-schema`). CI must assert exactly one zod copy in the lockfile.
- 11 error codes come verbatim from `docs/UC-plan/UC09.md` §A.7 (E1–E11): UNAUTHORIZED, SCOPE_DENIED, INVALID_PARAMS, INVALID_SQL, FORBIDDEN_STATEMENT, FORBIDDEN_FUNCTION, UNKNOWN_TABLE, SENSITIVE_COLUMN_DENIED, TIMEOUT, (E10 truncation is not an error), INTERNAL_ERROR — reconcile the count to 11 codes (add RATE_LIMITED reserved per F17, or another UC-09-documented code) and document the mapping.
- Tool output for `run_query`: `{columns, rows, rowCount, truncated, maskedColumns, durationMs}` (UC-09 §A.6 step 10).
- `SQLAnswerSchema`: UC-01 fields (`docs/UC-plan/UC01.md` §3.1, lines ~56–94) merged with UC-02 `citations: string[]` + telemetry (`docs/UC-plan/UC02.md` lines ~146–173). Status enum `ok | no_data | cannot_answer | error` (PRD UC-01).
- Benchmark row schema `{id, question, difficulty, gold_sql, gold_result_path, tags}` (PRD §2.2) may live in contracts now (used by Phase 6).
- The existing OpenWiki tooling (root `package.json` scripts `wiki:*`, `scripts/openwiki-fetch-patch.mjs`, `.github/workflows/openwiki-update.yml`) must keep working — root `package.json` gains workspace scripts without removing `wiki:*`.
- Existing CI workflow `openwiki-update.yml` must not be broken; the new CI workflow is a separate file (e.g. `.github/workflows/ci.yml`).
</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Contracts content
- `docs/UC-plan/UC09.md` — §0.3 monorepo layout, §A.6 run_query flow/output, §A.7 error table E1–E11, Phần B F0/F14
- `docs/UC-plan/UC01.md` — §2.2 tool contract, §3.1 `SQLAnswerSchema`, `SqlAttempt`, `TextToSqlState`
- `docs/UC-plan/UC02.md` — Feature 1.2 chunk metadata schema, Feature 5 `SQLAnswerSchema` extension (citations, telemetry)
- `docs/prd.md` — §2.2 benchmark JSONL, §4.1 tool table, §4.4 trace fields

### Stack and architecture
- `.planning/research/STACK.md` — pinned versions and what NOT to use
- `.planning/research/ARCHITECTURE.md` — package boundaries and allowed import directions
- `.planning/research/PITFALLS.md` — C6 (zod duplication), C8 (contract churn / team collisions)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Root `package.json` (ESM, `packageManager: pnpm@11.25.0`, engines node>=24) with `wiki:*` scripts and devDeps `openwiki`, `mermaid`, `jsdom`.
- `pnpm-workspace.yaml` exists with only `allowBuilds: better-sqlite3: true` — add `packages:` globs, keep `allowBuilds`.
- `.github/CODEOWNERS` has a single global rule; `ruleset-main.json` requires code-owner review on `main`.

### Established Patterns
- Node `--import` preload pattern used by wiki scripts; `.env` is gitignored, `.env.example` committed.

### Integration Points
- `.openwikiignore` read boundary — add `dist/` already present; new generated paths (e.g. `docs/mcp_interface.md` is source-derived and fine to read).
</code_context>

<deferred>
## Deferred Ideas

- Real UC owner GitHub handles in CODEOWNERS — filled by team during review.
- K7 coverage gap and UC-05 TS port — recorded in STATE.md, handled in Phase 7 docs.
</deferred>

---

*Phase: 01-monorepo-contracts-freeze*
*Context gathered: 2026-10-25*
