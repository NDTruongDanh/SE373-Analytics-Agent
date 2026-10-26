-- 02_schemas.sql — D-08 schema + grant layer (full design).
-- Runs as the superuser on first init, after 01_roles.sql and before any
-- data table exists (ALTER DEFAULT PRIVILEGES must be set before the tables
-- they cover). Database name: chosen (D-08).
--
-- FIX 2 (live-found, db research): CREATE EXTENSION must run as superuser
-- BEFORE any SET ROLE below — extension creation needs superuser-equivalent
-- rights that owner/agent_ro/indexer/harness_state do not have. This file
-- never issues SET ROLE, so everything here runs with initdb superuser
-- rights by construction.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Schemas. semantic/langgraph/app_state are owned by harness_state so the
-- 01-13 PostgresSaver setup and the 01-05 AppStateStore writes work without
-- extra grants; public stays under the default owner for the owner-held DDL
-- in 03_public.sql / 04_semantic_state.sql.
CREATE SCHEMA IF NOT EXISTS semantic AUTHORIZATION harness_state;
CREATE SCHEMA IF NOT EXISTS langgraph AUTHORIZATION harness_state;
CREATE SCHEMA IF NOT EXISTS app_state AUTHORIZATION harness_state;

-- PG15+ lockdown: no CREATE in public, no TEMP anywhere for untrusted roles
-- (SELECT INTO / temp-table write primitive inside read-only txns).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMP ON DATABASE chosen FROM PUBLIC;
REVOKE TEMP ON DATABASE chosen FROM agent_ro;

-- FIX 1 (live-found, db research): the REVOKE above strips owner too, so
-- owner needs the explicit GRANT back immediately — without it, owner DDL
-- and the 01-07 loader fail.
GRANT CREATE, USAGE ON SCHEMA public TO owner;

-- Owner is the DDL role for semantic_chunks (04_semantic_state.sql runs its
-- semantic section under SET ROLE owner), and semantic is owned by
-- harness_state — so owner needs explicit CREATE + USAGE there too.
-- Found live during 01-04 task 2: without this, CREATE TABLE in semantic
-- as owner fails with permission denied for database chosen.
GRANT CREATE, USAGE ON SCHEMA semantic TO owner;

-- Least privilege from zero (D-08). Grants are the load-bearing read-only
-- boundary; agent_ro USERSET session defaults (01_roles.sql) are defense
-- in depth only.
GRANT CONNECT ON DATABASE chosen TO owner, agent_ro, indexer, harness_state;

-- agent_ro: CONNECT + USAGE on public + SELECT on present and future public
-- tables only. No TEMP, no CREATE, no USAGE on sequences (nextval stays
-- 42501 by the absence of any grant).
GRANT USAGE ON SCHEMA public TO agent_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA public
  GRANT SELECT ON TABLES TO agent_ro;

-- agent_ro on semantic: USAGE now; SELECT on semantic_chunks is granted
-- explicitly in 04_semantic_state.sql AFTER the table exists (a GRANT naming
-- the table here would fail — the relation does not exist yet). Deliberately
-- NO ALTER DEFAULT PRIVILEGES for agent_ro in semantic: the grant is
-- chunk-only, so future semantic tables must NOT auto-grant to agent_ro.
-- (USAGE alone grants no table access — the table GRANT in 04 is what opens
-- the single chunk table; verified live: without this USAGE the table GRANT
-- is unreachable and SELECT fails 42501 on the schema.)
GRANT USAGE ON SCHEMA semantic TO agent_ro;

-- indexer: writes semantic.* only (CREATE TABLE plus INSERT must succeed
-- as indexer per the 01-04 role-proof matrix — hence CREATE on the schema).
-- Zero rights on public, langgraph, app_state (any write there fails 42501).
GRANT USAGE, CREATE ON SCHEMA semantic TO indexer;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA semantic TO indexer;
GRANT ALL ON ALL SEQUENCES IN SCHEMA semantic TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA semantic
  GRANT ALL ON SEQUENCES TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE indexer IN SCHEMA semantic
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO indexer;
ALTER DEFAULT PRIVILEGES FOR ROLE indexer IN SCHEMA semantic
  GRANT ALL ON SEQUENCES TO indexer;

-- harness_state: owns its schemas (above), holds zero grants on public and
-- semantic — any read there fails 42501 by the absence of any grant.

-- FIX 3 (live-found, 01-13): PostgresSaver.setup() unconditionally issues
-- CREATE SCHEMA IF NOT EXISTS "langgraph" before its migrations, and PG
-- checks CREATE on the database even when the schema already exists
-- (observed live: 42501 permission denied for database chosen as
-- harness_state). harness_state therefore needs CREATE on the database
-- itself. This grants no access to public.* or semantic.* (still 42501 by
-- the absence of any grant); it only lets harness_state own schemas — the
-- langgraph/app_state D-08 intent. Without it, setup() cannot run as
-- harness_state and the PORT-01 role-proof fails.
GRANT CREATE ON DATABASE chosen TO harness_state;
