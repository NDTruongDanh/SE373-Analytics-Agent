# Phase 3: SQL Guard + Read-Only Executor - Pattern Map

**Mapped:** 2026-10-26
**Files analyzed:** 22 (15 new, 7 modified)
**Analogs found:** 16 / 22 (6 with no in-repo analog — planner must use RESEARCH.md probes instead)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/sql-guard/package.json` | config | build | `packages/mcp-server/package.json` | exact |
| `packages/sql-guard/tsconfig.json` | config | build | `packages/mcp-server/tsconfig.json` | exact |
| `packages/sql-guard/vitest.config.ts` | config | build | `packages/contracts/vitest.config.ts` | exact |
| `packages/sql-guard/src/index.ts` | utility (barrel) | request-response (import surface) | `packages/contracts/src/index.ts` | exact |
| `packages/sql-guard/src/guard.ts` | service (validator) | transform (SQL string → GuardResult) | `packages/contracts/src/tools.ts` (partial: zod + `dbToolError` usage idiom only) | partial |
| `packages/sql-guard/src/denylist.ts` | config (frozen constant lists) | transform (lookup) | `packages/contracts/src/errors.ts` (`ErrorCodes` frozen array) | role-match |
| `packages/sql-guard/test/guard.test.ts` | test | batch (38 cases) | `packages/contracts/test/tools.test.ts` + `errors.test.ts` | role-match |
| `packages/sql-guard/test/fixtures.ts` | test (fixture) | batch | none (first shared fixture module) — see RESEARCH.md §Bypass-Vector Test List catalog | no-analog |
| `packages/contracts/src/catalog.ts` | model (zod schema) | transform (validation) | `packages/contracts/src/tools.ts` | exact |
| `packages/contracts/src/index.ts` (modify) | utility (barrel) | — | itself (`packages/contracts/src/index.ts` lines 1-8) | exact |
| `packages/contracts/test/catalog.test.ts` | test | batch | `packages/contracts/test/tools.test.ts` | exact |
| `packages/mcp-server/src/db.ts` | service (executor) | request-response (pool → cursor → rows) | none (first `pg`/`pg-cursor` code in repo) — RESEARCH.md Pattern 2 is the spec | no-analog |
| `packages/mcp-server/src/errors.ts` | utility (error choke point) | transform (unknown → DbToolError) | `packages/contracts/src/errors.ts` (`dbToolError` factory + code lists) | role-match |
| `packages/mcp-server/test/db.test.ts` | test (fake-injected) | batch | `packages/contracts/test/tools.test.ts` (vitest shape; fakes per RESEARCH.md Pattern 2) | role-match |
| `packages/mcp-server/test/errors.test.ts` | test | batch | `packages/contracts/test/errors.test.ts` | exact |
| `packages/mcp-server/test/db.live.test.ts` | test (live-gated) | request-response | none (first `describe.skipIf` + `DATABASE_URL` gate) — RESEARCH.md live-test snippet | no-analog |
| `packages/access-policy/src/policy.ts` | service (interface + stub) | request-response | `packages/access-policy/src/index.ts` (shell shape only) | partial |
| `packages/access-policy/src/sensitive-columns.ts` | utility (config loader) | file-I/O (YAML text → validated object) | none (first YAML loader) — RESEARCH.md Pattern 4 snippet | no-analog |
| `packages/access-policy/test/policy.test.ts` | test | batch | `packages/access-policy/test/shell.test.ts` + `packages/contracts/test/errors.test.ts` | role-match |
| `packages/access-policy/test/sensitive-columns.test.ts` | test | batch (valid + invalid YAML) | `packages/contracts/test/tools.test.ts` (schema accept/reject idiom) | role-match |
| `policies/sensitive_columns.yaml` | config | file-I/O | none (directory does not exist yet; CODEOWNERS line already reserved — see below) | no-analog |
| Root wiring (modify): `tsconfig.json`, `vitest.workspace.ts`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `.github/CODEOWNERS`, `docs/architecture.md` | config | build | themselves (extend existing entries in place) | exact |

## Pattern Assignments

### `packages/sql-guard/package.json` (config, build)

**Analog:** `packages/mcp-server/package.json` (exact — same workspace-dep shape; sql-guard adds third-party deps)

```json
// Source: packages/mcp-server/package.json lines 1-12 — copy name/type/scripts shape verbatim
{
  "name": "@se373/mcp-server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "@se373/contracts": "workspace:*"
  }
}
```

Planner notes: `packages/contracts/package.json` lines 12-20 is the only package with `exports`/`files` (`"files": ["dist"]`, `exports` → `./dist/index.js` + `./dist/index.d.ts`) and a `build` script (`"build": "tsc -b"`). New package needs the same `exports`/`files`/`build` block so `mcp-server` and `agent` can import `@se373/sql-guard` from `dist` after `tsc -b`. Dependencies per RESEARCH.md: `@se373/contracts: workspace:*`, `pgsql-parser@^18.3.1`, `@pgsql/traverse@^18.8.1` — and nothing else (no `pg`/`pg-cursor`/`yaml`; D-01 purity). Single zod copy invariant guarded by `packages/contracts/test/zod-singleton.test.ts` — do NOT add a separate `zod` dep to sql-guard; take the type via contracts.

---

### `packages/sql-guard/tsconfig.json` (config, build)

**Analog:** `packages/mcp-server/tsconfig.json` (exact — the template for "package that references contracts")

```json
// Source: packages/mcp-server/tsconfig.json lines 1-10 — copy verbatim, only the reference target stays ../contracts
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }]
}
```

Compiler facts that constrain new code (`tsconfig.base.json` lines 1-16): `strict: true`, `module/moduleResolution: nodenext`, `esModuleInterop: true`, `isolatedModules: true`. Consequences: ESM imports MUST carry `.js` suffixes (see Shared Patterns); `pg-cursor` default-import style works under `esModuleInterop` (RESEARCH.md verified). Root `tsconfig.json` line 4 must gain `{ "path": "packages/sql-guard" }` in the `references` array (alphabetical position: after `packages/mcp-server`, before `packages/access-policy` is wrong — list is contracts, agent, mcp-server, access-policy, api, web; append `packages/sql-guard` keeping the existing order and add at the end to minimize diff churn, or insert alphabetically — planner's call, one line either way).

---

### `packages/sql-guard/vitest.config.ts` (config, build)

**Analog:** `packages/contracts/vitest.config.ts` (exact — the only existing per-package vitest config)

```typescript
// Source: packages/contracts/vitest.config.ts lines 1-8 — copy verbatim
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

Planner notes: RESEARCH.md recommends a WASM warm-up via setupFiles or `beforeAll(warmupSqlGuard)` in the test file — prefer `beforeAll` in `guard.test.ts` (no extra config file needed; the analog config above stays byte-identical to contracts). Root `vitest.workspace.ts` lines 1-9 gains one entry `"packages/sql-guard"` in the exported array.

---

### `packages/sql-guard/src/index.ts` (utility barrel)

**Analog:** `packages/contracts/src/index.ts` (exact — barrel re-export idiom)

```typescript
// Source: packages/contracts/src/index.ts lines 1-8 — the .js-suffix re-export pattern (nodenext requirement)
export * from "./errors.js";
export * from "./tools.js";
export * from "./answers.js";
export * from "./trace.js";
export * from "./semantic.js";
export * from "./benchmark.js";

export const CONTRACTS_VERSION = "0.1.0";
```

Planner notes: sql-guard barrel re-exports `guard.js`, `denylist.js`, and the result/warmup types. Every intra-package import uses the `.js` suffix even though the source file is `.ts` (see also `packages/contracts/test/errors.test.ts` line 2: `from "../src/errors.js"`). Shell-file idiom for the pre-logic stage is NOT needed here — Phase 3 writes real logic directly (shells in `packages/mcp-server/src/index.ts` lines 1-6 and `packages/access-policy/src/index.ts` lines 1-6 are placeholders being superseded, keep their exports intact).

---

### `packages/sql-guard/src/guard.ts` (service validator, transform)

**Analog:** `packages/contracts/src/tools.ts` (partial — only the zod + `dbToolError` usage idiom; there is NO AST-validation analog in the repo. The guard algorithm itself comes from RESEARCH.md Pattern 1 / Code Examples, verified against live probes.)

**Zod + contracts idiom to copy** (from `packages/contracts/src/tools.ts` lines 71-87 — input bounding + output shape):

```typescript
// Source: packages/contracts/src/tools.ts lines 71-87
export const RunQueryInputSchema = z.object({
  sql: z.string().min(1).max(20000),
  maxRows: z.number().int().min(1).max(1000).default(200),
});
// ...
export const RunQueryOutputSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  maskedColumns: z.array(z.string()).default([]),
  durationMs: z.number().nonnegative(),
});
```

**Error-construction idiom to copy** (from `packages/contracts/src/errors.ts` lines 36-42):

```typescript
// Source: packages/contracts/src/errors.ts lines 36-42
export function dbToolError(code: ErrorCode, message: string): DbToolError {
  return {
    code,
    message,
    retryable: RETRYABLE_CODES.includes(code),
  };
}
```

Guard-specific rules (no analog — from RESEARCH.md, encode verbatim in the plan): async `parse` only + `warmupSqlGuard`; `stmts.length !== 1` → `FORBIDDEN_STATEMENT`; root-tag allowlist (`SelectStmt` only); `walk()` visitor denying `intoClause`/`lockingClause`/write-tags/`FuncCall` denylist (lowercased last segment)/system-schema + unknown `RangeVar`/unknown `ColumnRef`; parse failure → `INVALID_SQL` with `cursorPosition`; catalog lookup lowercases both sides (Pitfall 7).

---

### `packages/sql-guard/src/denylist.ts` (config, transform)

**Analog:** `packages/contracts/src/errors.ts` lines 6-34 (role-match — the repo's one frozen-constant-list module)

```typescript
// Source: packages/contracts/src/errors.ts lines 6-18 — frozen `as const` list idiom
export const ErrorCodes = [
  "UNAUTHORIZED",
  "SCOPE_DENIED",
  // ...
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];
```

```typescript
// Source: packages/contracts/src/errors.ts lines 30-34 — derived-set idiom
export const RETRYABLE_CODES: ErrorCode[] = [
  "TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];
```

Planner notes: `denylist.ts` follows the same shape — `FORBIDDEN_FUNCTIONS: ReadonlySet<string>` (or `as const` array + `Set`) of lowercased last-segment names, `SYSTEM_SCHEMAS` set (`pg_catalog`, `information_schema`, `pg_toast`), both exported with a derived type. Denylist contents from RESEARCH.md (required + recommended): `pg_sleep`, `pg_read_file`, `pg_ls_dir`, `pg_logdir_ls`, `dblink`, `dblink_exec`, `lo_import`, `lo_export`, `lo_unlink`, `set_config`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_execute_server_program`, `nextval`, `setval`, `currval`.

---

### `packages/sql-guard/test/guard.test.ts` (test, batch)

**Analog:** `packages/contracts/test/tools.test.ts` (role-match — accept/reject schema-test idiom) + `packages/contracts/test/errors.test.ts`

```typescript
// Source: packages/contracts/test/tools.test.ts lines 11-19 — parse-valid + throws idiom
it("parses a valid describe_table input", () => {
  const parsed = DescribeTableInputSchema.parse({ table: "ghost_table_xyz" });
  expect(parsed.table).toBe("ghost_table_xyz");
});

it("rejects a table name longer than 128 chars", () => {
  expect(() =>
    DescribeTableInputSchema.parse({ table: "t".repeat(129) }),
  ).toThrow();
});
```

```typescript
// Source: packages/contracts/test/errors.test.ts lines 14-19 — dbToolError shape assertion idiom
it("dbToolError SCOPE_DENIED yields retryable false", () => {
  expect(dbToolError("SCOPE_DENIED", "Missing scope data:read")).toMatchObject({
    code: "SCOPE_DENIED",
    retryable: false,
  });
});
```

Planner notes: guard tests are async (`await sqlGuard(...)`), need `beforeAll(() => warmupSqlGuard())` (or setupFiles) per RESEARCH.md Pitfall 4, and the fixture catalog (Olist-modelled, RESEARCH.md Bypass-Vector list). ≥30 cases: V1–V14 valid + M1–M24 malicious + `INVALID_SQL` position cases. Assert `{ ok, error.code }` shapes, not messages. Fixture module `test/fixtures.ts` has no analog — plain exported const, no pattern needed.

---

### `packages/contracts/src/catalog.ts` (model, transform — ADDITIVE)

**Analog:** `packages/contracts/src/tools.ts` (exact — same file role: zod schemas + inferred types, `import * as z` header)

```typescript
// Source: packages/contracts/src/tools.ts lines 1-10 — file header + strict-object idiom
import * as z from "zod";

// Tracer slice of the db-tool contract surface: list_tables and
// describe_table I/O schemas (UC-09 A.6/A.7, PRD 4.1 tool table).
// Scope filtering is server-side in Phase 4, never a client claim, so
// ListTablesInputSchema is an empty strict object.

export const ListTablesInputSchema = z.strictObject({});
```

Planner notes: new file `packages/contracts/src/catalog.ts` with `SchemaCatalogSchema` (RESEARCH.md Pattern 4: `z.object({ tables: z.record(z.string(), z.array(z.string())) })`), plus inferred `SchemaCatalog` type. Additive-only governance (`docs/architecture.md` lines 118-122): new file + one re-export line in `packages/contracts/src/index.ts` (copy the `export * from "./x.js";` idiom, line 1-6 pattern) needs 1 code-owner review; touching existing schemas is forbidden. New `packages/contracts/test/catalog.test.ts` copies `test/tools.test.ts` accept/reject idiom above.

---

### `packages/mcp-server/src/db.ts` (service executor, request-response)

**Analog:** NONE in-repo (first `pg`/`pg-cursor` code by design — D-02). Planner must build the plan action from RESEARCH.md Pattern 2 verbatim. Constrain with these repo facts:

- ESLint ban (`eslint.config.mjs` lines 9-41) covers `packages/agent/**` and `apps/**` only — `packages/mcp-server/**` and the NEW `packages/sql-guard/**` scope are unrestricted EXCEPT the planner must add a `pg`/`pg-cursor` ban for `packages/sql-guard/**` (D-01 purity in CI). `sql-guard` itself must never import `pg`.
- ESM interop facts: `import { Pool } from "pg"` (named, CJS interop) and `import Cursor from "pg-cursor"` (default; `module.exports = Cursor`) both work under repo `esModuleInterop: true` (RESEARCH.md verified + `@types/pg-cursor` devDep).
- Output shape MUST satisfy `RunQueryOutputSchema` (`packages/contracts/src/tools.ts` lines 78-87: `{columns, rows, rowCount, truncated, maskedColumns: [] , durationMs}`); executor sets `maskedColumns: []` until UC09-01.
- Sequence contract (D-04, testable with fakes): `pool.connect()` → `BEGIN READ ONLY` → `SET LOCAL statement_timeout = '<validated-int>'` (integer-validated server-side, interpolation only — `SET LOCAL` takes no bind params) → `client.query(new Cursor(sql))` via `Submittable` overload → `cursor.read(maxRows+1)` → truncated flag + slice → `cursor.close()` → `ROLLBACK` → `client.release()` in `finally`. Structural `PoolLike`/`ClientLike`/`CursorLike` seams (RESEARCH.md Code Examples) — no module mocking.
- Errors funnel to `sanitizeError()` (sibling `errors.ts`); `57014` → `TIMEOUT`.

---

### `packages/mcp-server/src/errors.ts` (utility, transform)

**Analog:** `packages/contracts/src/errors.ts` (role-match — error-code domain; the choke-point mechanics are RESEARCH.md Pattern 3)

```typescript
// Source: packages/contracts/src/errors.ts lines 22-42 — schema cap + factory idiom the sanitizer must respect
export const DbToolErrorSchema = z.object({
  code: z.enum(ErrorCodes),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
});

export const RETRYABLE_CODES: ErrorCode[] = [
  "TIMEOUT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

export function dbToolError(code: ErrorCode, message: string): DbToolError {
  return {
    code,
    message,
    retryable: RETRYABLE_CODES.includes(code),
  };
}
```

Planner notes: `sanitizeError(err: unknown): DbToolError` owns the PG-code→contract-code map (table in RESEARCH.md Pattern 3: `57014`→TIMEOUT, `42601`→INVALID_SQL, `42P01`/`42703`→UNKNOWN_TABLE, `25006`/`42501`→FORBIDDEN_STATEMENT, `28P01`→INTERNAL_ERROR, class-08/`53xxx`→INTERNAL_ERROR, default INTERNAL_ERROR), redacts DSN/host/IP/path, drops `stack`, caps at 500 chars (the `DbToolErrorSchema` max). Tests (`test/errors.test.ts`, analog `packages/contracts/test/errors.test.ts` verbatim shape above) must include the canary-DSN test (`postgres://evil:secret@db.internal:5432/x` leaves no fragment) and a 500-char-cap assertion.

---

### `packages/mcp-server/test/db.test.ts` + `test/db.live.test.ts` (test)

**Analog (unit):** `packages/contracts/test/tools.test.ts` (vitest `describe/it/expect` shape; imports from `../src/*.js`). Fakes implement RESEARCH.md structural interfaces (`PoolLike`/`ClientLike`/`CursorLike`) — no `pg` import in tests, no module mocks. Must assert: call order (BEGIN → SET LOCAL → read → ROLLBACK), `release()` on happy/timeout/cursor-error/close-error paths (Pitfall 5), `truncated` boundary (`maxRows+1` read), `maskedColumns: []`, `durationMs >= 0`.

**Analog (live):** NONE — first `describe.skipIf(!process.env.DATABASE_URL)` gate (RESEARCH.md snippet; `skipIf` verified present in vitest 5.0.5). Live file asserts the same sequence against real Postgres and must stay green-by-skip in CI without `DATABASE_URL` (D-04).

---

### `packages/access-policy/src/policy.ts` (service interface + stub)

**Analog:** `packages/access-policy/src/index.ts` (partial — shell-export shape only; the interface design is RESEARCH.md Pattern 4)

```typescript
// Source: packages/access-policy/src/index.ts lines 1-6 — contracts-type-only import idiom (no DB, no zod here)
import type { DbToolError } from "@se373/contracts";

export const ACCESS_POLICY_SHELL =
  "Access-policy shell: the AccessPolicy interface seam lands in Phase 3";

export type AccessPolicyShellError = DbToolError;
```

Planner notes: `policy.ts` defines `AccessPolicy` interface + `ColumnScopePolicy` class whose constructor validates config (invalid → throw, fail-fast per UC-09 §A.8) and whose Phase-3 `apply()` is pass-through `allow` (must NOT claim enforcement; full masking is UC09-01, deferred). Imports types from `@se373/contracts` only (bare specifier, no `.js` suffix for package imports — suffixes are for relative files only). Re-export from `src/index.ts` keeping the existing shell exports intact.

---

### `packages/access-policy/src/sensitive-columns.ts` (utility, file-I/O)

**Analog:** NONE for the loader mechanics (first YAML reader; first `node:fs` use). Zod side copies `packages/contracts/src/tools.ts` strict-schema idiom; test side copies `tools.test.ts` accept/reject idiom. Spec from RESEARCH.md Pattern 4:

```typescript
// Spec source (no in-repo analog): RESEARCH.md Pattern 4 — planner encodes verbatim
export const SensitiveColumnsSchema = z.strictObject({
  version: z.literal(1),
  columns: z.array(z.strictObject({ table: z.string().min(1), column: z.string().min(1) })),
});
export function loadSensitiveColumns(yamlText: string): SensitiveColumns; // pure, throws on invalid
export function loadSensitiveColumnsFile(path = DEFAULT_PATH, override = process.env.SENSITIVE_COLUMNS_PATH): SensitiveColumns; // IO wrapper
```

Planner notes: `yaml@^2.9.1` + `zod` (existing workspace pin, no new zod line — singleton test) added to `packages/access-policy` deps only. Pure parser separated from the `fs` wrapper for testability. Tests (`test/sensitive-columns.test.ts`): valid-YAML fixture parses; missing `version`/wrong literal/empty table/extra keys all throw (`strictObject`).

---

### `policies/sensitive_columns.yaml` (config, file-I/O)

**Analog:** NONE (directory `policies/` does not exist yet). Reserved seams already in place:

- `.github/CODEOWNERS` line 11: `policies/ @HungPham-VNU @NDTruongDanh # TODO(UC-09 owner): replace with handle during review` — file is covered from birth, no CODEOWNERS change needed for the YAML itself (CODEOWNERS change needed only for the new `packages/sql-guard/` line, mirroring lines 5-8 format).
- `docs/architecture.md` line 39 already references `policies/*.yaml` as cross-cutting.

Content spec (RESEARCH.md Pattern 4): `version: 1` + four entries (`customers.phone/email/address`, `employees.salary`). Planner: keep keys exactly `version`/`columns`/`table`/`column` to match `SensitiveColumnsSchema`.

---

### Root wiring modifications (config, build — all "modify in place")

| File | Existing pattern to extend (verified lines) | Change |
|---|---|---|
| `tsconfig.json` | line 4 `references` array | add `{ "path": "packages/sql-guard" }` |
| `vitest.workspace.ts` | lines 2-8 project array | add `"packages/sql-guard"` |
| `pnpm-workspace.yaml` | lines 2-4 `allowBuilds` (`better-sqlite3`, `esbuild` precedent) | add `"@launchql/protobufjs": true` with comment (blocks install otherwise — Pitfall 1) |
| `eslint.config.mjs` | lines 9-41 `no-restricted-imports` block for `packages/agent/**`, `apps/**` | add `packages/sql-guard/**` scope banning `pg`, `pg-cursor` (D-01 purity gate); do NOT add sql-guard to the existing agent/apps block |
| `.github/CODEOWNERS` | lines 5-8 per-package lines | add `packages/sql-guard/ @HungPham-VNU @NDTruongDanh` (UC-09 owner) |
| `docs/architecture.md` | §2 layers table (lines 43-52), §3 import diagram (lines 56-67), §8 UC-09 row (line 184) | list `sql-guard` (pure, `sql-guard → contracts`; `mcp-server → sql-guard`; `agent → sql-guard` pre-flight) |

## Shared Patterns

### ESM import suffixes (nodenext — applies to ALL new .ts files)

**Source:** `packages/contracts/src/index.ts` lines 1-6; `packages/contracts/test/errors.test.ts` line 2 (`from "../src/errors.js"`); `packages/mcp-server/src/index.ts` line 1 (`from "@se373/contracts"` — bare specifier, no suffix).
Relative imports ALWAYS end in `.js`; workspace package imports are bare (`@se373/contracts`). Violations fail `tsc -b` under `moduleResolution: nodenext`.

### Contracts-type-only consumption

**Source:** `packages/mcp-server/src/index.ts` lines 1-6; `packages/access-policy/src/index.ts` lines 1-6; `packages/agent/src/index.ts` lines 1-6.
All three shells share one idiom: `import type { DbToolError } from "@se373/contracts"`. New code imports runtime helpers (`dbToolError`, schemas) the same way but WITHOUT `type` (e.g. `import { dbToolError } from "@se373/contracts"`); zod schemas via `import * as z from "zod"`.

### Test file shape

**Source:** `packages/contracts/test/tools.test.ts` lines 1-8 (imports, `describe/it`); `packages/access-policy/test/shell.test.ts` lines 1-9 (minimal shell-test shape for stub behavior tests).
All tests: `import { describe, expect, it } from "vitest"`, `include: ["test/**/*.test.ts"]`, `environment: "node"`. Live-gated file additionally uses `describe.skipIf(!process.env.DATABASE_URL)` (RESEARCH.md-verified, no in-repo analog yet).

### Package wiring checklist (D-03)

**Source:** `packages/mcp-server/{package.json,tsconfig.json}` + `packages/contracts/{package.json,vitest.config.ts}` + root files, all verified git-tracked.
Every new package repeats: `package.json` (name/version/type-module/scripts + `workspace:*` dep + `exports`/`files`/`build` per contracts), `tsconfig.json` (extend base, `outDir/dist`, `rootDir/src`, `composite`, `include: ["src"]`, `references`), `vitest.config.ts` (contracts shape), root `tsconfig.json` reference, `vitest.workspace.ts` entry, CODEOWNERS line.

## No Analog Found

| File | Role | Data Flow | Reason planner must use RESEARCH.md instead |
|---|---|---|---|
| `packages/sql-guard/test/fixtures.ts` | test fixture | batch | First shared fixture module; content = Olist catalog in RESEARCH.md bypass-list header |
| `packages/mcp-server/src/db.ts` | service | request-response | First `pg`/`pg-cursor` code by design (D-02 trust boundary); Pattern 2 pseudocode + verified import facts are the spec |
| `packages/mcp-server/test/db.live.test.ts` | test | request-response | First `describe.skipIf` + `DATABASE_URL` gate; snippet in RESEARCH.md Code Examples |
| `packages/access-policy/src/sensitive-columns.ts` | utility | file-I/O | First YAML loader + first `node:fs` use; Pattern 4 schema + loader split are the spec |
| `policies/sensitive_columns.yaml` | config | file-I/O | `policies/` does not exist; shape dictated by `SensitiveColumnsSchema` in RESEARCH.md |
| `packages/sql-guard/src/guard.ts` (algorithm core) | service | transform | No AST code in repo; walk/deny algorithm from RESEARCH.md Pattern 1 + Code Examples (probe-verified) |

## Metadata

**Analog search scope:** `packages/contracts`, `packages/mcp-server`, `packages/access-policy`, `packages/agent` (`src` + `test` + manifests), `apps/` (listing only — out of Phase 3 scope), root `tsconfig.json`, `tsconfig.base.json`, `vitest.workspace.ts`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `.github/CODEOWNERS`, `docs/architecture.md`
**Files scanned:** 26 (all `Read`, no re-reads; `apps/api`, `apps/web`, `scripts/` not descended — no Phase 3 surface there)
**Git-track check:** all 26 analog paths verified tracked via `git ls-files` (non-empty for every path); no mirror/node_modules paths used. `node_modules/`, `.claude/` symlinks excluded per brief.
**Pattern extraction date:** 2026-10-26
