-- 01_tracer_roles.sql — TRACER minimal role subset (D-08).
-- 01-04 completes the 4-role initdb (indexer, harness_state) plus the
-- semantic / langgraph / app_state schemas and the small-scale loader.
--
-- LOCAL-DEV-ONLY passwords: this compose stack binds 127.0.0.1 only and
-- holds fake seed data. Never reuse these passwords outside this container.
-- Operator secrets (MCP_TRACER_TOKEN, model keys) live in local `.env`,
-- never in the repo.

CREATE ROLE owner WITH LOGIN PASSWORD 'chosen_owner_dev';
CREATE ROLE agent_ro WITH LOGIN PASSWORD 'chosen_agent_ro_dev';

-- Defense in depth (T-01-05): even a bypassed executor cannot write or run
-- long queries on agent_ro sessions.
ALTER ROLE agent_ro SET default_transaction_read_only = 'on';
ALTER ROLE agent_ro SET statement_timeout = '30s';

-- Lock down public, then re-grant per role. NOTE: the REVOKE strips owner
-- too, so owner needs the explicit GRANT CREATE, USAGE below (v1 lesson).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMP ON DATABASE chosen FROM PUBLIC;
GRANT CREATE, USAGE ON SCHEMA public TO owner;
GRANT TEMP ON DATABASE chosen TO owner;

-- agent_ro least-privilege path (T-01-01): CONNECT + USAGE + present and
-- future SELECT on public tables only. No TEMP, no CREATE.
GRANT CONNECT ON DATABASE chosen TO agent_ro;
GRANT USAGE ON SCHEMA public TO agent_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE owner, postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO agent_ro;
