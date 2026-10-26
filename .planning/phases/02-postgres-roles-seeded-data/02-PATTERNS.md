# Phase 2: Postgres Roles + Seeded Data - Pattern Map

**Mapped:** 2026-10-26
**Files analyzed:** 23 (15 new, 8 modified)
**Analogs found:** 17 / 23 (6 with no analog — first `docker/` + HTTP-download/faker/COPY paths in repo)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `docker/docker-compose.yml` | config | infra | — (first compose file in repo) | no analog |
| `docker/initdb/01_roles.sql` | migration | DDL | — (first SQL migration in repo) | no analog |
| `docker/initdb/02_schemas.sql` | migration | DDL | — (first SQL migration in repo) | no analog |
| `docker/initdb/03_business.sql` | migration | DDL | — (first SQL migration in repo) | no analog |
| `packages/data/package.json` | config | build | `packages/sql-guard/package.json` + `packages/mcp-server/package.json` + `packages/access-policy/package.json` | exact |
| `packages/data/tsconfig.json` | config | build | `packages/sql-guard/tsconfig.json` | exact |
| `packages/data/vitest.config.ts` | config | build | `packages/sql-guard/vitest.config.ts` | exact |
| `packages/data/src/download.ts` | utility | file-I/O + request-response | `packages/access-policy/src/sensitive-columns.ts` (node:fs + @types/node part only) | partial |
| `packages/data/src/transform.ts` | utility | batch transform | `packages/sql-guard` pure-function style (via `test/guard.test.ts` import shape) | role-match |
| `packages/data/src/load.ts` | service | streaming batch (COPY) | `packages/mcp-server/src/db.ts` (pg Pool/query) | role-match |
| `packages/data/src/verify.ts` | service | request-response (CRUD reads) | `packages/mcp-server/src/db.ts` + `packages/mcp-server/src/errors.ts` | role-match |
| `packages/data/src/seeds.json` | config | file-I/O | `policies/sensitive_columns.yaml` | role-match |
| `packages/data/src/manifest.ts` (or `seed_manifest` schema) | model | transform | `packages/contracts/src/catalog.ts` + `packages/access-policy/src/sensitive-columns.ts` | exact |
| `packages/data/test/seeds.test.ts` | test | file-I/O | `packages/access-policy/test/sensitive-columns.test.ts` | exact |
| `packages/data/test/roles.live.test.ts` | test | request-response (live DB) | `packages/mcp-server/test/db.live.test.ts` | exact |
| `packages/data/test/load.unit.test.ts` | test | batch (pure) | `packages/sql-guard/test/guard.test.ts` | exact |
| `packages/data/test/verify.live.test.ts` | test | request-response (live DB) | `packages/mcp-server/test/db.live.test.ts` | exact |
| `package.json` (root scripts) | config | build | self (existing `scripts` block) | exact |
| `tsconfig.json` (root) | config | build | self (existing `references` array) | exact |
| `vitest.workspace.ts` | config | build | self (existing project list) | exact |
| `.github/CODEOWNERS` | config | build | self (existing `packages/*/` rows) | exact |
| `.env.example` | config | build | self (existing commented-var style) | exact |
| `.gitignore` / `.openwikiignore` | config | build | self (existing `data/*` + secret patterns) | exact |
| `docs/architecture.md` (§7/§Status) | doc | — | self (existing Status table row pattern) | exact |
| `data/seeded_scenarios.md` | doc | — | — (first data doc; hiding rule is the pattern) | no analog |
| `README` licence/transform section (DATA-07) | doc | — | — (no README licence precedent in repo) | no analog |

All analog paths verified git-tracked (`git ls-files` non-empty for every path named below). `.claude/skills/` symlinks, `node_modules/`, `dist/` were not used as analogs.

## Pattern Assignments

### `packages/data/package.json` (config, build)

**Analog:** `packages/sql-guard/package.json` (lines 1-22) for the test/build script shape; `packages/mcp-server/package.json` (lines 1-19) for the `pg` + `@types/pg` dependency shape; `packages/access-policy/package.json` (lines 1-17) for `@types/node` + `yaml`/`zod` shape.

**Scripts pattern** (`packages/sql-guard/package.json:12-16`):
```json
"scripts": {
  "build": "tsc -b",
  "typecheck": "tsc -b",
  "test": "tsc -b && vitest run"
},
```

**Runtime dep pattern** (`packages/mcp-server/package.json:9-18` — driver + types split):
```json
"dependencies": {
  "@se373/contracts": "workspace:*",
  "pg": "^8.23.1"
},
"devDependencies": {
  "@types/pg": "^8.23.1"
}
```

**Node-types pattern** (`packages/access-policy/package.json:14-16` — required by any file importing `node:fs`, which `download.ts` / `seeds.json` file loading will):
```json
"devDependencies": {
  "@types/node": "^24.19.2"
}
```

**New deps to add** (no repo precedent — versions from RESEARCH §Standard Stack, human-gated): `pg-copy-streams@^7.0.0`, `csv-parse@^7.0.3`, `@faker-js/faker@^10.6.7`, `zod@^4.6.7` (shared copy), `tsx` run via root devDep; dev: `@types/pg-copy-streams@^1.2.5`. Planner: exact install command is in RESEARCH.md lines 105-109.

### `packages/data/tsconfig.json` (config, build)

**Analog:** `packages/sql-guard/tsconfig.json` (lines 1-11); multi-reference shape from `packages/mcp-server/tsconfig.json` (lines 1-11).

**Config pattern** (`packages/sql-guard/tsconfig.json:1-11`):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo",
    "rootDir": "src",
    "composite": true
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }]
}
```

Compiler flags come from `tsconfig.base.json` (lines 1-16): `strict`, `nodenext` module/resolution, `resolveJsonModule: true` (matters for `seeds.json` import), `isolatedModules`. Planner: `references` is `[{ "path": "../contracts" }]` only unless the catalog export needs more (D-11 deferred it to Phase 4, so contracts-only). Root `tsconfig.json:4` gains `{ "path": "packages/data" }` in the existing `references` array.

### `packages/data/vitest.config.ts` (config, build)

**Analog:** `packages/sql-guard/vitest.config.ts` (lines 1-8) — copy verbatim, no changes needed.

**Config pattern** (full file):
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

Root `vitest.workspace.ts` (lines 1-10) gains `"packages/data"` in the exported array, same position style as the other `packages/*` entries.

### `packages/data/src/download.ts` (utility, file-I/O + request-response)

**Analog:** `packages/access-policy/src/sensitive-columns.ts` (lines 1-52) — partial match: only the Node filesystem + `@types/node` + fail-fast error conventions. There is **no HTTP-download analog** in the repo (no `fetch`/stream-download code exists); the HTTPS + SHA-256 + `data/.cache/` logic follows RESEARCH.md §Olist source map, not a codebase analog.

**Imports pattern** (`packages/access-policy/src/sensitive-columns.ts:4-7` — `node:` prefix, explicit `.js` ESM suffixes per `nodenext`):
```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import * as z from "zod";
```

**Fail-fast error pattern** (`packages/access-policy/src/sensitive-columns.ts:32-41` — wrap parse, throw `Error` with context prefix):
```typescript
let parsed: unknown;
try {
  parsed = parseYaml(yamlText);
} catch (error) {
  throw new Error(
    `Invalid sensitive_columns YAML: ${error instanceof Error ? error.message : String(error)}`,
  );
}
```

**Env-override pattern** (`packages/access-policy/src/sensitive-columns.ts:46-52` — explicit arg beats env beats default; copy the precedence order for cache-dir / URL overrides):
```typescript
const resolved = override ?? process.env["SENSITIVE_COLUMNS_PATH"] ?? path;
```

Planner notes: `download.ts` needs `node:fs`/`node:path`/`node:crypto` (SHA-256) — the `@types/node` devDep from access-policy is mandatory. D-02 requires the missing-token/missing-network failure to print how to get access — no analog; write fresh per RESEARCH.

### `packages/data/src/transform.ts` (utility, batch transform)

**Analog:** `packages/sql-guard` pure-function style — role-match. The guard package is the repo's only pure-transform precedent (no DB, no fs in core logic). Import shape visible in `packages/sql-guard/test/guard.test.ts:1-4`:
```typescript
import { sqlGuard, warmupSqlGuard } from "../src/guard.js";
```

Conventions to copy:
- Pure functions: data in, data out; no `pg`, no `node:fs` in transform core (mirrors the sql-guard purity rule enforced at `eslint.config.mjs:42-63` — sql-guard must never import `pg`/`pg-cursor`).
- `.js` ESM import suffixes under `nodenext` (see `sensitive-columns.test.ts:9`: `"../src/sensitive-columns.js"`).
- Faker usage (`new Faker({ locale: [vi, en, base] })`, single `faker.seed()`) and the maps (province/category/rate/date-shift) have **no codebase analog** — follow RESEARCH.md §Vietnamization maps + Pitfalls P4/P5/P7 (unmapped-category fallbacks, +2905d shift, `[vi,en,base]` fallback chain).

### `packages/data/src/load.ts` (service, streaming batch)

**Analog:** `packages/mcp-server/src/db.ts` (lines 1-154) — role-match for `pg` Pool ownership, query issuance, and error funneling. COPY streaming itself (`pg-copy-streams` `COPY ... FROM STDIN` piped from `csv-parse`) has **no codebase analog** — follow RESEARCH.md §Don't Hand-Roll + benchmark note (1M rows / 4.7s, single txn).

**Imports pattern** (`packages/mcp-server/src/db.ts:1-10` — driver first, workspace contracts second, local last):
```typescript
import { Pool, type PoolClient } from "pg";
import Cursor from "pg-cursor";
import type {
  DbToolError,
  RunQueryOutput,
  SchemaCatalog,
} from "@se373/contracts";
import { dbToolError } from "@se373/contracts";
import { sqlGuard } from "@se373/sql-guard";
import { sanitizeError } from "./errors.js";
```

**Pool + query pattern** (`packages/mcp-server/test/db.live.test.ts:15-17` — construction from `DATABASE_URL`; loader uses the `owner` URL instead):
```typescript
const pool = new PgPoolAdapter(
  new Pool({ connectionString: process.env.DATABASE_URL }),
);
```

**Error-handling pattern** (`packages/mcp-server/src/db.ts:115-154` — connect in its own try, work in a second try, `ROLLBACK` on failure, `release()` in `finally`; funnel through one formatter):
```typescript
let client: ClientLike;
try {
  client = await pool.connect();
} catch (err) {
  return sanitizeError(err);
}
try {
  // ... load work ...
} catch (err) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Connection already broken — release in finally still runs.
  }
  return sanitizeError(err);
} finally {
  client.release();
}
```

**Credential-hygiene pattern** (`packages/mcp-server/src/errors.ts:13-33` — DSN/host/IP/user redaction; loader/verifier logs must never print the owner URL; `db.live.test.ts:10` notes "Credentials never appear in assertions or names").

Planner notes: D-03 — `packages/data` is operator tooling and **may** import `pg`; the ESLint ban (`eslint.config.mjs:8-41`) covers only `packages/agent/**` and `apps/**`, so no lint change is needed. Load order is load → expand ×9 → inject seeds → manifest (RESEARCH Pitfall P6).

### `packages/data/src/verify.ts` (service, request-response reads)

**Analog:** `packages/mcp-server/src/db.ts` (lines 85-154, `runQuery`) + `packages/mcp-server/src/errors.ts` (lines 48-101, `contractCodeFor` + `sanitizeError`).

**Guard-then-query shape** (`packages/mcp-server/src/db.ts:110-114` — validate before touching a connection; verify validates counts/shapes before asserting signals):
```typescript
const guarded = await sqlGuard(sql, catalog);
if (!guarded.ok) {
  return guarded.error;
}
```

**PG-code mapping pattern** (`packages/mcp-server/src/errors.ts:48-69` — switch on SQLSTATE string; verify maps its own assertion failures to exit codes the same explicit way):
```typescript
function contractCodeFor(code: string | undefined): ErrorCode {
  switch (code) {
    case "57014": // query_canceled (statement_timeout)
      return "TIMEOUT";
    // ...
    case "25006": // read_only_sql_transaction (write slipped past the guard)
    case "42501": // insufficient_privilege
      return "FORBIDDEN_STATEMENT";
```

**Message-cap pattern** (`packages/mcp-server/src/errors.ts:97-100` — cap composed output; the verify report is likewise bounded and structured):
```typescript
if (composed.length > 500) {
  composed = composed.slice(0, 500);
}
```

Planner notes: `data:verify` prints a structured report and exits non-zero on any failed assertion (CONTEXT Specifics); each check reuses the reference SQL shapes in RESEARCH.md §Seeded reference SQL (UC-05 pct-drop, UC-10 returns count, injection `LIKE '%ignore previous instructions%'`).

### `packages/data/src/seeds.json` (config, file-I/O)

**Analog:** `policies/sensitive_columns.yaml` (shape referenced at `packages/access-policy/test/sensitive-columns.test.ts:11-21`) — role-match: declarative data file owned by non-loader authors, validated by a strict zod schema at load, fail-closed on violation.

**Fixture shape analog** (`packages/access-policy/test/sensitive-columns.test.ts:11-21`):
```yaml
version: 1
columns:
  - table: customers
    column: phone
```

Planner notes: prefer JSON over YAML per RESEARCH (no new dep — `resolveJsonModule` is already on in `tsconfig.base.json:13`). Schema per RESEARCH Pattern 3: `{scenarios_uc05: [...], anomalies_uc10: [...], injections: [...]}` each with `{id, description, dimension filter, period, magnitude, reference_sql}`. Validated with `zod` `strictObject` exactly like `SensitiveColumnsSchema` below. UC owners edit this file only — loader code must not need changes for new seeds (D-04).

### `packages/data/src/manifest.ts` (model, transform)

**Analog:** `packages/contracts/src/catalog.ts` (lines 1-13) for minimal zod-schema-module shape; `packages/access-policy/src/sensitive-columns.ts` (lines 9-19) for the `strictObject` + inferred-type idiom.

**Schema-module pattern** (`packages/contracts/src/catalog.ts:1-13`):
```typescript
import * as z from "zod";

// Injected schema catalog for the SQL guard (Phase 3, D-05): ...
export const SchemaCatalogSchema = z.object({
  tables: z.record(z.string(), z.array(z.string())),
});

export type SchemaCatalog = z.infer<typeof SchemaCatalogSchema>;
```

**Strict-schema idiom** (`packages/access-policy/src/sensitive-columns.ts:9-19` — prefer `strictObject` + `literal` version + inferred type export):
```typescript
export const SensitiveColumnsSchema = z.strictObject({
  version: z.literal(1),
  columns: z.array(
    z.strictObject({
      table: z.string().min(1),
      column: z.string().min(1),
    }),
  ),
});

export type SensitiveColumns = z.infer<typeof SensitiveColumnsSchema>;
```

Planner notes: manifest = `{seed, dataset_version, per-table {rows, sha256 of canonical ORDER BY pk CSV}}`; loader refuses to finish on mismatch; `data:verify` recomputes (RESEARCH Pattern 2).

### `packages/data/test/seeds.test.ts` (test, file-I/O)

**Analog:** `packages/access-policy/test/sensitive-columns.test.ts` (lines 1-114) — exact match: zod validation unit tests + file/env-override tests, no DB (runs in CI).

**Test-file imports pattern** (lines 1-9 — `node:` stdlib, `vitest`, relative `.js` source import):
```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENSITIVE_COLUMNS_PATH,
  loadSensitiveColumns,
  loadSensitiveColumnsFile,
} from "../src/sensitive-columns.js";
```

**Validation-matrix pattern** (lines 38-76 — one `it` per rejection: missing version, wrong literal, empty value, extra keys via strictness, malformed input):
```typescript
it("rejects a missing version", () => {
  expect(() =>
    loadSensitiveColumns("columns:\n  - table: customers\n    column: phone\n"),
  ).toThrow();
});
```

**Source-scan pattern for DATA-05** — no exact analog (first of its kind); extend the above file's style: read agent/app source trees with `node:fs`, assert no reference to gold/seed paths (`data/seeded_scenarios.md`, `seeds.json`, `seed_manifest.json`). RESEARCH §Don't Hand-Roll: "test is the boundary" — ESLint alone is insufficient for `fs.readFile` string paths. This test must run in CI (no DB, no `skipIf`).

### `packages/data/test/roles.live.test.ts` (test, request-response live DB)

**Analog:** `packages/mcp-server/test/db.live.test.ts` (lines 1-33) — exact match: `skipIf(!DATABASE_URL)` gate, `Pool` from `pg`, adapter close in `finally`.

**Skip-gate pattern** (lines 11-13 — whole file skips without DB; CI stays green-by-skip):
```typescript
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("db live (requires DATABASE_URL)", () => {
```

**Pool-lifecycle pattern** (lines 14-32 — construct per test, `pool.end()` in `finally`, contract-schema assert on success):
```typescript
const pool = new PgPoolAdapter(
  new Pool({ connectionString: process.env.DATABASE_URL }),
);
try {
  const result = await runQuery(pool, "SELECT 1 AS one", { tables: {} }, {
    maxRows: 10,
  });
  if ("code" in result) throw new Error(`live query failed: ${result.code}`);
  expect(result.rowCount).toBe(1);
  // ...
  expect(() => RunQueryOutputSchema.parse(result)).not.toThrow();
} finally {
  await pool.end();
}
```

**Override-path assertion shape** (from RESEARCH.md lines 307-315 — the planner's core new logic; separate driver calls per statement, assert `42501`/`57014`, never combine SET+write in one string per Pitfall P1):
```typescript
// test/roles.live.test.ts — skipIf(!process.env.DATABASE_URL), DATABASE_URL → agent_ro
const q = (c: Client, sql: string) => c.query(sql); // separate driver calls
await q(ro, `SET default_transaction_read_only = off`);
await expect(q(ro, `INSERT INTO business.orders(status) VALUES('x')`))
  .rejects.toMatchObject({ code: '42501' });
await expect(q(ro, `CREATE TEMP TABLE t(id int)`)).rejects.toMatchObject({ code: '42501' });
await expect(q(ro, `SELECT pg_sleep(31)`)).rejects.toMatchObject({ code: '57014' });
```

Planner notes: `DATABASE_URL` here points at `agent_ro` (D-06); cover the full matrix in RESEARCH Pattern 1 (INSERT/UPDATE/DELETE, CREATE, TEMP, SELECT INTO, BEGIN READ WRITE, nextval, SET ROLE — 42501 after override; pg_sleep — 57014).

### `packages/data/test/load.unit.test.ts` (test, batch pure)

**Analog:** `packages/sql-guard/test/guard.test.ts` (lines 1-192) — exact match for pure-function unit style: no DB, `describe` per area, `expect(...).toEqual` on outputs.

**Pure-test pattern** (lines 11-28 — named cases `V1…`, direct return-value asserts, no fixtures beyond a catalog object):
```typescript
it("V1 accepts a no-FROM baseline", async () => {
  const result = await sqlGuard("SELECT 1", fixtureCatalog);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.tables).toEqual([]);
  }
});
```

**Helper-assert pattern** (lines 186-192 — shared `expectReject`-style helper for matrix cases):
```typescript
async function expectReject(sql: string, code: string): Promise<void> {
  const result = await sqlGuard(sql, fixtureCatalog);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(code);
  }
}
```

Planner notes: cases = province map covers all 27 BR codes → 34 VN provinces, 3 unmapped-category fallbacks (P4), date-shift +2905d weekday-preserving with pre-2025 clip (P5), faker determinism (same seed → identical sequence), manifest hash stability. No DB → runs in CI.

### `packages/data/test/verify.live.test.ts` (test, request-response live DB)

**Analog:** `packages/mcp-server/test/db.live.test.ts` (lines 1-33) — same `skipIf` + `Pool` + `finally end()` scaffolding as `roles.live.test.ts` above; asserts row counts, FK integrity (zero orphans), per-seed reference-SQL magnitudes, and `order_items ≥ 1,000,000`.

---

## Shared Patterns

### Package wiring (new `packages/data`)

**Source:** `packages/sql-guard/package.json:12-16`, `packages/sql-guard/tsconfig.json:1-11`, `vitest.workspace.ts:1-10`, `tsconfig.json:4`, `.github/CODEOWNERS:9`, `docs/architecture.md:43-52`.
**Apply to:** `packages/data/` scaffold task + root wiring edits.

```json
// tsconfig reference (root tsconfig.json:4 gains one entry)
"references": [{ "path": "packages/contracts" }, /* …existing… */, { "path": "packages/data" }]
```

```typescript
// vitest.workspace.ts — append one string entry
"packages/data",
```

```
# .github/CODEOWNERS — one row, same handle pattern as sibling rows (line 9)
packages/data/ @HungPham-VNU @NDTruongDanh # TODO(UC-09 owner): replace with handle during review
```

`docs/architecture.md` Status table (§2, line ~52): add `| packages/data | Deterministic Olist loader + verifier (operator tooling, owner role; never imported by agent code) | 🔜 Phase 2 |` in the same `| backtick-path | description | status |` shape. `packages/data` row in CODEOWNERS/docs uses the UC-09-owner TODO comment like the sql-guard/mcp-server rows (loader is DB-trust code).

### Live-test skip gate (all DB-touching tests)

**Source:** `packages/mcp-server/test/db.live.test.ts:11-13`.
**Apply to:** `roles.live.test.ts`, `verify.live.test.ts`, and any other DB-touching test.

```typescript
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("db live (requires DATABASE_URL)", () => {
```

CI without Postgres stays green-by-skip; no connection is ever attempted when the var is unset (comment at `db.live.test.ts:6-10` explains why — copy that comment). D-06 exception: the Phase 3 `db.live.test.ts` must be *run* (not skipped) with `DATABASE_URL` → `agent_ro` at the phase gate — that is a runbook step, not a code change.

### Error sanitizing (loader + verifier)

**Source:** `packages/mcp-server/src/errors.ts:75-101`.
**Apply to:** `load.ts`, `verify.ts` — funnel every driver catch through one formatter; never log the owner `DATABASE_URL`/DSN (redaction patterns at `errors.ts:13-33`).

```typescript
export function sanitizeError(err: unknown): DbToolError {
  const fields =
    typeof err === "object" && err !== null
      ? (err as Record<string, unknown>)
      : {};
  // pick message/detail/hint → redactInfra/redactPath → strip stack frames → cap 500
  return dbToolError(contractCodeFor(pgCode(err)), composed);
}
```

`verify.ts` additionally maps its own assertion failures to a non-zero exit (CONTEXT Specifics) — same explicit-switch style as `contractCodeFor` (`errors.ts:48-69`).

### Zod-validated declarative files (seeds + manifest)

**Source:** `packages/access-policy/src/sensitive-columns.ts:9-52` + `packages/contracts/src/catalog.ts:1-13`.
**Apply to:** `seeds.json` loader, `manifest.ts`.

- Pure parse function (text in → validated config out, throws fail-fast) + thin fs wrapper with `override ?? env ?? default` precedence (`sensitive-columns.ts:31-52`).
- `z.strictObject` + `z.literal(1)` version + `z.infer` type export (`sensitive-columns.ts:9-19`).
- Default path resolved from module location via `fileURLToPath(new URL(...))` so it works regardless of caller cwd (`sensitive-columns.ts:24-26`).

### Env-file conventions (`.env.example` additions)

**Source:** `.env.example:1-36`.
**Apply to:** DB variable block appended to `.env.example`.

```bash
# Copy to `.env` for local runs (never commit `.env`).
```

Existing style: section header comment, one `VAR=value-or-empty` per line, commented-out optional vars, "paste the value yourself / save as Actions secret" guidance. New vars (D-09/D-05: db `chosen`, port `5433`, dev defaults acceptable local-only, never reused deployed): `POSTGRES_DB=chosen`, `POSTGRES_PORT=5433`, `POSTGRES_USER/POSTGRES_PASSWORD`, `OWNER_DATABASE_URL`, `DATABASE_URL` (agent_ro — the same name `db.live.test.ts` reads), `INDEXER_DATABASE_URL`. `.env` itself stays git-ignored (`.gitignore:5-7`).

### Gitignore / OpenWiki-ignore (cache + gold/seed hiding)

**Source:** `.openwikiignore:23-29` + `.gitignore:1-18`.
**Apply to:** `data/.cache/` coverage + DATA-05 hiding entries.

```
# .openwikiignore existing data-dump pattern (lines 23-28)
data/*.csv
data/*.parquet
data/*.db
data/*.sqlite
data/*.duckdb
```

Add: `data/.cache/`, `data/seeded_scenarios.md`, `packages/data/src/seeds.json`, `**/seed_manifest.json` (DATA-05 — planner confirms exact manifest filename). `.gitignore` needs `data/.cache/` + downloaded CSV coverage (`.gitignore` currently has no `data/` lines — only `.openwikiignore` does; the loader must also work if the executor adds them to `.gitignore`). The `seeds.test.ts` source-scan (above) is the enforcement; ignore-files are the mechanism.

### Root scripts (operator commands)

**Source:** `package.json:13-23` (existing `typecheck`/`lint`/`test`/`docs:interface` shape).
**Apply to:** `db:up`, `db:down`, `db:reset`, `data:load`, `data:verify` additions.

Exact commands from RESEARCH.md line 336: `db:up` → `docker compose --env-file .env -f docker/docker-compose.yml up -d --wait`; `db:down` → `stop`; `db:reset` → `down -v && up -d --wait`. `data:load`/`data:verify` → `tsx packages/data/src/load.ts` / `tsx packages/data/src/verify.ts` (D-03 mandates `tsx`; root already has `tsx@^4.23.15` devDep at `package.json:32`). Scripts use plain `docker compose`; the `sg docker -c "…"` workaround for pre-group shells goes in docs only (D-07).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `docker/docker-compose.yml` | config | infra | First Compose file in repo — no container precedent. Use RESEARCH.md §Docker Compose candidate (lines 317-336) verbatim, substituting D-09 names (`chosen`/5433). Healthcheck pattern has no analog; copy the `pg_isready` shape from research. |
| `docker/initdb/01_roles.sql` | migration | DDL | First SQL migration in repo — no SQL-file precedent. Use RESEARCH.md §Init SQL candidate (lines 267-303) verbatim; it was executed against the real `pgvector:0.8.7-pg16` image. Note the `chosan`→`chosen` rename (D-09; research used `chosan` as placeholder). |
| `docker/initdb/02_schemas.sql` | migration | DDL | Same as above — schemas + REVOKEs + per-role grants + `ALTER DEFAULT PRIVILEGES` (Pitfall P2: defaults before data tables). |
| `docker/initdb/03_business.sql` | migration | DDL | Same as above — 12-table DDL per RESEARCH §Schema map (line 362); D-10 fixes DDL here, loader does data-only. |
| `packages/data/src/download.ts` (HTTPS/SHA part) | utility | request-response | No HTTP-download code in repo. Use RESEARCH §Olist source map (pinned GitHub raw URLs + blob SHAs, `data/.cache/`). |
| `packages/data/src/load.ts` (COPY part) | service | streaming batch | No `pg-copy-streams` usage in repo. Use RESEARCH §Don't Hand-Roll (COPY FROM STDIN piped from `csv-parse`, single txn, 1M/4.7s). |
| `data/seeded_scenarios.md` | doc | — | First data doc in repo. Content per D-04 (UC-05 ×3, UC-10 ×5, injections ×3); hiding via `.openwikiignore` + scan test is the load-bearing pattern, not the prose. |
| `README` licence/transform section | doc | — | No licence-attribution precedent in repo. Content per DATA-07 + RESEARCH A3: Olist source URL, CC BY-NC-SA 4.0 attribution + ShareAlike, full transform log (rate 5150, +2905d shift, 34 provinces, ×9 expansion). |

## Metadata

**Analog search scope:** `packages/sql-guard/`, `packages/mcp-server/src/` + `test/`, `packages/access-policy/src/` + `test/`, `packages/contracts/src/`, root `package.json` / `tsconfig*.json` / `vitest.workspace.ts` / `eslint.config.mjs` / `.env.example` / `.gitignore` / `.openwikiignore`, `.github/CODEOWNERS`, `.github/workflows/ci.yml`, `docs/architecture.md`. (Per prompt: `packages/sql-guard` treated as newest package template; `node_modules/` and `dist/` excluded as non-project code; `.claude/skills/` excluded as git-excluded GSD symlinks.)
**Files scanned:** ~20 analog files read (6 in full detail + 8 config files + 6 supporting).
**Pattern extraction date:** 2026-10-26
