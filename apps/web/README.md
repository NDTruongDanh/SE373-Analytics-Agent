# UC-01 analytics chat

From the repository root, install the workspace dependencies and start the web dev server:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @shared/web dev
```

Open the URL printed by Vite (normally http://127.0.0.1:5173). The dev server proxies `/api` to `http://127.0.0.1:3001`; start the existing API and MCP gateway separately and configure the database and tokens as documented in the [local startup guide](../../docs/huong-dan-chay-local.md) and `.env.example`. No credentials belong in Vite environment variables or browser code.

The current API streams available progress metadata while the graph runs, but does not send a full `SQLAnswer` with SQL, preview rows, citations, and telemetry. Stages depend on the graph actually executed. The chat displays the metadata that the API provides and the drawer explicitly indicates when details are unavailable. Structured clarification payloads from UC-01 and the current legacy options array are both supported.

```powershell
corepack pnpm --filter @shared/web test
corepack pnpm --filter @shared/web build
```
