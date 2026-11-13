# SE373 Analytics Agent

AI analytics agent for a fictional Vietnamese business. Users ask questions in Vietnamese/English; the agent looks up the semantic dictionary, generates `SELECT`/`WITH`, self-repairs on error, then returns tables, charts, and cited insights.

Mental model: **LLM proposes, harness disposes.** Policy, SQL validation, RBAC/masking, verification, and audit live in TypeScript code, not prompts. See `docs/architecture.md` (layers) and `docs/prd.md` (requirements).

Stack: TypeScript, LangGraph.js, MCP (`db-tools` gateway), Postgres 16 + pgvector, React + Vite.

- `apps/api` — HTTP/SSE host, mints `runId`/`threadId`, persists to `harness_state`.
- `apps/web` — chat UI, SQL drawer, charts, role switcher.
- `packages/agent` — graph + `ValidatedQueryExecutor`; no direct DB imports.
- `packages/mcp-server` — sole DB caller (`agent_ro`); auth → scope → zod → sqlGuard → AccessPolicy → read-only executor → PII scan → audit.
- `packages/contracts` — shared Zod schemas. `packages/access-policy` — pure RBAC/masking. `packages/data` — Olist loader.

## Prerequisites

- Docker + Docker Compose
- Node >= 24, pnpm 11.25 (`corepack enable`)
- Ports free (loopback-only): `5433` (db), `8081` (mcp), `3001` (api), `5173` (web)

## Setup

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env   # fill in tokens locally; never commit .env
```

`.env` carries DB URLs, `MCP_PORT`/`API_PORT`, MCP bearer tokens (`MCP_TOKEN_*`), and optional model/embedding keys. Without an agent model key the agent runs on the deterministic fake model.

## Run with Docker

Full stack (db + mcp + api + web):

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100
docker compose down        # stop
docker compose down -v     # stop + wipe pgdata (fresh DB next boot)
```

Same via pnpm wrappers: `pnpm docker:up` / `pnpm docker:down` / `pnpm docker:ps` / `pnpm docker:logs`.

Load seed data (one-off, profile-gated):

```sh
docker compose --profile data run --rm data
# or: pnpm docker:data
```

DB only (for local `pnpm dev` iteration):

```sh
pnpm db:up   # compose db service only
```

| Service | URL                           | Notes                                                                                    |
| ------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| web     | http://127.0.0.1:5173         | nginx static + `/api` → api proxy, SSE streaming                                         |
| api     | http://127.0.0.1:3001/healthz | Express + SSE                                                                            |
| mcp     | http://127.0.0.1:8081/healthz | Streamable HTTP `db-tools`                                                               |
| db      | `127.0.0.1:5433/chosen`       | `pgvector/pgvector:0.8.7-pg16`, roles `owner` / `agent_ro` / `indexer` / `harness_state` |

Verify: open the web URL, ask a question, check `traces/` (per-run) and `logs/mcp_audit.jsonl` (PII-redacted).

## Dataset

Vietnamized [Brazilian E-Commerce (Olist)](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce) (CC BY-NC-SA 4.0): Brazilian states → 34 VN provinces (Bắc/Trung/Nam), categories → Vietnamese, BRL → VND (×5150), dates shifted +2905d to 2025–2026. `order_items` expanded to ~1M rows; PII is `vi_VN` Faker fake data. Seeded variance/anomaly/injection scenarios are hidden from the agent.

`pnpm data:load` (full, ~6 min) / `pnpm data:load --scale=small` (CI, <2 min) + `pnpm data:verify`. See `packages/data/`.

## Docs

- `docs/architecture.md`, `docs/prd.md`, `docs/mcp_interface.md` (generated via `pnpm docs:interface`)
- `AGENTS.md` — contributor rules, boundaries, gates (`pnpm typecheck && pnpm lint && pnpm test`)
