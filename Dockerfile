# syntax=docker/dockerfile:1.7
# Container image for the SE373 analytics harness.
#
# One build stage installs the pnpm workspace and compiles every package plus
# the web bundle; two runtime targets fan out from it:
#   - `app`: node:24-slim with the compiled API and MCP gateway (same tree,
#     different commands in docker/docker-compose.yml)
#   - `web`: nginx serving apps/web/dist/site and proxying /api to the API
#
# Runtime secrets are never baked in: `.env` is excluded by .dockerignore and
# injected per service through compose `env_file`/`environment`.

FROM node:24-bookworm AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

# Pin the package manager from package.json so the lockfile resolves exactly
# as it does on the host (`packageManager: pnpm@11.25.0`).
RUN npm install --global pnpm@11.25.0

WORKDIR /app

# Dependency layer: manifests only, so source edits do not bust the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/access-policy/package.json packages/access-policy/
COPY packages/agent/package.json packages/agent/
COPY packages/contracts/package.json packages/contracts/
COPY packages/data/package.json packages/data/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN pnpm install --frozen-lockfile

# Build layer: compiled dist for every package, then the Vite bundle.
# `--force` ignores any incremental state that may have entered the context
# while dist/ was excluded; every reference must emit inside the image.
COPY . .
RUN pnpm exec tsc -b --force \
 && pnpm --filter @shared/web build

# --- Runtime: API + MCP gateway -------------------------------------------
FROM node:24-bookworm-slim AS app

ENV NODE_ENV=production
WORKDIR /app

# The workspace keeps pnpm's relative symlinks intact, so the whole tree
# (node_modules + packages + policies + semantic + skills) moves as one unit.
COPY --from=build /app /app

# Writable runtime outputs. The node user is uid 1000, matching a typical
# Linux host user, so bind-mounted traces/logs stay writable.
RUN mkdir -p /app/logs /app/traces /app/results /app/data/.cache \
 && chown -R node:node /app/logs /app/traces /app/results /app/data/.cache

USER node

EXPOSE 3001 8081

# Default command is the API; the mcp service overrides it.
CMD ["node", "apps/api/dist/index.js"]

# --- Runtime: static web + /api reverse proxy -----------------------------
FROM nginx:1.27-alpine AS web

COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist/site /usr/share/nginx/html

EXPOSE 80
