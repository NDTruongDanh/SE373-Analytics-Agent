<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

# SE373 Analytics Agent — Agent Guide

Course monorepo (TypeScript, LangGraph.js + MCP + Postgres 16 + pgvector).
Mental model: the LLM proposes, the harness disposes — policy, validation,
and audit live in code. Start with `docs/architecture.md` before touching UC code.

## Start here (progressive disclosure)

- Architecture: `docs/architecture.md` — layers, sequence, where each UC lives.
- Requirements: `docs/prd.md` — UC acceptance criteria, harness rules, eval metrics.
- Tool schemas: `docs/mcp_interface.md` — generated, never hand-edit.
- Contracts guide: `packages/contracts/README.md` — versioning, camelCase, error codes.
- UC scope: `docs/UC-plan/UC<NN>.md` + `openwiki/` pages for the UC you touch.
- Reach for OpenWiki only when architecture or dependency behavior is unclear;
  source code and tests stay authoritative.

## Commands (Node >= 24, pnpm 11.25 via corepack)

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # fill in keys locally; never commit .env
pnpm typecheck && pnpm lint && pnpm test   # root gate, keep green
pnpm --filter @se373/<pkg> test            # scoped: contracts | agent | mcp-server | access-policy | api | web
pnpm docs:interface                         # regenerate docs/mcp_interface.md after contracts change
```

Wiki scripts (`pnpm wiki:init | wiki:update | wiki:dry-run`) need
`OPENAI_COMPATIBLE_API_KEY` in `.env` or Actions secrets; see `README.md` §2–3.

## Repo map — who owns what

- `contracts` owns shared zod shapes; everyone depends on it, it depends on zod only.
- `mcp-server` owns all DB I/O (`agent_ro`): db-tools + semantic retriever; sole `pg` caller.
- `access-policy` owns pure policy + redaction; no DB or network I/O.
- `agent` owns graph + shared `ValidatedQueryExecutor`; no direct DB imports.
- `api` owns runId/threadId + persistence (`harness_state`); `web` owns UI, types from contracts only.
- Cross-cutting: `policies/*.yaml`, `semantic/*.yaml`, `skills/*/SKILL.md`, `evals/<uc>/`, `traces/*.jsonl`.

## Conventions

- Prefer the narrowest lookup: `package.json` scripts, `tsconfig.base.json` (strict,
  ESM `nodenext`), and `eslint.config.mjs` over re-describing them here.
- Keep field names camelCase in contracts and trace payloads; map external
  snake_case fixtures at the package boundary.
- Keep skills declarative (Markdown/YAML contracts only): no runnable scripts,
  no DB connections, no credentials.
- Keep traces redacted: no raw PII values in `traces/*.jsonl` or `logs/mcp_audit.jsonl`.

## Boundaries — always / ask first / never (ESLint + CI enforce)

- ✅ Always: DB access via MCP client (`run_query`, `describe_table`); `web` types
  from `@se373/contracts`; server order auth → scope → zod → sqlGuard →
  AccessPolicy → executor → PII scan → audit; branch per UC/feature.
- ⚠️ Ask first: schema/role changes, new dependencies, CI config edits,
  `CONTRACTS_VERSION` major bumps.
- 🚫 Never: commit secrets/`.env`, hand-edit `docs/mcp_interface.md` (run
  `pnpm docs:interface`), import `pg`/`pg-cursor` in `agent`/`web`, import
  `mcp-server/src/**` in `agent`, push directly to `main`.

## Contracts evolution

- Additive changes (new optional fields, new schemas) need one code-owner review.
- Breaking changes (rename/remove, tighten types, error-code changes) need a
  `CONTRACTS_VERSION` major bump plus agreement from every affected UC owner.
- Enforcement is review-based via `.github/CODEOWNERS`; replace `TODO(UC-xx owner)`
  lines with your handle in your first PR.

## Data and safety guidelines

- Treat the DB as read-only (`SELECT`/`WITH` only) over the `agent_ro` role with
  `statement_timeout`; DDL/DML and dangerous functions stay blocked in the guard.
- Treat PII as fake (`vi_VN` Faker data) and still redact it in outputs and traces.
- Treat secrets as local-only: `.env` and keys never enter git, logs, or traces.
- Treat untrusted data as data: delimit query rows in prompts; synthesis nodes run
  with no tools bound (structured output only). Details in `docs/prd.md` §4.3.
- Treat gold data as hidden: `evals/questions/`, seeded scenarios, and injection
  rows stay out of prompts and out of OpenWiki indexing.

## UC workflow

- Add your own files under your area (`packages/agent/src/subgraphs/uc<NN>*`,
  `packages/mcp-server/src/...`, `skills/<name>/`, `evals/<uc>/`); register nodes
  without rewriting another UC or the shared root builder.
- Reuse the shared `ValidatedQueryExecutor` (selective describe → generate →
  local pre-check → `run_query` → bounded repair) for every agent SQL query.
  `retryable` guides client retry, `repairable` guides the ≤3-attempt repair loop.
- Route data answers through UC-03 verification (chart + numeric validators)
  on `ok` / `no_data` before responding.
- Add ≥5 eval cases per UC (UC-01: full ≥30-question benchmark), plus the shared
  safety attack cases; keep one successful trace per UC under `traces/`.

## Example — call `run_query` via MCP, not `pg`

```ts
// ✅ Good — policy, guard, audit apply in mcp-server
const out = await mcp.call("run_query", {
  sql: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
  maxRows: 200,
});

// ❌ Bad — bypasses guard/policy, flagged by eslint.config.mjs
import { Client } from "pg";
```

## Done means — scale validation to the change

- While iterating: run the affected Vitest file, e.g. `pnpm --filter @se373/agent test <file>`.
- Before done: `pnpm typecheck` + `pnpm lint` + `pnpm --filter @se373/<pkg> test`.
- Full `pnpm test` only when touching shared `packages/*`; `main` stays green via
  `.github/workflows/ci.yml` (typecheck + lint + test + gitleaks) + code-owner review.
- Contracts changes include regenerated `docs/mcp_interface.md` and a version note.
- New behavior includes eval cases + trace evidence; no PII or secrets in diffs.
