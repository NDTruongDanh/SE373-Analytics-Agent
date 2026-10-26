-- 01_roles.sql — D-08 role layer (full design, replaces the v1 01_roles.sh).
-- Runs once at volume creation via /docker-entrypoint-initdb.d (alphabetical
-- order: roles first, then schemas, then DDL). Pure SQL: no psql variables,
-- so the passwords below are literals. They are LOCAL-ONLY dev defaults for
-- the loopback-bound container holding fake data — NEVER reuse them in any
-- deployed environment. They MUST match the `:-` defaults in
-- docker/docker-compose.yml; overriding *_PASSWORD in the environment changes
-- only client URLs, not these server-side roles (re-run `down -v` after any
-- password change — initdb reruns only on an empty volume).
--
-- Roles: owner (DDL/load only), agent_ro (MCP SELECT), indexer (RAG CLI
-- writes to semantic.* only), harness_state (owns langgraph.* + app_state.*,
-- zero grants on public.* — see 02_schemas.sql).
--
-- The DO blocks skip existing roles so reruns against a kept volume are safe
-- (initdb itself runs only on an empty volume; this guards manual re-apply).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'owner') THEN
    CREATE ROLE owner WITH LOGIN PASSWORD 'chosen_owner_dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agent_ro') THEN
    CREATE ROLE agent_ro WITH LOGIN PASSWORD 'chosen_agent_ro_dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'indexer') THEN
    CREATE ROLE indexer WITH LOGIN PASSWORD 'chosen_indexer_dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_state') THEN
    CREATE ROLE harness_state WITH LOGIN PASSWORD 'chosen_harness_state_dev';
  END IF;
END
$$;

-- agent_ro session defaults: read-only + bounded. These are USERSET settings
-- (any session can override them with SET), so they are defense in depth
-- ONLY — the real read-only protection is the grant layer in 02_schemas.sql,
-- proven by the override-path denial matrix (a write with
-- default_transaction_read_only=off still fails 42501 on missing grants).
ALTER ROLE agent_ro SET default_transaction_read_only = on;
ALTER ROLE agent_ro SET statement_timeout = '30s';
ALTER ROLE agent_ro SET idle_in_transaction_session_timeout = '10s';
