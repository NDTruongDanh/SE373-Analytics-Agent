# UC-01 analytics chat

From the repository root, install the workspace dependencies and start the web dev server:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @shared/web dev
```

Open the URL printed by Vite (normally http://127.0.0.1:5173). The dev server proxies `/api` to `http://127.0.0.1:3001`; start the existing API and MCP gateway separately and configure the database and tokens as documented in the [local startup guide](../../docs/local-setup.md) and `.env.example`. No credentials belong in Vite environment variables or browser code.

The current API streams available progress metadata while the graph runs. After a successful gateway query, the drawer can show the model's original SQL proposal only for a limited, literal-free order-status demo vocabulary; the gateway may have rewritten the SQL before execution. Other SQL is withheld rather than exposing potentially sensitive values. The API does not yet send a full `SQLAnswer` with preview rows, citations, and telemetry. Stages depend on the graph actually executed. Structured clarification payloads from UC-01 and the current legacy options array are both supported.

```powershell
corepack pnpm --filter @shared/web test
corepack pnpm --filter @shared/web build
```
