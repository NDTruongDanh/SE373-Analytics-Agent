#!/bin/bash
# LOCAL-ONLY dev database init (Phase 2, D-05). Never reuse these credentials
# in any deployed environment: every password below is an obvious local dev
# default, mirrored in `.env.example` for client URLs. The server-side values
# set here always match what `.env` carries because both sides read the same
# environment variables with the same `:-` fallbacks.
#
# Runs once at volume creation via /docker-entrypoint-initdb.d (alphabetical
# order: roles first, then schemas, then business DDL). After changing a role
# password, `pnpm db:reset` is required — initdb reruns only on an empty
# volume.
set -e

export OWNER_PASSWORD="${OWNER_PASSWORD:-owner_dev_pw}"
export AGENT_RO_PASSWORD="${AGENT_RO_PASSWORD:-agent_ro_dev_pw}"
export INDEXER_PASSWORD="${INDEXER_PASSWORD:-indexer_dev_pw}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$OWNER_PASSWORD" \
  -v agent_ro_pw="$AGENT_RO_PASSWORD" \
  -v indexer_pw="$INDEXER_PASSWORD" <<'EOSQL'
-- Roles (verified against pgvector/pgvector:0.8.7-pg16, PG 16.15).
CREATE ROLE owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE agent_ro LOGIN PASSWORD :'agent_ro_pw';
CREATE ROLE indexer LOGIN PASSWORD :'indexer_pw';

-- agent_ro session defaults: read-only + bounded. These are USERSET settings
-- (any session can override them), so they are defense in depth only — the
-- real protection is the grant layer in 02_schemas.sql, proven by the
-- override-path matrix in packages/data/test/roles.live.test.ts.
ALTER ROLE agent_ro SET default_transaction_read_only = on;
ALTER ROLE agent_ro SET statement_timeout = '30s';
ALTER ROLE agent_ro SET idle_in_transaction_session_timeout = '10s';
EOSQL
