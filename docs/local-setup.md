# Running the project locally on Windows

This guide uses PowerShell in VS Code. Run each command from the repository root unless otherwise noted. You only need to install dependencies and configure the environment once, not every time you start the project.

## First-time setup

1. Install Node.js 24 or later, Corepack, and Docker Desktop. Open Docker Desktop and wait until Docker is running.
2. Open the repository folder in VS Code, then open a PowerShell terminal at the repository root and install dependencies:

   ```powershell
   corepack pnpm install --frozen-lockfile
   ```

3. Create `.env` from `.env.example` **only if `.env` does not already exist**:

   ```powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

   Do not overwrite an existing `.env`, share its keys, or commit it.
4. Open `.env` and check `OWNER_DATABASE_URL`, `AGENT_RO_DATABASE_URL`, `INDEXER_DATABASE_URL`, and `HARNESS_STATE_DATABASE_URL`. The example values match the Docker defaults for local development. Never use the example passwords in a deployed environment.
5. Uncomment and set a different token for each of `MCP_TOKEN_SALES_SOUTH`, `MCP_TOKEN_MARKETING`, `MCP_TOKEN_HR`, and `MCP_TOKEN_ADMIN`. Run the following command four times and copy each result into a different variable in `.env`. Do not share the generated values.

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

6. To use 9Router as the model provider, run it separately and configure `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`, and `AGENT_MODEL_ID`. A local base URL may look like `http://127.0.0.1:20128/v1`; use the actual address provided by your 9Router instance. The model must support the JSON output required by the application. If `AGENT_MODEL_API_KEY` is unset, the tracer uses a canned fake model for testing rather than calling a real model.

## Start the services

### 1. Database

Open Docker Desktop, then run the following in a terminal at the repository root:

```powershell
corepack pnpm db:up
docker compose -f docker/docker-compose.yml ps
```

Check that the `db` service is `healthy`. `db:up` preserves the existing database volume. Do not run `corepack pnpm db:reset` unless you intend to delete that volume and its data.

Only for a new, empty database that needs sample data, run the following from the repository root. An internet connection is required and the load can take several minutes:

```powershell
node --env-file=.env --import tsx packages/data/src/load.ts
node --env-file=.env --import tsx packages/data/src/verify.ts
```

You do not need to reload data on every startup. For a database that already contains data, do not reload or reset it without first checking the [main README](../README.md).

### 2. Build

Run this in a terminal at the repository root:

```powershell
corepack pnpm build
```

Build during first-time setup and after changing backend code or shared packages. If the API or MCP server was already running during the build, restart the relevant process to load the changes.

### 3. MCP server

Open a new PowerShell terminal at the repository root and leave it running:

```powershell
node --env-file=.env --import tsx packages/mcp-server/src/server.ts
```

### 4. Backend API

Open another PowerShell terminal at the repository root and leave it running:

```powershell
node --env-file=.env --import tsx apps/api/src/index.ts
```

### 5. Frontend

Open another PowerShell terminal at the repository root and leave it running:

```powershell
corepack pnpm --filter @shared/web dev
```

Open the URL printed by Vite, normally <http://127.0.0.1:5173>. If using 9Router, keep it running while sending questions.

## Checks and troubleshooting

- Check the API at <http://127.0.0.1:3001/healthz> and MCP at <http://127.0.0.1:8081/healthz>. If you changed their ports in `.env`, use those ports instead. An HTTP 200 response only means that service is responding; it does **not** guarantee the model or every dependency is working.
- `Connection error.` after submitting a question can mean the API cannot reach the model provider. If using a local 9Router instance, check that it is running and that the configured base URL and port are correct, then try again. Check the API terminal as well; do not share keys or tokens.
- A quota or rate-limit error means the provider has limited requests or the available quota has been exhausted. Check the provider dashboard or select a model with available quota.
- Invalid JSON from a model can mean the model or provider does not support the required structured output. Check its capabilities and provider configuration. The API currently uses the tracer demo, not the complete UC-01 analytics flow.
- If a port is already in use, check existing terminals before starting a second instance. Press `Ctrl+C` only in the terminal for the process you want to stop; leave the other terminals open. The Docker container continues running in the background after its startup terminal is closed.
