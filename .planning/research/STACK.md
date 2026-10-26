# Stack Research

**Domain:** TypeScript LangGraph.js analytics (text-to-SQL) agent harness over PostgreSQL, exposed via MCP server
**Researched:** 2026-10-25
**Confidence:** HIGH (all versions verified via `npm view` on 2026-10-25, Node 24 + pnpm 11.25.0; key APIs verified by unpacking published tarballs; docs cross-checked)

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| Node.js | 24.x (engines `>=24.0.0`) | Runtime | Repo already pins Node 24 (`package.json` engines); MCP SDK v1 needs Web Crypto (`globalThis.crypto`, see SDK FAQ); `--env-file` built in, no dotenv needed | HIGH |
| pnpm | 11.25.0 (via Corepack, `packageManager` field) | Package manager / workspaces | Verified installed (`pnpm --version`); strict `node_modules` layout catches phantom imports — useful for enforcing "agent must not import mcp-server db code" alongside ESLint | HIGH |
| typescript | `~6.0.3` (latest 6.x, verified) | Type system + `tsc --noEmit` typecheck | **6.0.x is the last JS-line compiler.** `typescript@7` (verified `latest = 7.0.2`) is the native Go port with **no stable programmatic API**; `@typescript-eslint/*@8.72.0` peers require `typescript >=4.8.4 <6.1.0`, so TS 7 breaks typed linting at install time (upstream issue, still open). TS 6.0.3 satisfies the peer range and keeps `tsc -b` project references working | HIGH |
| zod | `^4.6.7` (verified latest 4.6.7) | Shared contracts (`packages/contracts`): 5 db-tools I/O schemas, 11 error codes, `SQLAnswer`, trace envelope | The one version **all three consumers accept**: SDK v1 peers `^3.25 \|\| ^4.0`, `@langchain/mcp-adapters@1.1.4` deps `^3.25.76 \|\| ^4`, `@langchain/langgraph@1.5.2` peers `^3.25.32 \|\| ^4.2.0`, `@langchain/openai@1.7.0` deps `^3.25.76 \|\| ^4`. v4 also gives native `z.toJSONSchema()` (needed for UC-09 F14 interface docs) and is the forward path (mcp-adapters 2.x is zod-4-only). Write all schemas in v4 API; the `zod/v3` subpath exists as an escape hatch | HIGH |
| @modelcontextprotocol/sdk | `^1.32.2` (verified latest v1) | MCP server: `McpServer`, `StreamableHTTPServerTransport`, `requireBearerAuth` | Matches UC-09 plan exactly; verified in published tarball: `server/auth/middleware/bearerAuth.d.ts` exports `requireBearerAuth({ verifier, requiredScopes, ... })`, `registerTool` supports `outputSchema` + `structuredContent`, server+client Streamable HTTP transports present. v1 implements MCP spec **2025-11-25** and gets bug/security fixes until ~2027-01-27 (covers the whole course). See "What NOT to use" for why not v2 yet | HIGH |
| @langchain/langgraph | `^1.5.2` (verified latest) | Agent skeleton: typed state, nodes/edges, UC extension seams | Team standard (UC-01/02/09/10 plans); peers `@langchain/core ^1.1.48` + zod `^3.25.32 \|\| ^4.2.0` — consistent with the rest of the pin set | HIGH |
| @langchain/langgraph-checkpoint-postgres | `^1.1.2` (verified latest) | Durable agent state: `PostgresSaver` | Verified export (`PostgresSaver`, `PostgresSaverOptions`) in published `.d.ts`; deps `pg ^8.12.0` pair with our `pg` pin. Same Postgres instance, separate schema (e.g. `checkpoints`), owner-role migrations | HIGH |
| @langchain/core | `^1.3.0` (verified latest 1.3.0) | Base primitives (messages, runnables, structured output) | Required peer by langgraph (`^1.1.48`), checkpoint-postgres (`^1.1.44`), mcp-adapters 1.1.4 (`^1.0.0`), openai 1.7.0 (`^1.3.0`). Single hoisted copy at 1.3.0 satisfies all | HIGH |
| @langchain/mcp-adapters | `~1.1.4` (NOT 2.x) | Agent-side MCP client: `MultiServerMCPClient`, `loadMcpTools` | Verified: 1.1.4 deps `@modelcontextprotocol/sdk ^1.30.0` (same spec generation as our server) and exports `MultiServerMCPClient`, `StreamableHTTPConnection`, `loadMcpTools`. 2.x targets MCP **v2** packages (`@modelcontextprotocol/core/client ^2.2.0`) + zod `^4.4.3` only — client/server spec-generation mismatch risk. Pin the 1.x line (`~` to stay off 2.x) | HIGH |
| @langchain/openai | `^1.7.0` (verified latest) | Chat model for an OpenAI-compatible endpoint (`ChatOpenAI`) | Verified in published `.d.ts`: model inputs accept `configuration?: ClientOptions` (openai SDK options incl. `baseURL`/`apiKey`), so `new ChatOpenAI({ model, configuration: { baseURL, apiKey } })` targets any OpenAI-compatible gateway. Deps `openai ^7.23.0`, zod `^3.25.76 \|\| ^4` | HIGH |
| pg | `^8.23.1` (verified latest) | Postgres driver (`Pool`) for db.ts executor + migrations | Stable, matches checkpoint-postgres (`pg ^8.12.0`) and SDK-era ecosystem; types via `@types/pg@^8.23.1` (verified, version-matched) | HIGH |
| pg-cursor | `^2.22.1` (verified latest) | Bounded reads: `cursor.read(maxRows + 1)` + `truncated` flag | Exact mechanism UC-09 F2 requires; types via `@types/pg-cursor` (only `2.7.2` published — stale but API-stable `connect/read/close`; wrap in a tiny local `.d.ts`-checked helper and cover with tests) | MEDIUM-HIGH |
| pgsql-parser | `^18.3.1` (verified latest; grammar line 18) | `sqlGuard`: real-Postgres parse + AST search + `deparse` for masking rewrites | Real PG parser (libpg-query `18.2.1` + `pgsql-deparser 18.4.1` bundled as deps — verified). `parse` is **async** (WASM load once at server startup, never per request). Battle-tested per maintainers (23k+ statements). **Deparse round-trip verdict: YES for our needs** — parse→modify→deparse is the documented masking workflow (`SELECT * → masked projection` example in README); require a repo property test `deparse(parse(sql)) ≡ sql` (modulo whitespace/case) over the eval corpus to lock it in. Grammar-note: line-18 grammar is a *superset* of PG16 — a query using PG17/18-only syntax passes the guard but fails at execution with a clean error (fail-safe direction, never a bypass) | HIGH |
| @pgsql/traverse | `^18.8.1` (verified latest) | AST walking for guard (`FuncCall` denylist) + `resolveColumns` | `walk(ast, { SelectStmt, FuncCall, RangeVar, ... })` visitor API replaces hand-rolled recursion; major `18` matches the `pgsql-parser@18` AST shape | HIGH |
| express | `^5.3.0` (verified latest) | HTTP host for Streamable HTTP endpoint + `requireBearerAuth` middleware | SDK v1 itself depends on `express ^5.2.1` and ships its auth middleware as an Express `RequestHandler` (verified `.d.ts`) — Express 5 is the blessed host. `express-rate-limit@^8.7.1` (verified, peers `express >= 4.11`) available for the deferred F17 rate-limit | HIGH |
| PostgreSQL + pgvector (Docker) | `pgvector/pgvector:0.8.7-pg16` (verified via Docker Hub API; pushed 2026-10-01) | Read-only analytics DB + vectors for UC-02 | Pinned (not floating `pg16`): reproducible pgvector **0.8.7** on PG **16.x**. `bookworm`/`trixie` variants both exist; take plain `0.8.7-pg16` (default base) unless the team standardizes on trixie. 3 roles (`owner` / `agent_ro` / `indexer`); `agent_ro` gets `default_transaction_read_only=on` + `statement_timeout=30s` at the role level | HIGH |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino | `^10.4.0` (verified) | JSONL audit/trace logs with `redact` paths + PII-literal redaction | Always: `mcp-server` audit log and agent trace writer. Configure `redact` for DSN/password/host + a `sanitizeError()` single choke point (UC-09 F9/F10) |
| yaml | `^2.9.1` (verified) | Parse `policies/*.yaml` (clients, sensitive columns) | Always: validate parsed YAML with zod at startup; refuse to boot on invalid config (UC-09 §A.8) |
| @faker-js/faker | `^10.6.0` (verified `stable=latest=10.6.0`) | Synthetic PII seed data (vi locale) | Data loader only: `import { fakerVI } from '@faker-js/faker'` (verified `vi` → `fakerVI` in official locale table). **Caveat:** `vi` has thinner coverage than `en` — build `new Faker({ locale: [vi, en, base] })` fallback chain so missing entries don't throw during the ≥1M-row load |
| csv-parse | `^7.0.3` (verified) | Stream-parse Olist CSVs in `pnpm data:load` | Data loader only, piped into `pg-copy-streams` |
| pg-copy-streams | `^7.0.0` + `@types/pg-copy-streams@^1.2.5` (both verified) | Bulk `COPY FROM` load | Data loader only. Note the types package (`1.2.5`) lags the lib major — API surface used (`from(...)`) is stable; pin both and cover with a load smoke test |
| tsx | `^4.23.15` (verified) | Run TS scripts/tools/tests without a build step (`tsx watch` dev, `pnpm data:load`, eval runner) | Dev + scripts. Env: prefer Node 24 native `--env-file=.env` over a dotenv dependency (tsx 4 passes it through) |
| vitest | `^5.0.5` (verified latest stable; peers allow `vite ^8`) | Unit/integration tests (sqlGuard ≥30 cases, executor, masking, eval) | Always (dev). Pair with `vite@^8.3.5` + `@vitejs/plugin-react@^6.1.2` (verified peers `vite ^8.0.0`) so web + test share one Vite line. Coverage later via `@vitest/coverage-v8@5.0.5` if needed |
| vite + @vitejs/plugin-react + react | `vite ^8.3.5`, `plugin-react ^6.1.2`, `react ^19.3.1` (all verified) | `apps/web` shell (empty Vite+React for M1; audit page later) | Web shell only in M1 |
| @types/node | `^24.19.2` (latest on the 24 line, verified) | Node API types | Dev, all packages — match the Node 24 runtime, not the `latest` 26.x line |
| @types/express | `^5.0.6` (verified) | Express 5 types | Dev, `mcp-server` |
| typescript-eslint (`typescript-eslint` meta-package) | `^8.72.0` (verified) | `no-restricted-imports` (agent↛db ban, UC-09 F11) + recommended rule sets, flat config | Always (dev). Flat `eslint.config.mjs`; parser peers allow eslint `^10` + TS `<6.1.0` — consistent with our pins |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| gitleaks-action | Secret scanning in CI | **`gitleaks/gitleaks-action@v3`** (verified latest; v3.0.0 released 2026-05-30). **v2 is dead** — Node 20 runtime removed from GitHub runners 2026-09-16. Migrate any UC-doc snippets still saying v2 |
| MCP Inspector | Manual 5-tool + 2-resource verification (UC-09 F12) | `npx @modelcontextprotocol/inspector` (v1 line, pairs with SDK 1.32 server) |
| Docker Compose | `pnpm db:up` — Postgres 16 + pgvector + role init scripts | `docker/initdb/01_roles.sql` creates the 3 roles; keep image tag in one place (`docker/.env` or compose file) |
| `tsc -b` (project references) | Fast, correct cross-package builds/typecheck | See "Stack Patterns" below |

## Installation

```bash
# Root (pnpm 11.25.0 via corepack; Node 24)
corepack up   # or: corepack prepare pnpm@11.25.0 --activate

# Shared contracts — every package depends on this, nothing depends on them
pnpm --filter @shop/contracts add zod@^4.6.7

# MCP server (db-tools: guard + executor + audit + auth)
pnpm --filter @shop/mcp-server add \
  @modelcontextprotocol/sdk@^1.32.2 express@^5.3.0 \
  pg@^8.23.1 pg-cursor@^2.22.1 \
  pgsql-parser@^18.3.1 @pgsql/traverse@^18.8.1 \
  pino@^10.4.0 yaml@^2.9.1 zod@^4.6.7
pnpm --filter @shop/mcp-server add -D \
  typescript@~6.0.3 @types/node@^24.19.2 @types/express@^5.0.6 \
  @types/pg@^8.23.1 @types/pg-cursor@^2.7.2 \
  tsx@^4.23.15 vitest@^5.0.5

# Agent skeleton (LangGraph.js + MCP client + checkpoint)
pnpm --filter @shop/agent add \
  @langchain/langgraph@^1.5.2 @langchain/core@^1.3.0 \
  @langchain/openai@^1.7.0 @langchain/mcp-adapters@~1.1.4 \
  @langchain/langgraph-checkpoint-postgres@^1.1.2 zod@^4.6.7

# Access-policy package (UC-08 seam; ColumnScopePolicy lives here in M1)
pnpm --filter @shop/access-policy add zod@^4.6.7 pgsql-parser@^18.3.1

# Data loader (one-shot scripts, may live under packages/mcp-server or tools/)
pnpm --filter @shop/mcp-server add -D \
  @faker-js/faker@^10.6.0 csv-parse@^7.0.3 \
  pg-copy-streams@^7.0.0 @types/pg-copy-streams@^1.2.5

# Web shell
pnpm --filter @shop/web add react@^19.3.1
pnpm --filter @shop/web add -D vite@^8.3.5 @vitejs/plugin-react@^6.1.2

# Root dev tooling
pnpm add -Dw typescript@~6.0.3 eslint@^10.13.0 typescript-eslint@^8.72.0 \
  tsx@^4.23.15 vitest@^5.0.5
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| SDK v1 `^1.32.2` (spec 2025-11-25) | MCP v2 split packages (`@modelcontextprotocol/server/client@2.4.0`, Standard Schema) | **After this milestone**, as a planned migration: v1 support ends ~2027-01; v2 is the future. Not now — would invalidate every UC-09/UC-01 code sketch and the Inspector version pinned in docs, with zero grading benefit |
| `@langchain/mcp-adapters@~1.1.4` | `@langchain/mcp-adapters@2.x` | Only together with the MCP-v2 server migration above (2.x speaks MCP v2 + zod-4-only) |
| `pgsql-parser@^18.3.1` | `@pgsql/parser@1.6.2` (`new Parser({ version: 16 })`) | If the team wants **byte-exact PG16 grammar** in the guard (multi-version package supports 13–17 with runtime selection). Trade-off: separate deparse story (pair with `pgsql-deparser@^18.4.1`); recommended only if eval shows grammar-superset issues with line 18 |
| `pgsql-parser` (real PG grammar) | `node-sql-parser` | Fallback only (per UC-09 plan): easier API but weaker PG-dialect coverage — unacceptable for a security guard that must not misclassify statements |
| zod v4 `^4.6.7` | zod v3 `~3.25.76` | Only if a dependency forces classic API AND the `zod/v3` subpath of the v4 package proves insufficient (unlikely — SDK/adapters/langgraph all accept v4 ranges; verified above) |
| `z.toJSONSchema()` (zod native) | `zod-to-json-schema` | Never with v4 schemas — that lib is **v3-only** and throws on v4 schemas. Native method covers F14 docs generation |
| typescript `~6.0.3` | `typescript@7` / `@typescript/native-preview` (`tsgo`) | TS 7 binary may be added **side-by-side** later purely as a fast `tsgo --noEmit` CI check; it must NOT replace the `typescript` dep until typescript-eslint supports the 7.x API (blocked on TS 7.1) |
| Node `--env-file` | `dotenv` | Skip dotenv — one less dependency; Node 24 loads env files natively |
| `pgvector/pgvector:0.8.7-pg16` (pinned) | `pgvector/pgvector:pg16` (floating) | Never in committed compose files — floating tags break eval reproducibility (`pnpm data:load` twice must give the same DB) |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@modelcontextprotocol/server` / `/client` v2 + `@modelcontextprotocol/express` | New spec generation (2026-07-28) + Standard-Schema tool registration; incompatible with the mcp-adapters 1.x client and every UC-09 code sketch. Migration is a post-milestone roadmap item | `@modelcontextprotocol/sdk@^1.32.2` |
| `@langchain/mcp-adapters@2.x` | Pulls `@modelcontextprotocol/core/client ^2.2.0` (MCP v2 wire) against our v1 server; zod `^4.4.3`-only narrows the shared range for no benefit | `@langchain/mcp-adapters@~1.1.4` |
| `typescript@7.x` as the `typescript` dep | No JS compiler API → `typescript-eslint` (peers `<6.1.0`) crashes; any API consumer (`ts.sys`, `ts.ScriptKind`) breaks | `typescript@~6.0.3`; optional side-by-side `tsgo` later |
| `zod-to-json-schema` | v3-only; throws on the v4 schemas used in `contracts` | `z.toJSONSchema()` |
| `sqlglot` / Python in the agent path | PRD §1.5 + team decision: TS-only harness; sqlglot has no TS equivalent anyway | `pgsql-parser` + `@pgsql/traverse` |
| Hosted text-to-SQL/BI agents (Vanna, Copilot, Genie…) | Banned by PRD §1.5.1 (UC scored zero) | Build on the harness |
| `jose` (JWT) + `express-rate-limit` in M1 | UC-09 F17/F18 are P2, post-harness UC-09 work; adding auth-server machinery now delays the shared skeleton | Defer; note `requireBearerAuth` already accepts `expectedResource` for later hardening |
| `langsmith` (tracer) in M1 | Team trace format is JSONL files (`runId`-keyed); LangSmith is an optional later backend | `pino` JSONL writers in harness; keep span field names LangSmith-compatible |
| `dotenv` | Redundant on Node 24 | `--env-file` |
| `pgvector/pgvector:pg16` floating tag | Unpinned extension version → non-reproducible seeds/evals | `pgvector/pgvector:0.8.7-pg16` |
| `gitleaks/gitleaks-action@v2` | Node 20 runtime removed from runners 2026-09-16; workflows fail | `gitleaks/gitleaks-action@v3` |

## Stack Patterns by Variant

**Monorepo layout (pnpm workspaces + TS project references, recommended):**
- `pnpm-workspace.yaml` lists `apps/*` + `packages/*`; every package has `name: @shop/<n>`, all cross-imports via `workspace:*` (single version of `zod`, `@langchain/*`, SDK — critical for the zod-compat matrix above; duplicates break `instanceof` and peer ranges).
- Each package `tsconfig.json`: `composite: true`, `declaration: true`, `declarationMap: true`, `references: [{ path: "../contracts" }]` where needed; root `tsconfig.json` with `files: []` + `references` to all packages so `tsc -b` builds the graph and CI `tsc --noEmit` is incremental. (TS handbook: Project References.)
- `packages/contracts` exports **zod schemas as the single source of truth** plus `export type X = z.infer<typeof XSchema>` — server `registerTool({ ... }, inputSchema, ...)` consumes schemas directly; `outputSchema` gives `structuredContent`; agent + web import the same schemas for validation and `z.toJSONSchema()` generates `docs/mcp_interface.md` (F14). No hand-written duplicate interfaces.

**If the team hits WASM load issues with pgsql-parser in CI/vitest:**
- Keep one module-level `await parse(...)` warm-up (server boot + test setup file); do not lazy-load per request. Fallback is `node-sql-parser` for *validation only* (never for masking rewrites), flagged in eval.

**If a UC needs embeddings before UC-02 lands:**
- Add `pgvector@^0.3.0` (verified npm client) to the indexer script only — never to the agent read path.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `zod@4.6.7` | SDK 1.32 (`^3.25 \|\| ^4.0`) · adapters 1.1.4 (`^3.25.76 \|\| ^4`) · langgraph 1.5.2 (`^3.25.32 \|\| ^4.2.0`) · openai 1.7.0 (`^3.25.76 \|\| ^4`) | Single shared version; verified from each package's published deps/peers. `zod/v3` subpath available as escape hatch |
| `@modelcontextprotocol/sdk@1.32.2` | `express@5.3.0` (needs `^5.2.1`) · `express-rate-limit@8.7.1` · `jose@^6` · `zod-to-json-schema@^3.25.1` (internal use only; SDK handles v4 schemas itself) | v1 = spec 2025-11-25. Client (adapters 1.1.4 → SDK `^1.30.0`) and server on the same generation — no protocol-version negotiation risk |
| `@langchain/*@1.x` set (langgraph 1.5.2 / core 1.3.0 / openai 1.7.0 / checkpoint-postgres 1.1.2 / mcp-adapters 1.1.4) | `@langchain/core@1.3.0` hoisted once | All peer ranges include core `^1.0.0`–`^1.3.0`; pin core exactly and let pnpm dedupe. checkpoint-postgres peers `langgraph-checkpoint ^1.2.0` (have 1.2.1, verified) |
| `typescript@~6.0.3` | `typescript-eslint@8.72.0` (peers `>=4.8.4 <6.1.0`) · `eslint@10.13.0` (flat config) | `~` keeps the JS-line compiler; `^` would also stay `<7` but `~` signals intent. TS 7.x violates the parser peer range |
| `vitest@5.0.5` | `vite@8.3.5` (peers `^6.4 \|\| ^7 \|\| ^8`) · `@vitejs/plugin-react@6.1.2` (peers `vite ^8`) · Node 24 (`@types/node ^22 \|\| >=24`) | One Vite line for test + web |
| `pg@8.23.1` | `pg-cursor@2.22.1` · checkpoint-postgres (`pg ^8.12.0`) · `pg-copy-streams@7.0.0` (driver API) | Types: `@types/pg@8.23.1` exact-match; `@types/pg-cursor@2.7.2` / `@types/pg-copy-streams@1.2.5` lag majors but cover the stable APIs used |
| `pgsql-parser@18.3.1` | `libpg-query@18.2.1` + `pgsql-deparser@18.4.1` (bundled deps) · `@pgsql/traverse@18.8.1` (same AST major) · `@pgsql/types@17.6.2` (latest published; 17→18 AST shape compatible for guard use) | Parse is async/WASM; load once at boot |
| `pgvector/pgvector:0.8.7-pg16` | PG 16.x server; `pgsql-parser` line-18 guard (superset — fail-safe, see above) | If exact-grammar parity is ever required, switch guard to `@pgsql/parser` with `version: 16` (verified API) |

## Sources

- npm registry (`npm view`, 2026-10-25, Node 24 / pnpm 11.25.0): all versions, deps, peerDeps, dist-tags (`pg16→16.1.1`, `pg17→17.9.17`, `pg18→18.2.8`) in this file — HIGH
- Published tarball inspection (`npm pack` + `.d.ts` grep): `requireBearerAuth({ verifier, requiredScopes })` signature, `registerTool` `outputSchema`/`structuredContent`, `MultiServerMCPClient` + `StreamableHTTPConnection` exports, `PostgresSaver` export, `ChatOpenAI configuration?: ClientOptions` — HIGH
- MCP TS SDK repo: v2 announcement (split `@modelcontextprotocol/server/client@2.4.0`, spec 2026-07-28) + v1.x branch README (spec 2025-11-25, maintenance until ~6 months post 2026-07-27, zod `v3`/`v4` subpaths) — HIGH
- pgsql-parser monorepo README (constructive-io): async `parse`, `deparse` round-trip, 23k-statement corpus, `@pgsql/parser` multi-version (13–17) `new Parser({ version: 16 })` — HIGH
- Docker Hub API (`pgvector/pgvector` tags): `0.8.7-pg16` (+`bookworm`/`trixie` variants), pushed 2026-10-01 — HIGH
- Faker docs (fakerjs.dev/guide/localization, v10.6.0): `vi` → `fakerVI`, fallback-chain pattern for thin locales — HIGH
- LangChain JS docs (docs.langchain.com): `createAgent` + zod-v4-style schemas; `@langchain/openai` `configuration` passthrough — MEDIUM-HIGH
- gitleaks-action releases: `v3.0.0` (Node 24 runtime; v2 broken after 2026-09-16 runner change) — HIGH
- TypeScript 7.0 announcement + typescript-eslint #10940/#12803 + ecosystem reports: TS 7 = Go port, no stable JS API until 7.1; parser peers `<6.1.0` — HIGH
- TS handbook (Project References) + pnpm docs (workspaces): monorepo pattern — HIGH (stable, long-standing)

---
*Stack research for: SE373 Analytics Agent harness (Milestone 1) — TypeScript LangGraph.js + MCP + Postgres/pgvector*
*Researched: 2026-10-25*
