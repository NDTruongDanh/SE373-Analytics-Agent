# Phase 3: SQL Guard + Read-Only Executor - Research

**Researched:** 2026-10-26
**Domain:** PostgreSQL AST validation (pgsql-parser), read-only query execution (pg + pg-cursor), error sanitization, YAML policy seam
**Confidence:** HIGH (every load-bearing API empirically verified this session with a real install in /tmp; versions confirmed via `npm view`)

## Summary

Phase 3 builds the SQL safety layer as importable library code before any network transport exists: a pure `sqlGuard` validator in a new `@se373/sql-guard` package (pgsql-parser AST allowlist + recursive traversal), a read-only executor plus single `sanitizeError()` choke point in `@se373/mcp-server`, and an `AccessPolicy`/`ColumnScopePolicy` stub with zod-validated `policies/sensitive_columns.yaml` in `@se373/access-policy`. All load-bearing APIs were verified empirically: `parse` is async and self-initializing but `parseSync` throws cold (`WASM module not initialized`) so a one-line warm-up (`await parse('SELECT 1')`) at startup/test-setup is mandatory; `stmts.length === 1` plus a root-`SelectStmt` check plus recursive walk of CTEs/subqueries for DML, `intoClause`, `lockingClause`, and schema-qualified `FuncCall.funcname` covers every C2 bypass vector; `client.query(new Cursor(...))` → `cursor.read(maxRows+1)` → `cursor.close()` → `ROLLBACK` → `client.release()` in `finally` is the exact executor shape with promise-based fakes trivially injectable for unit tests; live-DB tests auto-skip via `describe.skipIf(!process.env.DATABASE_URL)` (verified present in vitest 5.0.5). One hard install blocker was found and solved: `pgsql-parser`/`@pgsql/traverse` transitively pull `@launchql/protobufjs` (postinstall script), which makes `pnpm install` fail under the repo's pnpm v11 `allowBuilds` gate — the plan must add `@launchql/protobufjs: true` to `allowBuilds` (same pattern as the Phase 1 esbuild deviation).

**Primary recommendation:** Use `pgsql-parser@18.3.1` + `@pgsql/traverse@18.8.1` `walk()` (visitor object) for the guard, `pg@8.23.1` + `pg-cursor@2.22.1` for the executor, structural fake interfaces for unit tests with live tests gated on `DATABASE_URL`, and put the shared `SchemaCatalog` zod schema in `@se373/contracts` additively.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01** (user, 2026-10-25): `sqlGuard` lives in a **new pure package `@se373/sql-guard`** (`packages/sql-guard`): depends on `@se373/contracts` + `pgsql-parser` (+ AST traversal helper) only — **no DB driver**. Both `@se373/mcp-server` (authoritative enforcement) and `@se373/agent` (UC-01 local pre-flight) import it. The ESLint DB-import ban must keep passing: `@se373/sql-guard` must NOT be added to the banned list, and must itself never import `pg`/`pg-cursor`. Rationale: GUARD-03 requires owners to import the guard, but agent code is banned from importing `@se373/mcp-server`.
- **D-02**: The read-only executor (`pg` + `pg-cursor`), `sanitizeError()` and DB error-code mapping live in `@se373/mcp-server` (e.g. `src/db.ts`, `src/errors.ts`) — the only package allowed to touch the driver. `AccessPolicy` interface + `ColumnScopePolicy` stub live in `@se373/access-policy`.
- **D-03**: New package must be wired like the Phase 1 packages: `workspace:*` deps, `tsc -b` project reference, root `vitest.workspace.ts` entry, CODEOWNERS line (HungPham-VNU + NDTruongDanh, UC-09 owner), and `docs/architecture.md` §2/§8 updated to list it (dependency direction: `sql-guard → contracts`; `mcp-server → sql-guard`; `agent → sql-guard`).
- **D-04** (user): **Unit now, live later.** Executor behavior (BEGIN READ ONLY → SET LOCAL statement_timeout → cursor read(maxRows+1) → truncated flag → ROLLBACK → release in finally; 57014 → TIMEOUT; sanitized errors) is proven with unit tests against a fake/mock `pg` client. Live integration tests against real Postgres are written now but **auto-skip unless `DATABASE_URL` is set** (Phase 2 provides it); they must not fail CI when skipped. Docker is not installed and must not be required by this phase.
- **D-05** (user): **Injected catalog.** `sqlGuard` takes a schema catalog as input (e.g. `{ tables: { [table]: string[] /* columns */ } }`, shape defined in this phase) rather than reading the DB or a static file. Tests use a fixture catalog modelled on the planned Olist tables (customers, orders, order_items, products, categories, sellers, payments, reviews, regions, channels, employees, promotions). Phase 2/4 build the real catalog from the DB later. If the catalog type is shared across packages, add it to `@se373/contracts` additively (CONTEXT governance: additive-only).
- **D-06** (user): Run phase research first — verify pgsql-parser current API (async parse, WASM init once, AST JSON shapes for SelectStmt / InsertStmt / UpdateStmt / DeleteStmt / intoClause / lockingClause / FuncCall / RangeVar / ColumnRef / CommonTableExpr), version-to-PG-grammar mapping, deparse fidelity, and the full list of bypass vectors to test.

### Agent's Discretion
- Exact file split inside `packages/sql-guard/src/` and `packages/mcp-server/src/`.
- Function denylist contents beyond the required ones (`pg_sleep`, `pg_read_file`, `dblink*`, `lo_*`, `set_config`, `pg_terminate_backend`), and whether to use an allowlist of schemas (`public`/business) plus denylist of system schemas (`pg_catalog`, `information_schema`).
- Guard result shape (e.g. `{ ok: true, tables, columns } | { ok: false, error: DbToolError }`), as long as errors use contract codes.

### Deferred Ideas (OUT OF SCOPE)
- Full `ColumnScopePolicy` enforcement with `resolveColumns` + masking rewrite (UC09-01, UC-09 milestone).
- PII post-scan regex layer on results (`piiScanHit`).
- Live executor tests become mandatory once Phase 2 provides `DATABASE_URL` and the `agent_ro` role.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| GUARD-01 | `sqlGuard` accepts exactly one `SelectStmt` (incl. WITH/UNION), rejects DDL/DML, multi-statements, `SELECT INTO`, `FOR UPDATE`, data-modifying CTEs with `FORBIDDEN_STATEMENT` | §Standard Stack (pgsql-parser 18.3.1, verified AST shapes) + §Architecture Patterns (allowlist algorithm) + bypass-vector table rows 1–20 |
| GUARD-02 | Rejects denylisted functions with `FORBIDDEN_FUNCTION`, system schemas / unknown tables-or-columns with `UNKNOWN_TABLE` | FuncCall.funcname shape incl. schema-qualified (verified probe), denylist table, catalog-lookup normalization rule |
| GUARD-03 | ≥30 vitest cases (malicious + valid); importable as library for local pre-flight | vitest 5.0.5 WASM compat verified (2/2 pass); 38-case bypass list; pure-package wiring (D-03 checklist) |
| GUARD-04 | Read-only executor `BEGIN READ ONLY` → `SET LOCAL statement_timeout` → cursor `read(maxRows+1)` → `ROLLBACK`, returns `{columns, rows, rowCount, truncated, durationMs}`, always releases | pg 8.23.1 + pg-cursor 2.22.1 API verified; executor pseudocode; fake-interface design |
| GUARD-05 | Timeouts → `TIMEOUT` (PG 57014); all DB errors through one `sanitizeError()` with no host/user/DSN/path/stack leakage | PG code map verified against PG 18 errcodes appendix; redaction patterns; choke-point placement |
| GUARD-06 | `AccessPolicy` interface + pass-through/fail-closed `ColumnScopePolicy` stub wired to `policies/sensitive_columns.yaml` | yaml 2.9.1; zod loader shape; stub interface; fail-closed rule for unresolvable refs |
</phase_requirements>

## Project Constraints (from AGENTS.md)

The repo `AGENTS.md` contains only the OpenWiki evidence-index notice (no build/test/lint directives beyond what CI already enforces). Actionable directives for this phase:
- Do NOT hand-edit generated `openwiki/` pages; prefer changing source code/docs and letting OpenWiki regenerate. (No wiki changes are needed in Phase 3.)
- Treat source code and tests as authoritative; preserve complete failure output when validating.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| SQL AST validation (`sqlGuard`) | Library (`@se373/sql-guard`, pure, no I/O) | — | Must be importable by both server (enforcement) and agent (pre-flight); purity keeps the ESLint trust boundary intact |
| Read-only execution + timeout + truncation | Backend data plane (`@se373/mcp-server`) | — | Only package allowed to touch `pg`/`pg-cursor`; owns connection lifecycle |
| Error sanitization (`sanitizeError`) | Backend data plane (`@se373/mcp-server`) | — | Single choke point next to the driver; every DB error path funnels through it |
| Column policy seam (`AccessPolicy`/`ColumnScopePolicy`) | Library (`@se373/access-policy`, pure) | — | Policy is a pure function of AST + scopes + YAML config; no DB I/O, pluggable by UC-08 later |
| Sensitive-column config (`sensitive_columns.yaml`) | Config (`policies/`, zod-validated at load) | — | Declarative, reviewed by UC-09 owners via CODEOWNERS; invalid config refuses to load |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pgsql-parser` | `^18.3.1` [VERIFIED: npm registry] (`latest` dist-tag; grammar line 18; bundles `libpg-query@18.2.1` + `pgsql-deparser@18.4.1` as deps) [VERIFIED: probe /tmp/p3probe] | Real-Postgres parse + deparse for `sqlGuard` | Real PG grammar (libpg_query WASM), not a regex/keyword classifier; async `parse` self-initializes; battle-tested per maintainers; STACK.md already pins this line |
| `@pgsql/traverse` | `^18.8.1` [VERIFIED: npm registry] | Recursive AST walk for guard checks | Same-repo visitor API (`walk(ast, {SelectStmt, FuncCall, RangeVar, …})`) with statement context (`stmtTag`, `isWrite`); replaces hand-rolled recursion (PITFALLS C2/C4) |
| `pg` | `^8.23.1` [VERIFIED: npm registry] | `Pool` for executor (`pool.connect()` → `client.release()`) | Stable driver; matches checkpoint-postgres era pins; `pg-pool@3.14.0` transitive attaches `client.release` (verified in source) |
| `pg-cursor` | `^2.22.1` [VERIFIED: npm registry] | Bounded reads: `client.query(cursor)` → `cursor.read(maxRows+1)` → `cursor.close()` | Exact UC-09 F2 mechanism; `read`/`close` return promises when no callback is passed (verified in source + `@types/pg-cursor@2.7.2`) |
| `yaml` | `^2.9.1` [VERIFIED: npm registry] | Parse `policies/sensitive_columns.yaml` | STACK.md pin; validate parsed YAML with zod at load, refuse on invalid config |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/pg` | `^8.23.1` (dev) [VERIFIED: npm registry] | Driver types incl. `Submittable` overload for `client.query(cursor)` | mcp-server devDeps; version-matched to `pg` |
| `@types/pg-cursor` | `^2.7.2` (dev; lags lib major, API-stable `read`/`close`) [VERIFIED: npm registry + probe /tmp/p3types] | `export = Cursor` class type; `Cursor(rowMode/types)` config | mcp-server devDeps; `import Cursor from 'pg-cursor'` under `esModuleInterop` |
| `zod` | `^4.6.7` (existing workspace pin) | `SchemaCatalogSchema`, `SensitiveColumnsSchema` | Already the single shared copy; contracts additive-only |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@pgsql/traverse` walk | Hand-written recursive walker | Hand-rolled risks missing node types on parser upgrades; `walk` + per-tag unit tests is the documented guard pattern. Only hand-roll if traverse's `pg-proto-parser` dep chain becomes a problem (it is the `allowBuilds` trigger — accepted, see Pitfalls) |
| `pgsql-parser@18` (grammar line 18) | `@pgsql/parser@1.6.2` multi-version (`new Parser({version: 16})`) | Exact PG16 grammar parity; but separate deparse story and contradicts STACK.md pin. Line-18 grammar is a *superset* of PG16 — fail-safe direction (passes guard, fails cleanly at execution), never a bypass |
| `pg-cursor` bounded read | `LIMIT`-rewrite + plain `client.query` | Rewriting SQL changes semantics and needs deparse; cursor preserves the exact guarded statement. Use cursor |
| `yaml` | `js-yaml` | `yaml` (eemeli) is the STACK.md pin and what UC-09 specifies; no reason to switch |

**Installation:**

```bash
# sql-guard (pure: NO pg/pg-cursor — enforced by new eslint scope, see Patterns)
pnpm --filter @se373/sql-guard add @se373/contracts@workspace:* pgsql-parser@^18.3.1 @pgsql/traverse@^18.8.1
# mcp-server executor + sanitizeError + policy wiring
pnpm --filter @se373/mcp-server add pg@^8.23.1 pg-cursor@^2.22.1 yaml@^2.9.1 zod@^4.6.7 @se373/sql-guard@workspace:* @se373/access-policy@workspace:*
pnpm --filter @se373/mcp-server add -D @types/pg@^8.23.1 @types/pg-cursor@^2.7.2
# access-policy YAML loader
pnpm --filter @se373/access-policy add yaml@^2.9.1 zod@^4.6.7
```

**pnpm `allowBuilds` (REQUIRED, blocks install otherwise):** add to `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  better-sqlite3: true # existing
  esbuild: true        # existing (Phase 1 deviation)
  "@launchql/protobufjs": true # NEW — transitive via pgsql-parser/pgsql-deparser → plpgsql-deparser → pg-proto-parser; postinstall is a benign version-scheme warning check (verified source scripts/postinstall.js: exits early without versionScheme)
```

Proven this session: `pnpm i pgsql-parser@18.3.1` AND `pnpm i @pgsql/traverse@18.8.1` both fail with `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @launchql/protobufjs@7.2.6` on pnpm 11.25.0 [VERIFIED: probe /tmp/p3pnpm]. `libpg-query` itself ships prebuilt WASM (`files: ["wasm/*"]`, no install script) — no build approval needed for it.

## Package Legitimacy Audit

(Evidence: `npm view` versions + `time.created` + `repository.url` this session; all are long-lived official repos. The `gsd_run query package-legitimacy` seam is not runnable from this environment — planner should treat `OK` below as registry-evidence-backed, not seam-stamped.)

| Package | Registry | Age (first publish) | Source Repo | Verdict | Disposition |
|---------|----------|---------------------|-------------|---------|-------------|
| `pgsql-parser`@18.3.1 | npm | 2018-08-07 | github.com/constructive-io/pgsql-parser | OK | Approved — official parser package of the pgsql-parser monorepo |
| `@pgsql/traverse`@18.8.1 | npm | 2025-07-01 | github.com/constructive-io/pgsql-parser (same monorepo) | OK | Approved — same-repo traversal companion, version line 18 matches parser AST |
| `pg`@8.23.1 | npm | 2010-12-19 | github.com/brianc/node-postgres | OK | Approved — canonical Node Postgres driver |
| `pg-cursor`@2.22.1 | npm | 2013-10-07 | github.com/brianc/node-postgres (same org) | OK | Approved — canonical cursor extension |
| `@types/pg-cursor`@2.7.2 | npm | 2022-03-29 (DT entry) | DefinitelyTyped | OK | Approved — only types package; API surface (`read`/`close`) verified against lib source |
| `yaml`@2.9.1 | npm | 2011-04-15 | github.com/eemeli/yaml | OK | Approved — canonical YAML parser, STACK.md pin |

**Packages removed due to SLOP:** none.
**Packages flagged as SUSPICIOUS:** none.

## Architecture Patterns

### System Architecture Diagram

```
agent / owner code (UC-01 pre-flight)          mcp-server (authoritative, Phase 3 parts)
        │                                                     │
        │ import @se373/sql-guard                             │  src/db.ts        src/errors.ts
        ▼                                                     ▼         │
┌───────────────────────┐   {ok|error}    ┌──────────────────────────────────────┐
│ sqlGuard(sql, catalog) │◄────────────────│ executor.runQuery(sql, maxRows, opts) │
│  1. await parse (warm) │                 │  1. pool.connect()                  │
│  2. stmts.length===1   │                 │  2. BEGIN READ ONLY                 │
│  3. root is SelectStmt │                 │  3. SET LOCAL statement_timeout     │
│  4. walk full tree:    │  deny table     │  4. cursor.read(maxRows+1)           │
│     DML/Merge/Copy/    │  ┌──────────────│  5. truncated flag + slice          │
│     Txn/VarSet/Explain │  │              │  6. cursor.close + ROLLBACK          │
│     intoClause,        │  │              │  7. release() in finally (always)   │
│     lockingClause,     ▼  ▼              │  8. on error → sanitizeError()      │
│     FuncCall denylist │ AccessPolicy    │         │                           │
│  5. catalog whitelist │ stub (yaml      └─────────┼───────────────────────────┘
│     tables + columns  │ loaded+validated)         ▼
└───────────────────────┘                     {columns, rows, rowCount,
                                               truncated, maskedColumns: [],
                                               durationMs} | DbToolError
```

Trace order per call (enforced in code): guard → policy → executor → sanitize-on-error. Executor never runs unguarded SQL (guard is called inside `runQuery`, not left to callers).

### Recommended Project Structure

```
packages/sql-guard/
├── package.json          # deps: contracts(workspace:*), pgsql-parser, @pgsql/traverse; NO pg/pg-cursor/yaml
├── tsconfig.json         # composite, rootDir src, include ["src"], references: [contracts]
├── src/
│   ├── index.ts          # re-exports sqlGuard, warmupSqlGuard, types
│   ├── guard.ts          # sqlGuard(sql, catalog): GuardResult (parse + allowlist walk + catalog check)
│   └── denylist.ts       # FORBIDDEN_FUNCTION names (lowercased last-segment match) + system schemas
├── test/
│   └── guard.test.ts     # ≥30 cases (malicious + valid) + fixture catalog (Olist-modelled)
└── vitest.config.ts      # setupFiles: warm-up (or beforeAll warmup in test file)

packages/mcp-server/src/
├── db.ts                 # PoolLike/ClientLike/CursorLike structural interfaces + runQuery executor
└── errors.ts             # sanitizeError(err): DbToolError + PG-code→contract-code map

packages/access-policy/src/
├── index.ts              # AccessPolicy interface + ColumnScopePolicy stub re-exports
├── policy.ts             # interface + stub class (pass-through allow; constructor validates config)
└── sensitive-columns.ts  # loadSensitiveColumns(yamlText) pure + loadSensitiveColumnsFile(path) IO wrapper

policies/
└── sensitive_columns.yaml  # version: 1, columns: [{table, column}] — customers.phone/email/address, employees.salary
```

### Pattern 1: AST allowlist guard (single-statement SelectStmt + full-tree walk)

**What:** Parse once with async `parse`; require `stmts.length === 1` and root key `SelectStmt`; then `walk()` the *entire* `ParseResult` with a visitor that denies statement tags, `intoClause`, `lockingClause`, denylisted `FuncCall`, system-schema/unknown `RangeVar`, and unknown `ColumnRef` against the injected catalog. Anything not explicitly allowed → `FORBIDDEN_STATEMENT` (fail closed).
**When to use:** Always — this is `sqlGuard`'s core algorithm (GUARD-01/02).

```typescript
// Source: verified probe against pgsql-parser@18.3.1 + @pgsql/traverse@18.8.1 (/tmp/p3probe)
import { parse } from "pgsql-parser";
import { walk } from "@pgsql/traverse";

export async function warmupSqlGuard(): Promise<void> {
  await parse("SELECT 1"); // WASM init once; async parse self-waits, parseSync would throw cold
}

const ast = await parse("WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x");
// ast = { version: 180004, stmts: [{ stmt: { SelectStmt: { withClause: { ctes: [
//   { CommonTableExpr: { ctequery: { DeleteStmt: {...} } } } ] }, ... } } }] }
walk(ast, {
  DeleteStmt: (_path, ctx) => ctx.abort("FORBIDDEN_STATEMENT"), // fires inside the CTE too
  FuncCall: (path, ctx) => {
    const parts = (path.node.funcname as { String: { sval: string } }[]).map((p) => p.String.sval.toLowerCase());
    if (DENYLIST.has(parts[parts.length - 1])) ctx.abort("FORBIDDEN_FUNCTION"); // catches pg_catalog.pg_sleep
  },
});
```

Verified AST facts the planner must encode [VERIFIED: probe /tmp/p3scripts/probe1-6.js]:
- Envelope: `{ version: 180004, stmts: [{ stmt: { <Tag>: {...} } }] }`. Root tag = `Object.keys(stmts[i].stmt)[0]`.
- `SELECT 1; DROP TABLE orders` → `stmts.length === 2`, kinds `[SelectStmt, DropStmt]` — the length check alone kills stacked statements; comments do NOT merge statements (`SELECT 1; -- x\nDROP TABLE orders` still yields 2).
- `UNION` → `SelectStmt{op: 'SETOP_UNION', larg, rarg}` (no top-level targetList) — walk covers both branches automatically.
- `WITH` → `SelectStmt.withClause.ctes[].CommonTableExpr.ctequery` holds the inner statement (`DeleteStmt` verified inside CTE).
- `SELECT … INTO t` → `SelectStmt.intoClause = { rel: { relname }, onCommit }` (also `INTO TEMP`, `INTO UNLOGGED`).
- `FOR UPDATE/SHARE[/NOWAIT]` → `SelectStmt.lockingClause = [{ LockingClause: { strength, waitPolicy } }]`.
- `FuncCall.funcname = [{String:{sval:'pg_sleep'}}]`; schema-qualified = two entries (`pg_catalog`, `pg_sleep`) — match on **lowercased last segment**.
- `RangeVar = { schemaname?, relname, alias? }`; `FROM public.orders AS o` verified shape. `ColumnRef.fields = [{String:{sval}}…]` or `[{A_Star:{}}]` for `*`. `RangeSubselect = { lateral, subquery, alias }`.
- Non-SELECT roots parse to distinct tags — deny by allowlisting only `SelectStmt`: `TransactionStmt` (BEGIN/COMMIT/ROLLBACK/START), `VariableSetStmt` (SET/SET LOCAL/RESET/SET ROLE/SET SESSION AUTHORIZATION), `VariableShowStmt` (SHOW), `ExplainStmt` (incl. ANALYZE variant), `CopyStmt`, `CreateStmt` (incl. TEMP), `DropStmt`, `TruncateStmt`, `GrantStmt`, `ListenStmt`, `NotifyStmt`, `MergeStmt`, `PrepareStmt`, `ExecuteStmt`, `DeallocateStmt`.
- Grammar conveniences that parse as `SelectStmt` root: `TABLE orders`, `VALUES (1,2)` — recommend ALLOW (harmless reads; `TABLE t` ≡ `SELECT * FROM t`).
- Parse errors: `SqlError` with `.sqlDetails = { message, cursorPosition: 12, fileName, functionName, lineNumber }` [VERIFIED: probe3] — `cursorPosition` feeds `INVALID_SQL` per UC-09 §A.7 E4.
- `deparse(ParseResult) → string` (pretty-prints, NOT byte-identical); `deparse(string)` throws `Deparser does not handle node type: 0` — always pass the AST. Deparse is only needed later (masking rewrite, UC09-01); Phase 3 needs no deparse.
- `@pgsql/traverse` `walk` second arg `ctx: { stmtTag, stmtIndex, isWrite, isRead, insideFunction, functionName, abort }` [VERIFIED: probe4 + walk.d.ts]; returning `false` skips children, `ctx.abort(reason)` stops everything and returns `{ aborted, reason, reasons }`. `READ_STATEMENTS = {SelectStmt, ExplainStmt, DeclareCursorStmt, FetchStmt}`, `WRITE_STATEMENTS = {Insert,Update,Delete,Merge,Truncate,Copy}` — note: do NOT rely on these sets alone (ExplainStmt is "read" but must be denied); use explicit tag allowlist.

### Pattern 2: Read-only executor (cursor + SET LOCAL + always-release)

**What:** `pool.connect()` → `BEGIN READ ONLY` → `SET LOCAL statement_timeout` (validated integer, interpolated — `SET LOCAL` takes no bind params) → `client.query(new Cursor(sql))` → `cursor.read(maxRows+1)` → `truncated` + slice → `cursor.close()` → `ROLLBACK`; `client.release()` in `finally`. Map `err.code === '57014'` → `TIMEOUT`; everything else → `sanitizeError()`.
**When to use:** `runQuery` implementation in `mcp-server/src/db.ts` (GUARD-04/05).

```typescript
// Source: pg@8.23.1 (pg-pool@3.14.0, lib/client.js, lib/pool) + pg-cursor@2.22.1 + @types/pg-cursor@2.7.2 — all verified
import { Pool } from "pg";            // named import from CJS works
import Cursor from "pg-cursor";       // DEFAULT import (module.exports = Cursor)

const client = await pool.connect();  // pg-pool attaches client.release()
try {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = '${timeoutMs}'`); // timeoutMs: validated int
  const cursor = client.query(new Cursor(sql)); // Submittable overload → returns the cursor
  const rows = await cursor.read(maxRows + 1);
  const truncated = rows.length > maxRows;
  const page = rows.slice(0, maxRows);
  await cursor.close();
  await client.query("ROLLBACK");
  return { columns: page.length ? Object.keys(page[0]!) : [], rows: page, rowCount: page.length, truncated, maskedColumns: [], durationMs: Date.now() - start };
} finally {
  client.release();
}
```

Verified facts [VERIFIED: probe /tmp/p3probe + /tmp/p3types]:
- `pg` has no `type: module`/`exports` map — CJS with `main: ./lib`; `import { Pool } from "pg"` works via CJS named-export interop (standard pattern).
- `pg-cursor` is `module.exports = Cursor` — ESM/TS **must** use default import (`import Cursor from "pg-cursor"`; works with repo `esModuleInterop: true`).
- `client.query(cursor)` is typed in `@types/pg` as `query<T extends Submittable>(queryStream: T): T`; `Cursor` structurally satisfies `Submittable` (`submit(connection)`).
- `read(n)`/`close()` return promises when called without callbacks (verified source `read(rows, cb)` / `close(cb)` promise branches).
- First `read` via callback form also yields `result.fields[].name` — recommend capturing columns from `fields` (covers the zero-row case where `Object.keys` has nothing); planner may simplify to `Object.keys` + document the empty-result column limitation, since Phase 4 `describe_table` covers schema discovery.
- `pool.connect()` clients carry `.release()` (pg-pool source line ~342); `Pool` itself has no `release` — always `connect → release`, never `pool.query` for this path (cursor needs a dedicated client).

### Pattern 3: Single `sanitizeError()` choke point

**What:** One function `(err: unknown) => DbToolError` in `mcp-server/src/errors.ts` owning the PG-code→contract-code map and all redaction. No other file formats DB errors for output.
**When to use:** Every `catch` around `pool.connect`/queries/cursor ops; later reused by all 5 tools (Phase 4).

PG-code map (codes [CITED: https://www.postgresql.org/docs/current/errcodes-appendix.html], fetched PG 18 table this session):

| PG `err.code` | Meaning (Condition Name) | Contract code |
|---------------|--------------------------|---------------|
| `57014` | `query_canceled` (statement_timeout) | `TIMEOUT` (retryable) |
| `42601` | `syntax_error` | `INVALID_SQL` |
| `42P01` / `42703` | `undefined_table` / `undefined_column` | `UNKNOWN_TABLE` (per CONTEXT: columns map here too) |
| `25006` | `read_only_sql_transaction` | `FORBIDDEN_STATEMENT` (write slipped past guard — grant layer caught it) |
| `42501` | `insufficient_privilege` | `FORBIDDEN_STATEMENT` |
| `28P01` | `invalid_password` | `INTERNAL_ERROR` (retryable; never echo which credential failed) |
| `3D000` / `3F000` | `invalid_catalog_name` / `invalid_schema_name` | `UNKNOWN_TABLE` |
| `25P02` | `in_failed_sql_transaction` (query after prior error w/o ROLLBACK) | `INTERNAL_ERROR` — executor always ROLLBACKs so this indicates a bug |
| `40001` / `40P01` | `serialization_failure` / `deadlock_detected` | `INTERNAL_ERROR` (retryable) |
| `53xxx` (`53200/53300/53400`), `57P03`, `08000/08001/08003/08006/08P01` (class 08 connection) | resource/connection failures | `INTERNAL_ERROR` (retryable) |
| anything else / non-`code` errors | — | `INTERNAL_ERROR` (retryable) |

Redaction (applied to `message`, `detail`, `hint` before composing the output message; `stack` never leaves the process):
- `postgres(ql)?://[^\s"']+` → `postgres://<redacted>` (kills user, password, host, port, dbname in one pattern)
- bare host/IP: `\b\d{1,3}(\.\d{1,3}){3}\b` and `host=…` fragments → `<redacted>`
- file paths: `/\/[\w.\-/~]+(\.\w{1,5})?/` in messages mentioning `file|directory|path|data directory` → `<redacted-path>` (careful: `/` division in SQL must NOT be redacted — only apply path pattern when the field is `detail`/`hint` or the message matches file-context keywords; safest: redact paths only in `detail`/`hint`, never in `message`)
- `at … (…:line:col)` stack-frame lines → dropped; `Error.stack` never included
- Cap final message at 500 chars (`DbToolErrorSchema` max, verified contracts/src/errors.ts:20-27 [VERIFIED: packages/contracts/src/errors.ts:20-27] — quote: `code: z.enum(ErrorCodes)`, `message: z.string().min(1).max(500)`, `retryable: z.boolean()`)

### Pattern 4: Injected catalog + pass-through policy stub

**What:** `sqlGuard(sql, catalog: SchemaCatalog)` — catalog is a plain object, never read from disk/DB by the guard (D-05). `SchemaCatalog` zod schema lives in `@se373/contracts` **additively** (new export only — no existing schema touched). `ColumnScopePolicy` stub loads + validates `sensitive_columns.yaml` at construction (invalid → throw, fail-fast per UC-09 §A.8) but its `apply()` is pass-through `allow` until UC09-01; unresolvable references on sensitive tables are already denied by the guard's catalog check, so the stub stays fail-closed by construction.
**When to use:** Guard signature; policy seam; YAML loader (GUARD-02/06).

```typescript
// contracts (additive — new file, re-exported; nothing existing modified)
export const SchemaCatalogSchema = z.object({
  tables: z.record(z.string(), z.array(z.string())),
});
// identifier normalization: PG folds UNQUOTED identifiers to lowercase.
// Parser preserves source case in sval, so compare case-insensitively:
// lookup key = sval.toLowerCase() for catalog built from lowercase fixture names.
// Document: quoted mixed-case identifiers ("Total") match exact-first, lowercase-fallback.
```

```yaml
# policies/sensitive_columns.yaml
version: 1
columns:
  - { table: customers, column: phone }
  - { table: customers, column: email }
  - { table: customers, column: address }
  - { table: employees, column: salary }
```

```typescript
// access-policy: pure loader + strict zod schema; IO wrapper separated for testability
export const SensitiveColumnsSchema = z.strictObject({
  version: z.literal(1),
  columns: z.array(z.strictObject({ table: z.string().min(1), column: z.string().min(1) })),
});
export function loadSensitiveColumns(yamlText: string): SensitiveColumns; // throws on invalid
export function loadSensitiveColumnsFile(path = DEFAULT_PATH, override = process.env.SENSITIVE_COLUMNS_PATH): SensitiveColumns;
```

### Anti-Patterns to Avoid

- **Keyword/first-token guard (`startsWith("SELECT")`, regex):** bypassed by every CTE-wrapped DML and stacked statement (dbhub CVE-2026-61788 precedent, PITFALLS C2). Use the AST allowlist.
- **`stmts[0]`-only inspection:** `SELECT 1; DROP TABLE` must be rejected on `length !== 1`, not blessed on `[0]`. Walk the whole `ParseResult`.
- **`parseSync` in request/test path:** throws cold (`WASM module not initialized`) and blocks the event loop; async `parse` only, warmed once.
- **Pinning `pgsql-parser` with `^` and forgetting the lockfile:** minor AST-shape drift breaks tag checks; keep `^18.3.1` + lockfile + a CI test asserting `ast.version` starts with `18` (fail loudly on accidental major bump).
- **Passing raw `err.message`/`detail` to the caller:** DSN/user/host/path leak (UC-09 TC5/E11). Everything funnels through `sanitizeError()`.
- **Executor without `ROLLBACK`:** a mid-transaction error poisons the pooled session (`25P02` on next use). `ROLLBACK` before returning, `release()` in `finally` — pool exhaustion under eval loops otherwise.
- **`SET LOCAL` with uninterpolated user input:** it takes no bind parameters; validate `timeoutMs` as integer in range server-side before interpolating.
- **Reading the catalog/YAML from disk inside `sqlGuard`:** violates D-05 purity and breaks agent pre-flight bundling. Inject; read at the edges (mcp-server boot, tests).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SQL parsing / statement splitting | Regex, `split(";")`, `startsWith` | `pgsql-parser` `parse` | `;` inside string literals/comments, quoted identifiers, and CTE nesting defeat string checks; only the real PG grammar is exact (C2/C4) |
| AST traversal | Hand-written recursive walker | `@pgsql/traverse` `walk` | Version-pinned visitor API with statement context (`isWrite`, `abort`); hand recursion silently misses new node types on upgrades |
| SQL pretty-printing / rewrite | String templating | `pgsql-deparser` `deparse` (bundled dep) | Phase 3 needs no deparse; when UC09-01 rewrites projections, deparse + re-validate is the documented workflow |
| Bounded result reads | `LIMIT` injection into user SQL | `pg-cursor` `read(maxRows+1)` | Preserves the exact guarded statement; `truncated` flag without changing semantics |
| YAML parsing | Custom parser | `yaml@^2.9.1` | Edge cases (anchors, multi-doc); pair with zod strict schema |
| Error classification | Message-substring matching (`/timeout/i`) | `err.code` SQLSTATE switch | Codes are stable across releases and locales; messages are localized [CITED: errcodes appendix intro] |
| Fake pg doubles | Mocking the `pg` module | Structural interfaces (`PoolLike`/`ClientLike`/`CursorLike`) + hand fakes | Module mocks leak across tests; structural injection is explicit, typed, and documents exactly which driver surface the executor uses |

**Key insight:** the guard's correctness comes from the real parser plus exhaustive traversal, and the executor's from the driver's own primitives (cursor, `SET LOCAL`, `release`). Custom code in this phase should be *policy* (denylist, catalog check, code map, redaction) on top of those primitives — not replacements for them.

## Common Pitfalls

### Pitfall 1: pnpm install fails on `@launchql/protobufjs` postinstall gate
**What goes wrong:** `pnpm install` exits with `[ERR_PNPM_IGNORED_BUILDS]` as soon as `pgsql-parser` or `@pgsql/traverse` is added, blocking every contributor and CI.
**Why it happens:** pnpm v11 denies unapproved build scripts; `@launchql/protobufjs@7.2.6` (transitive via `pgsql-deparser → plpgsql-deparser → pg-proto-parser`) declares `postinstall` [VERIFIED: probe /tmp/p3pnpm — reproduced for both packages].
**How to avoid:** Add `"@launchql/protobufjs": true` to `allowBuilds` in `pnpm-workspace.yaml` in the same commit as the dep add (Phase 1 esbuild precedent). The script itself is benign (version-scheme warning; early-returns).
**Warning signs:** Any `ERR_PNPM_IGNORED_BUILDS` in CI after the dependency commit.

### Pitfall 2: Guard passes a single SELECT that still writes or exfiltrates
**What goes wrong:** `SELECT … INTO TEMP t`, `FOR UPDATE`, `pg_sleep`, schema-qualified `pg_catalog.pg_sleep`, or CTE-wrapped DML pass a naive "root is SelectStmt" check.
**Why it happens:** These are all legal `SelectStmt` nodes; the danger is in `intoClause` / `lockingClause` / `FuncCall` / nested `ctequery`.
**How to avoid:** Deny `intoClause` (any presence), `lockingClause` (any presence), full-tree `FuncCall` denylist matched on lowercased last `funcname` segment, and abort on any DML/Merge/Copy/utility tag anywhere in the walk — including `larg`/`rarg` UNION branches and nested CTEs. Encode every row of the bypass table below as a test.
**Warning signs:** Guard tests only cover top-level `DELETE`/`DROP`.

### Pitfall 3: Multi-statement input blessed via `stmts[0]`
**What goes wrong:** `SELECT 1; DROP TABLE orders` executes the drop when code inspects only the first statement.
**Why it happens:** Parser returns all statements; `stmts.length === 2` verified [VERIFIED: probe]. Comments don't change the count.
**How to avoid:** Hard-require `stmts.length === 1` before any other check; executor additionally uses the extended protocol path (`Cursor`), which forbids multi-statements at the protocol level.
**Warning signs:** Any `stmts[0]` access without a length assertion first.

### Pitfall 4: WASM cold-start crash or per-request init cost
**What goes wrong:** `parseSync` throws `WASM module not initialized` on first call; per-request `loadModule()` adds latency (PITFALLS C4, UC-09 §A.8 50 ms budget).
**Why it happens:** `libpg-query` auto-instantiates at import but async; sync calls before ready throw; verified cold-throw this session [VERIFIED: probe /tmp/p3ts].
**How to avoid:** `export async function warmupSqlGuard() { await parse("SELECT 1"); }`, called once at server boot (Phase 4 wiring — stub the call site now) and in a vitest setup/`beforeAll`. Never call `parseSync` or `loadModule` per request.
**Warning signs:** First test in a fresh worker fails while the rest pass; request-path `loadModule` calls.

### Pitfall 5: Connection/pool leak under error and eval loops
**What goes wrong:** Pool exhaustion after timeouts/errors; poisoned sessions (`25P02`) reused.
**Why it happens:** Missing `release()` on throw paths; missing `ROLLBACK` after a failed statement.
**How to avoid:** `try { BEGIN → SET LOCAL → cursor → close → ROLLBACK } finally { release() }`; unit tests assert `release` call counts on timeout, cursor-error, and close-error paths with fakes.
**Warning signs:** Tests pass singly, suite hangs/scales badly; `release` asserted only on happy path.

### Pitfall 6: Error/message leakage (DSN, host, paths, stack)
**What goes wrong:** `ECONNREFUSED 127.0.0.1:5432`, `password authentication failed for user "agent_ro"`, `PGPASSWORD`/DSN in connection errors, or `Error.stack` reach the MCP response or logs (UC-09 TC5/E11).
**Why it happens:** node-postgres errors carry `connectionParameters`/verbose text; any `catch (e) { return e.message }` re-opens the leak.
**How to avoid:** Single `sanitizeError()`; redact DSN/host/IP/path patterns; drop `stack`; cap at 500 chars; canary test feeds `postgres://evil:secret@db.internal:5432/x` and asserts no fragment survives.
**Warning signs:** Any error formatting outside `errors.ts`.

### Pitfall 7: Catalog case-sensitivity false rejects/accepts
**What goes wrong:** `SELECT Total FROM Orders` rejected although the catalog has `orders.total`, or `"Total"` (quoted, case-significant) mismatched.
**Why it happens:** PG folds unquoted identifiers to lowercase, but the parser preserves source case in `sval`.
**How to avoid:** Lowercase both sides for lookup against a lowercase fixture catalog; document that quoted mixed-case identifiers match exact-first. Fixture catalog uses the Olist lowercase names.
**Warning signs:** Valid-query tests failing only due to capitalization.

## Code Examples

Verified patterns from this session's probes (all runnable against the pinned versions):

### Guard: full allowlist walk with abort

```typescript
// Sources: pgsql-parser@18.3.1 + @pgsql/traverse@18.8.1 behavior verified in /tmp/p3scripts/probe*.js
import { parse } from "pgsql-parser";
import { walk } from "@pgsql/traverse";
import { dbToolError } from "@se373/contracts";

const WRITE_TAGS = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt", "CopyStmt",
  "TransactionStmt", "VariableSetStmt", "VariableShowStmt", "ExplainStmt", "CreateStmt",
  "DropStmt", "TruncateStmt", "GrantStmt", "ListenStmt", "NotifyStmt",
  "PrepareStmt", "ExecuteStmt", "DeallocateStmt"]);

export async function sqlGuard(sql: string, catalog: SchemaCatalog): Promise<GuardResult> {
  let ast;
  try {
    ast = await parse(sql);
  } catch (e) {
    const pos = (e as { sqlDetails?: { cursorPosition?: number } }).sqlDetails?.cursorPosition;
    return { ok: false, error: dbToolError("INVALID_SQL", `Invalid SQL${typeof pos === "number" ? ` at character ${pos}` : ""}`) };
  }
  if (ast.stmts.length !== 1) return { ok: false, error: dbToolError("FORBIDDEN_STATEMENT", "Only a single statement is allowed") };
  if (Object.keys(ast.stmts[0]!.stmt)[0] !== "SelectStmt") {
    return { ok: false, error: dbToolError("FORBIDDEN_STATEMENT", "Only SELECT/WITH queries are allowed") };
  }
  const result = walk(ast, {
    SelectStmt: (path, ctx) => {
      const node = path.node as { intoClause?: unknown; lockingClause?: unknown };
      if (node.intoClause) ctx.abort("FORBIDDEN_STATEMENT:SELECT_INTO");
      if (node.lockingClause) ctx.abort("FORBIDDEN_STATEMENT:FOR_UPDATE");
    },
    ...Object.fromEntries([...WRITE_TAGS].map((tag) => [tag, (_p: unknown, ctx: { abort: (r: string) => void }) => ctx.abort(`FORBIDDEN_STATEMENT:${tag}`)])),
    FuncCall: (path, ctx) => {
      const parts = (path.node.funcname as { String: { sval: string } }[]).map((p) => p.String.sval.toLowerCase());
      if (FORBIDDEN_FUNCTIONS.has(parts[parts.length - 1]!)) ctx.abort("FORBIDDEN_FUNCTION");
    },
    RangeVar: (path, ctx) => {
      const rel = path.node as { schemaname?: string; relname: string };
      if (rel.schemaname && SYSTEM_SCHEMAS.has(rel.schemaname.toLowerCase())) ctx.abort("UNKNOWN_TABLE:SYSTEM_SCHEMA");
      if (!catalog.tables[rel.relname.toLowerCase()]) ctx.abort("UNKNOWN_TABLE");
    },
    ColumnRef: (path, ctx) => {
      // resolve against catalog (unqualified targets checked against all FROM tables in full impl);
      // unknown → ctx.abort("UNKNOWN_TABLE"); A_Star handled by resolver, not here
    },
  });
  if (result.aborted) return { ok: false, error: mapAbortToDbError(result.reason) };
  return { ok: true, tables, columns };
}
```

### Executor: fake-injectable read-only run

```typescript
// Sources: pg@8.23.1 + pg-cursor@2.22.1 + @types/pg-cursor@2.7.2 (verified /tmp/p3probe, /tmp/p3types)
// Structural seams — fakes implement these; no pg import in tests.
export interface CursorLike {
  read(n: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}
export interface ClientLike {
  query(sql: string): Promise<unknown>;
  queryCursor(cursor: CursorLike): CursorLike;
  release(): void;
}
export interface PoolLike {
  connect(): Promise<ClientLike>;
}
// Production adapter (lives in db.ts, the only file importing pg/pg-cursor):
// queryCursor = (cursor) => client.query(cursor) via the Submittable overload.
```

### Live-test auto-skip gate

```typescript
// skipIf verified present in vitest@5.0.5 runtime + types [VERIFIED: probe /tmp/p3vit]
import { describe, it } from "vitest";
const hasDb = !!process.env.DATABASE_URL;
describe.skipIf(!hasDb)("executor live (requires DATABASE_URL)", () => {
  it("runs a bounded read against agent_ro", async () => { /* ... */ });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `sqlglot` (Python) for guard | `pgsql-parser` (real PG grammar via libpg_query WASM) | UC-09 TS port (plan §0.1) | Exact statement classification; no Python in harness (PRD §1.5) |
| `node-sql-parser` fallback | Documented fallback only, never for masking | UC-09 §0.1 | Weaker PG-dialect coverage — unacceptable for a security allowlist |
| `fetchmany` (psycopg) | `pg-cursor read(maxRows+1)` | UC-09 TS port (§0.1) | Bounded reads with truncation flag, exact guarded statement preserved |
| `pytest` guard tests | `vitest` (works with WASM in default pool — verified 2/2 pass) | Phase 1 toolchain | Same-runner repo-wide; no Python needed for Phase 3 CI |
| `zod-to-json-schema` for docs | Native `z.toJSONSchema()` (zod v4) | Phase 1 contracts | Avoided entirely; irrelevant to Phase 3 except catalog schemas reuse zod v4 API |

**Deprecated/outdated:**
- `gitleaks/gitleaks-action@v2` — dead (Node 20 runner removed); CI uses v3 (Phase 1 done).
- `typescript@7` as the compiler — breaks `typescript-eslint` (`<6.1.0` peer); repo pins `~6.0.3`. Verified compatible: ESM named imports from `pgsql-parser`/`@pgsql/traverse` typecheck clean under `tsc 6.0.3` + `nodenext` [VERIFIED: probe /tmp/p3ts, exit 0].
- `parseSync` for request-path parsing — throws before WASM ready; async `parse` only.

## Bypass-Vector Test List (38 cases: 14 valid + 24 malicious)

Fixture catalog (D-05, Olist-modelled): `customers(id,name,phone,email,address,city,region)`, `orders(id,customer_id,total,status,created_at)`, `order_items(id,order_id,product_id,qty,price)`, `products(id,name,category_id,price)`, `categories(id,name)`, `sellers(id,name,region)`, `payments(order_id,method,amount)`, `reviews(order_id,rating,comment)`, `regions(id,name)`, `channels(id,name)`, `employees(id,name,salary,dept)`, `promotions(id,code,discount)`.

Valid (expect `ok: true`):

| # | SQL | Notes |
|---|-----|-------|
| V1 | `SELECT 1` | no-FROM baseline |
| V2 | `SELECT o.id, o.total FROM orders o WHERE o.total > 100` | alias + qualified refs |
| V3 | `SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id` | JOIN |
| V4 | `SELECT a FROM t1 UNION SELECT a FROM t2` (+ `UNION ALL` variant) | `larg`/`rarg` walk |
| V5 | `WITH x AS (DELETE …` — no: `WITH regional AS (SELECT region, sum(total) s FROM orders GROUP BY region) SELECT * FROM regional` | single-level CTE |
| V6 | `SELECT * FROM (SELECT id, total FROM orders) AS sub` | subquery + alias |
| V7 | `SELECT DISTINCT ON (customer_id) customer_id, total FROM orders ORDER BY customer_id, total DESC LIMIT 5 OFFSET 2` | PG-specific clauses |
| V8 | `SELECT row_number() OVER (PARTITION BY customer_id ORDER BY total) FROM orders` | window fn (non-denylisted) |
| V9 | `SELECT region, count(*), avg(total) FROM orders GROUP BY region HAVING count(*) > 1` | aggregates + star-count |
| V10 | `SELECT * FROM public.orders` | schema-qualified business schema |
| V11 | `SELECT "Total" FROM "orders"` — with catalog holding lowercase `orders.total` (exact-first, lowercase-fallback) | quoted identifiers (Pitfall 7) |
| V12 | `SELECT 1 -- trailing comment` and `SELECT /* hidden */ 1` | comments, still 1 stmt |
| V13 | `TABLE orders` | parses as SelectStmt; harmless read — allow |
| V14 | `SeLeCt ID, total FrOm Orders WhErE total > 10` | case variation, valid |

Malicious (expect `ok: false` + code):

| # | SQL | Code |
|---|-----|------|
| M1 | `DELETE FROM orders` | FORBIDDEN_STATEMENT |
| M2 | `UPDATE orders SET total = 0` / `INSERT INTO orders …` | FORBIDDEN_STATEMENT |
| M3 | `SELECT 1; DROP TABLE orders` | FORBIDDEN_STATEMENT (stmts=2) |
| M4 | `SELECT 1; SELECT 2` | FORBIDDEN_STATEMENT (stmts=2 even when both benign) |
| M5 | `SELECT 1; -- note\nDROP TABLE orders` | FORBIDDEN_STATEMENT (comment doesn't hide stmt 2) |
| M6 | `WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x` | FORBIDDEN_STATEMENT (CTE DML) |
| M7 | `WITH x AS (INSERT …) …` / `WITH x AS (UPDATE …) …` | FORBIDDEN_STATEMENT |
| M8 | `WITH a AS (WITH b AS (DELETE FROM orders RETURNING *) SELECT * FROM b) SELECT * FROM a` | FORBIDDEN_STATEMENT (nested CTE) |
| M9 | `SELECT * INTO new_table FROM orders` / `SELECT * INTO TEMP tmp FROM orders` / `… INTO UNLOGGED TABLE …` | FORBIDDEN_STATEMENT (intoClause) |
| M10 | `SELECT * FROM orders FOR UPDATE` / `FOR SHARE` / `FOR UPDATE NOWAIT` | FORBIDDEN_STATEMENT (lockingClause) |
| M11 | `SELECT pg_sleep(600)` | FORBIDDEN_FUNCTION |
| M12 | `SELECT PG_CATALOG.PG_SLEEP(1)` | FORBIDDEN_FUNCTION (schema-qualified + case) |
| M13 | `SELECT pg_read_file('/etc/passwd')`, `pg_ls_dir`, `dblink(...)`, `lo_export(…)`, `lo_import(…)`, `set_config(…)`, `pg_terminate_backend(pid)`, `pg_cancel_backend(pid)`, `nextval('seq')`, `setval(…)` (each as its own case) | FORBIDDEN_FUNCTION |
| M14 | `COPY (SELECT * FROM orders) TO STDOUT` / `COPY orders FROM STDIN` | FORBIDDEN_STATEMENT (CopyStmt) |
| M15 | `BEGIN READ ONLY` / `COMMIT` / `START TRANSACTION …` | FORBIDDEN_STATEMENT (TransactionStmt) |
| M16 | `SET statement_timeout = 0` / `SET LOCAL …` / `RESET …` / `SET ROLE x` / `SET SESSION AUTHORIZATION x` | FORBIDDEN_STATEMENT (VariableSetStmt) |
| M17 | `SHOW server_version` | FORBIDDEN_STATEMENT (VariableShowStmt — no agent need) |
| M18 | `EXPLAIN SELECT * FROM orders` / `EXPLAIN ANALYZE …` | FORBIDDEN_STATEMENT (ExplainStmt; `explain_query` is a Phase 4 tool) |
| M19 | `CREATE TABLE x(a int)` / `CREATE TEMP TABLE …` / `DROP TABLE orders` / `TRUNCATE orders` / `GRANT …` / `MERGE INTO …` | FORBIDDEN_STATEMENT |
| M20 | `LISTEN foo` / `NOTIFY foo` / `PREPARE f AS SELECT 1` / `EXECUTE f` / `DEALLOCATE f` | FORBIDDEN_STATEMENT |
| M21 | `SELECT * FROM pg_catalog.pg_tables` / `information_schema.tables` | UNKNOWN_TABLE (system schema) |
| M22 | `SELECT * FROM nonexistent` | UNKNOWN_TABLE |
| M23 | `SELECT nope FROM orders` | UNKNOWN_TABLE (unknown column maps here per CONTEXT) |
| M24 | `describe_table`-style injection as SQL: `SELECT * FROM "orders; --"` (quoted table literally named `orders; --`) | UNKNOWN_TABLE (catalog miss — proves identifier-vs-injection distinction) |

Plus error-shape cases: empty string + `SELECT FROM WHERE` → `INVALID_SQL` with numeric `cursorPosition` in message (E4); executor-level: `57014` → `TIMEOUT`; connection-refused fake → `INTERNAL_ERROR` with canary-DSN redaction test.

Denylist recommendation (discretion item — required + recommended additions): `pg_sleep`, `pg_read_file`, `pg_ls_dir`, `pg_logdir_ls`, `dblink`, `dblink_exec`, `lo_import`, `lo_export`, `lo_unlink`, `set_config`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_execute_server_program`, `copy` (covered as statement), `nextval`, `setval`, `currval`. ALLOW explicitly (documented, non-denylisted): `current_setting`, `current_user`, `version`, aggregates, window functions, math/string/date functions. Schema rule: allow `public` + business schemas and unqualified refs; deny `pg_catalog`, `information_schema`, `pg_toast` (defense in depth — catalog whitelist would miss them anyway if fixture only lists business tables; the explicit system-schema deny gives a clearer error and protects future catalog mistakes).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `describe.skipIf(!process.env.DATABASE_URL)` is the idiomatic vitest gate [ASSUMED — `skipIf` presence verified in vitest@5.0.5 build output, exact chained API from training] | Code Examples | Low — trivially verified by first test run; fallback `if (!hasDb) return` / `test.skip` |
| A2 | `@se373/agent` importing `@se373/sql-guard` needs no eslint change (ban patterns only cover `pg`, `pg-cursor`, `**/mcp-server/src/**`, `@se373/mcp-server`) [ASSUMED from reading eslint.config.mjs — the file was read, patterns quoted verbatim above] | Architecture Patterns | Low — `pnpm lint` proves it in Phase 3 gate |
| A3 | `SET LOCAL statement_timeout = '<int>ms'` accepts millisecond integers (e.g. `'30000'`) [ASSUMED — PG `statement_timeout` is a GUC taking ms int; standard usage] | Patterns | Low — live test in Phase 2/4 proves; unit fakes assert the emitted string |
| A4 | `TABLE t` / `VALUES (…)` as SelectStmt roots are safe to allow [ASSUMED — no write/lock/function surface by grammar] | Bypass list | Low — both are grammar-constrained reads; reviewer can flip to deny without architecture change |
| A5 | `SELECT $1::int` (unbound params) needs no guard rule — PG errors at execution; run_query takes no params [ASSUMED] | Bypass list (excluded) | Low — add an explicit ParamRef deny test if the team prefers fail-fast at guard |

## Open Questions

1. **Catalog sharing: new contracts schema vs. sql-guard-local type?**
   - What we know: D-05 permits adding to `@se373/contracts` additively; guard + mcp-server + (later) agent pre-flight all need the shape.
   - What's unclear: whether Phase 4/UC-01 want zod validation of the catalog at load (favors contracts) or a bare TS interface (favors sql-guard-local).
   - Recommendation: put `SchemaCatalogSchema` in contracts (additive, zod-validated at DB-catalog build time in Phase 2/4); sql-guard imports the inferred type only.

2. **Zero-row result columns: `fields`-capture vs. documented limitation?**
   - What we know: promise-form `read()` returns rows only; callback form also yields `result.fields[].name`.
   - What's unclear: whether Phase 4 `run_query` output contract tests will demand `columns` on empty results.
   - Recommendation: implement the callback-form capture now (small, tested with fakes); it removes the question entirely.

3. **`current_setting` / `version()` / session-info functions: allow or deny?**
   - What we know: read-only, no exfiltration beyond version strings; denylisting them costs nothing.
   - Recommendation: ALLOW and document (they're useful for debugging; version disclosure is not in the UC-09 threat model). Revisit if UC-08 says otherwise.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All | ✓ | v24.22.1 (`node --version` this session) | — |
| pnpm | Install/build | ✓ | 11.25.0 | — (plus `allowBuilds` addition for `@launchql/protobufjs`) |
| TypeScript ~6.0.3 + ESLint + vitest 5.0.5 | Typecheck/lint/test | ✓ (repo-pinned; vitest WASM run verified 2/2) | — |
| PostgreSQL / Docker | Live executor tests | ✗ (not installed; must not be required) | Fake-client unit tests now; `DATABASE_URL`-gated live tests auto-skip (D-04) |
| Network (npm registry) | `pnpm add` new deps | ✓ (used this session) | Vendoring not needed |

**Missing dependencies with no fallback:** none (Phase 3 is green without a DB).
**Missing dependencies with fallback:** Postgres/Docker → fakes + auto-skip (D-04).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^5.0.5 (per-package projects via root `vitest.workspace.ts`) |
| Config file | `packages/sql-guard/vitest.config.ts` (new, mirrors `packages/contracts/vitest.config.ts` shape: setup warm-up) + existing `packages/mcp-server`, `packages/access-policy` configs |
| Quick run command | `pnpm --filter @se373/sql-guard test` / `pnpm --filter @se373/mcp-server test` / `pnpm --filter @se373/access-policy test` |
| Full suite command | `pnpm test` (root; must stay green with and without `DATABASE_URL`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| GUARD-01 | Single SelectStmt incl. WITH/UNION accepted; DDL/DML/multi/INTO/FOR UPDATE/CTE-DML denied → FORBIDDEN_STATEMENT | unit | `pnpm --filter @se373/sql-guard test` (cases V1–V14, M1–M10, M14–M20) | ❌ Wave 0 (new package) |
| GUARD-02 | Denylisted fns (incl. `pg_catalog.`-qualified, case variants) → FORBIDDEN_FUNCTION; system/unknown tables-or-columns → UNKNOWN_TABLE | unit | same suite (M11–M13, M21–M24) | ❌ Wave 0 |
| GUARD-03 | ≥30 cases green; guard importable by agent path (no `pg` import: eslint clean) | unit + lint | `pnpm --filter @se373/sql-guard test` + `pnpm lint` | ❌ Wave 0 |
| GUARD-04 | Executor sequence (BEGIN → SET LOCAL → read(maxRows+1) → truncated → ROLLBACK → release-always) + `{columns, rows, rowCount, truncated, durationMs}` shape | unit (fakes) + live-skipped | `pnpm --filter @se373/mcp-server test` (`db.test.ts`; live file `db.live.test.ts` auto-skips w/o `DATABASE_URL`) | ❌ Wave 0 |
| GUARD-05 | 57014 → TIMEOUT; DSN/host/user/path/stack canary redaction on all error paths | unit | `pnpm --filter @se373/mcp-server test` (`errors.test.ts`) | ❌ Wave 0 |
| GUARD-06 | `AccessPolicy`/`ColumnScopePolicy` stub constructs from valid YAML, throws on invalid; Phase-3 behavior pass-through | unit | `pnpm --filter @se373/access-policy test` (`policy.test.ts`, `sensitive-columns.test.ts`) | ❌ Wave 0 (shell test exists; extended) |

### Sampling Rate

- **Per task commit:** affected package filter test + `pnpm lint`
- **Per wave merge:** `pnpm test` (full workspace, both with and without `DATABASE_URL` — run twice in gate)
- **Phase gate:** full suite green + `pnpm typecheck` + `pnpm lint` before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/sql-guard/{package.json,tsconfig.json,src/*.ts,test/guard.test.ts,vitest.config.ts}` — covers GUARD-01/02/03
- [ ] `packages/sql-guard` wiring: root `tsconfig.json` reference, `vitest.workspace.ts` entry, `pnpm-workspace.yaml` `allowBuilds` += `@launchql/protobufjs`, `docs/architecture.md` §2/§3/§8, `.github/CODEOWNERS` line, `eslint.config.mjs` `packages/sql-guard/**` ban on `pg`/`pg-cursor` (keeps D-01 purity in CI), `pnpm install` + lockfile
- [ ] `packages/contracts/src/catalog.ts` (additive `SchemaCatalogSchema`) + re-export + test — shared catalog type (D-05)
- [ ] `packages/mcp-server/src/{db.ts,errors.ts}` + `test/{db.test.ts,errors.test.ts,db.live.test.ts}` (live file `describe.skipIf(!process.env.DATABASE_URL)`) — covers GUARD-04/05
- [ ] `packages/access-policy/src/{policy.ts,sensitive-columns.ts}` + `test/{policy.test.ts,sensitive-columns.test.ts}`; `policies/sensitive_columns.yaml` — covers GUARD-06
- [ ] Fixture catalog module shared by guard tests (Olist-modelled tables above)

## Security Domain

(`security_enforcement` is enabled (absent = enabled); ASVS level 1.)

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V4 Access Control | yes | Deny-by-default AST allowlist (single SelectStmt, catalog whitelist, function denylist); fail-closed on unresolvable refs |
| V5 Input Validation | yes | `pgsql-parser` real-grammar parse; `stmts.length===1`; zod schemas for catalog + YAML config; `timeoutMs` integer-range validation before `SET LOCAL` interpolation |
| V7 Errors & Logging | yes | Single `sanitizeError()` choke point; no DSN/host/user/path/stack in outputs; message cap 500 |
| V12 Files & Resources | partial | `sensitive_columns.yaml` loaded from explicit path + env override; invalid config throws (fail-fast, no silent default-open) |
| V14 Configuration | yes | `allowBuilds` pin for `@launchql/protobufjs`; dependency versions pinned + lockfile; parser `version`-line CI assertion |
| V2 Authentication / V3 Sessions | no (Phase 4) | Token auth + scopes land with the MCP server; note executor binds no identity — trusts only in-process caller until Phase 4 |

### Known Threat Patterns for PG-guard + executor stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Stacked-statement SQL injection (`; DROP TABLE`) | Tampering | `stmts.length===1` + cursor extended-protocol path (multi-statements unsupported) |
| Side-effect function exfil/DoS (`pg_sleep`, `pg_read_file`, `dblink`, `lo_*`) | Tampering / Info disclosure / DoS | Recursive `FuncCall` denylist (last-segment, lowercased) + `statement_timeout` + minimal DB extensions (Phase 2) |
| Lock-contention DoS (`FOR UPDATE/SHARE`) | DoS | `lockingClause` deny |
| Disk-write primitive (`SELECT INTO [TEMP]`, `COPY`) | Tampering / DoS | `intoClause` deny + `CopyStmt` deny + Phase 2 `REVOKE TEMP/CREATE` grants (defense in depth, PITFALLS C1) |
| Session-escape (`SET`, `RESET`, `SET ROLE`, `SHOW`) → `search_path` hijack / role escalation | Elevation | `VariableSet/ShowStmt` deny; Phase 2 zero role memberships |
| Connection-string / infra disclosure in errors | Info disclosure | `sanitizeError()` redaction + canary test |
| Slow-query resource exhaustion | DoS | `SET LOCAL statement_timeout` per call + `maxRows+1` cursor cap + role-level 30 s (Phase 2) |
| Sensitive-column probing (`WHERE phone LIKE`, aggregates, CTE renames) | Info disclosure | Catalog-gated column check (fail-closed); full masking deferred to UC09-01 — stub must NOT claim enforcement |

## Sources

### Primary (HIGH confidence — tool-verified this session)

- `npm view` (2026-10-26, Node 24, pnpm 11.25.0): `pgsql-parser@18.3.1` (+ dist-tags pg13→pg18), `@pgsql/traverse@18.8.1`, `pg@8.23.1`, `pg-cursor@2.22.1`, `@types/pg-cursor@2.7.2`, `yaml@2.9.1`; `time.created` + `repository.url` for legitimacy table
- Empirical probes (real installs, throwaway dirs outside repo — `/tmp/p3probe` deps, `/tmp/p3scripts/probe{1-6}.js`, `/tmp/p3vit` vitest run 2/2 pass, `/tmp/p3ts` tsc-nodenext exit 0, `/tmp/p3pnpm` pnpm `ERR_PNPM_IGNORED_BUILDS` reproduction, `/tmp/p3types` d.ts inspection): AST JSON shapes, `SqlError.sqlDetails.cursorPosition`, cold-`parseSync` throw, `deparse` string/full-AST behavior, `walk` visitor+ctx+abort semantics, `READ_/WRITE_STATEMENTS` sets, `pg-pool` `client.release`, `pg-cursor` promise `read`/`close`, `@types/pg` `Submittable` overload, `export = Cursor` default-import rule, vitest `skipIf` presence, ESM+TS6 compat
- In-repo source read this session: `packages/contracts/src/errors.ts` (11 codes, 500-char cap), `packages/contracts/src/tools.ts` (`RunQueryOutputSchema`), `packages/mcp-server` + `packages/access-policy` shells, `tsconfig.base.json`/`tsconfig.json`, `vitest.workspace.ts`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `.github/CODEOWNERS`, Phase 1 `01-01/01-03-SUMMARY.md` (workspace patterns + deviations)

### Secondary (MEDIUM — official docs, fetched this session)

- PostgreSQL 18 errcodes appendix (`postgresql.org/docs/current/errcodes-appendix.html`) — SQLSTATE codes table (42601/42501/42703/42P01/25006/57014/class-08 etc.)
- `@pgsql/traverse` README + `walk.d.ts`/`traverse.d.ts` (When-to-use table, `WalkContext`, `WalkResult`, `UnifiedVisitor`) — read from installed package
- `libpg-query` wasm `index.js` (`instantiate`/`ensureLoaded`/`awaitInit`) — read from installed package

### Tertiary (LOW — training knowledge, flagged in Assumptions Log)

- vitest `describe.skipIf` chained API exact form; `SET LOCAL` ms-integer syntax; `TABLE`/`VALUES` safety assessment

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions via `npm view`, APIs via executed probes, WASM/vitest/TS-compat all green
- Architecture: HIGH — follows locked D-01/D-02/D-03 directions and UC-09 §A.6 pipeline order; executor/guard/policy seams match existing shell layout
- Pitfalls: HIGH — C1/C2/C4 honored with verified mechanisms; new pnpm `allowBuilds` blocker reproduced, not theorized

**Research date:** 2026-10-26
**Valid until:** 2026-11-26 (stable APIs; re-verify only if `pgsql-parser`/`pg` majors move or pnpm changes build-gate behavior)
