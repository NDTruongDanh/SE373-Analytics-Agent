# Phase 3: SQL Guard + Read-Only Executor - Context

**Gathered:** 2026-10-25
**Status:** Ready for research and planning

<domain>
## Phase Boundary

Deliver the SQL safety layer as importable, tested code before any network transport exists:
the `sqlGuard` validator (pgsql-parser AST checks), the read-only query executor, the single
`sanitizeError()` choke point, and the `AccessPolicy` / `ColumnScopePolicy` plug-in seam wired to
`policies/sensitive_columns.yaml`. Requirements: GUARD-01..GUARD-06.

Not in this phase: MCP server/transport/auth (Phase 4), Postgres/Docker/roles/data loader (Phase 2),
full column masking with `resolveColumns` + AST rewrite/deparse (UC-09 v2 — `UC09-01`), PII
post-scan (`UC09-02`), audit log (Phase 4 MCP-05).
</domain>

<decisions>
## Implementation Decisions

### Package placement
- **D-01:** (user, 2026-10-25): `sqlGuard` lives in a **new pure package `@se373/sql-guard`** (`packages/sql-guard`): depends on `@se373/contracts` + `pgsql-parser` (+ AST traversal helper) only — **no DB driver**. Both `@se373/mcp-server` (authoritative enforcement) and `@se373/agent` (UC-01 local pre-flight) import it. The ESLint DB-import ban must keep passing: `@se373/sql-guard` must NOT be added to the banned list, and must itself never import `pg`/`pg-cursor`. Rationale: GUARD-03 requires owners to import the guard, but agent code is banned from importing `@se373/mcp-server`.
- **D-02:** The read-only executor (`pg` + `pg-cursor`), `sanitizeError()` and DB error-code mapping live in `@se373/mcp-server` (e.g. `src/db.ts`, `src/errors.ts`) — the only package allowed to touch the driver. `AccessPolicy` interface + `ColumnScopePolicy` stub live in `@se373/access-policy`.
- **D-03:** New package must be wired like the Phase 1 packages: `workspace:*` deps, `tsc -b` project reference, root `vitest.workspace.ts` entry, CODEOWNERS line (HungPham-VNU + NDTruongDanh, UC-09 owner), and `docs/architecture.md` §2/§3/§8 updated to list it (dependency direction: `sql-guard → contracts`; `mcp-server → sql-guard`; `agent → sql-guard`).

### Testing without a database
- **D-04:** (user): **Unit now, live later.** Executor behavior (BEGIN READ ONLY → SET LOCAL statement_timeout → cursor read(maxRows+1) → truncated flag → ROLLBACK → release in finally; 57014 → TIMEOUT; sanitized errors) is proven with unit tests against a fake/mock `pg` client. Live integration tests against real Postgres are written now but **auto-skip unless `DATABASE_URL` is set** (Phase 2 provides it); they must not fail CI when skipped. Docker is not installed and must not be required by this phase.

### Schema whitelist source
- **D-05:** (user): **Injected catalog.** `sqlGuard` takes a schema catalog as input (e.g. `{ tables: { [table]: string[] /* columns */ } }`, shape defined in this phase) rather than reading the DB or a static file. Tests use a fixture catalog modelled on the planned Olist tables (customers, orders, order_items, products, categories, sellers, payments, reviews, regions, channels, employees, promotions). Phase 2/4 build the real catalog from the DB later. If the catalog type is shared across packages, add it to `@se373/contracts` additively (CONTEXT governance: additive-only).

### Research
- **D-06:** (user): Run phase research first — verify pgsql-parser current API (async parse, WASM init once, AST JSON shapes for SelectStmt / InsertStmt / UpdateStmt / DeleteStmt / intoClause / lockingClause / FuncCall / RangeVar / ColumnRef / CommonTableExpr), version-to-PG-grammar mapping, deparse fidelity, and the full list of bypass vectors to test.

### the agent's Discretion
- Exact file split inside `packages/sql-guard/src/` and `packages/mcp-server/src/`.
- Function denylist contents beyond the required ones (`pg_sleep`, `pg_read_file`, `dblink*`, `lo_*`, `set_config`, `pg_terminate_backend`), and whether to use an allowlist of schemas (`public`/business) plus denylist of system schemas (`pg_catalog`, `information_schema`).
- Guard result shape (e.g. `{ ok: true, tables, columns } | { ok: false, error: DbToolError }`), as long as errors use contract codes.
</decisions>

<specifics>
## Specific Ideas

- Error codes come from `@se373/contracts` (`FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION`, `UNKNOWN_TABLE`, `INVALID_SQL`, `TIMEOUT`, `INTERNAL_ERROR`, `SENSITIVE_COLUMN_DENIED`); `INVALID_SQL` should carry a parser position (cursorPosition) without infrastructure details (UC-09 §A.7 E4).
- Executor output must match `RunQueryOutputSchema` (`{columns, rows, rowCount, truncated, maskedColumns, durationMs}`); `maskedColumns` is `[]` until masking lands.
- ≥30 guard test cases (GUARD-03), covering at minimum UC-09 §B.1 "Chặn SQL" rows: `DELETE FROM orders`, `SELECT 1; DROP TABLE orders`, `WITH x AS (DELETE … RETURNING *) SELECT …`, `SELECT pg_sleep(600)`, `SELECT pg_read_file('/etc/passwd')`, `describe_table("orders; --")`-style identifiers, plus SELECT INTO, FOR UPDATE, system schemas, unknown table/column, UNION/WITH valid cases, comments, case variations, quoted identifiers.
- `policies/sensitive_columns.yaml` (new): `customers.phone`, `customers.email`, `customers.address`, `employees.salary`; zod-validated at load; invalid config throws.
- Pitfalls to honor: `.planning/research/PITFALLS.md` C2 (first-keyword guards bypassable — recursive AST walk), C4 (parser WASM init once, pin version, `stmts.length === 1`, full-tree walk, fail closed).
</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `docs/UC-plan/UC09.md` — §0.1–0.2 (pgsql-parser notes), §A.6 run_query flow, §A.7 error table, Phần B F2/F3/F7/F9, §B.1 eval cases
- `docs/architecture.md` — layers, dependency directions, contracts (update for D-01/D-03)
- `packages/contracts/src/{errors,tools}.ts` — error codes, `RunQueryOutputSchema`
- `.planning/research/STACK.md` — pinned versions (pgsql-parser, @pgsql/traverse, pg, pg-cursor)
- `.planning/research/PITFALLS.md` — C1, C2, C4
- `.planning/phases/01-monorepo-contracts-freeze/01-0{1,2,3}-SUMMARY.md` — workspace patterns and deviations (tsconfig include src-only, vitest workspace, eslint config)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@se373/contracts`: `ErrorCodes`, `DbToolErrorSchema`, `dbToolError()`, `RunQuery*Schema`.
- Phase 1 package template: `packages/<name>/{package.json,tsconfig.json,src/index.ts,test/*.test.ts}`; root `tsconfig.json` references; `vitest.workspace.ts`; `eslint.config.mjs` ban block for `packages/agent/**` and `apps/**`.

### Integration Points
- `packages/mcp-server` and `packages/access-policy` are empty shells with one marker test each.
- `.github/CODEOWNERS` per-path lines; `docs/architecture.md` (team-facing).
</code_context>

<deferred>
## Deferred Ideas

- Full `ColumnScopePolicy` enforcement with `resolveColumns` + masking rewrite (UC09-01, UC-09 milestone).
- Live executor tests become mandatory once Phase 2 provides `DATABASE_URL` and the `agent_ro` role.
</deferred>

---

*Phase: 03-sql-guard-read-only-executor*
*Context gathered: 2026-10-25*
