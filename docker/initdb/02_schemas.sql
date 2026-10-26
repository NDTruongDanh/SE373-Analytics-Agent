-- Schemas + least-privilege grants (Phase 2, D-05). Runs as the superuser on
-- first init, after 01_roles.sh and before any data table exists (Pitfall P2:
-- ALTER DEFAULT PRIVILEGES must be set before the tables they cover).
-- Database name: chosen (D-09).

CREATE SCHEMA business AUTHORIZATION owner;
CREATE SCHEMA semantic AUTHORIZATION owner;
CREATE SCHEMA langgraph AUTHORIZATION owner;
CREATE SCHEMA app_state AUTHORIZATION owner;

-- PG15+ lockdown: no CREATE in public, no TEMP anywhere for untrusted roles
-- (Pitfall P3: SELECT INTO / temp-table write primitive inside read-only txns).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMP ON DATABASE chosen FROM PUBLIC;
REVOKE TEMP ON DATABASE chosen FROM agent_ro;

-- Least privilege from zero: agent_ro reads business only; indexer writes
-- semantic/langgraph/app_state and reads business (bug caught live during
-- research: GRANT SELECT ON ALL TABLES alone misses future tables).
GRANT CONNECT ON DATABASE chosen TO agent_ro, indexer;
GRANT USAGE ON SCHEMA business TO agent_ro;
GRANT USAGE ON SCHEMA business, semantic, langgraph, app_state TO indexer;

ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA business
  GRANT SELECT ON TABLES TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic
  GRANT SELECT ON TABLES TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA business
  GRANT SELECT ON TABLES TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic, langgraph, app_state
  GRANT ALL ON TABLES TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic, langgraph, app_state
  GRANT ALL ON SEQUENCES TO indexer;

-- agent_ro must NEVER get USAGE on sequences: the roles suite proves nextval
-- fails 42501, which depends on this absence alongside read-only txn.
