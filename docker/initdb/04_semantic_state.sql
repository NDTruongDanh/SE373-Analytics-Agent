-- 04_semantic_state.sql — semantic + persistence DDL (D-08, D-17, D-18).
-- Two sections, each under its owning role so the default privileges in
-- 02_schemas.sql line up: semantic under SET ROLE owner, state under
-- SET ROLE harness_state. The langgraph schema itself stays empty here —
-- the 01-13 PostgresSaver setup creates its tables.

-- ---------------------------------------------------------------- semantic
SET ROLE owner;

-- Immutable unaccent wrapper for the generated FTS column. The unaccent()
-- extension function is STABLE, and PostgreSQL GENERATED ALWAYS columns
-- require immutable expressions (verified live: a direct
-- to_tsvector('simple', unaccent(content)) errors with "generation
-- expression is not immutable"). The wrapper is deterministic in practice
-- (unaccent rules are static files), so marking it IMMUTABLE is safe here.
CREATE OR REPLACE FUNCTION semantic.immutable_unaccent(txt text)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN unaccent(txt);

-- Semantic chunk store (UC-02 corpus). Column names mirror the contracts
-- SemanticChunkMetadata fields (chunkId/docType/table/tables/metricName/
-- aliases/sensitivity/additive/updatedAt) plus content, content_hash
-- (SHA-256 of the canonical chunk JSON for incremental indexing),
-- updated_at (hot-reload watermark), and the fixed-dim embedding
-- vector(1536) per D-17 — changing the dimension later means re-DDL plus
-- re-index, so it is fixed here.
CREATE TABLE semantic.semantic_chunks (
  chunk_id TEXT PRIMARY KEY,
  doc_type TEXT,
  table_name TEXT,
  tables TEXT,
  metric_name TEXT,
  aliases TEXT,
  sensitivity TEXT,
  additive BOOLEAN,
  metadata JSONB,
  content TEXT,
  content_hash TEXT,
  updated_at TIMESTAMPTZ,
  embedding vector(1536),
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', semantic.immutable_unaccent(content))
  ) STORED
);

-- HNSW cosine index per D-12/D-17 (m=16, ef_construction=64).
CREATE INDEX semantic_chunks_embedding_hnsw_idx
  ON semantic.semantic_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index on the generated FTS column for lexical search (D-18).
CREATE INDEX semantic_chunks_fts_gin_idx
  ON semantic.semantic_chunks USING gin (fts);

RESET ROLE;

-- Chunk-only SELECT for agent_ro: this explicit per-table GRANT (not a
-- schema-wide GRANT, and deliberately no ALTER DEFAULT PRIVILEGES for
-- agent_ro in semantic) is the only read path agent_ro has into semantic —
-- future semantic tables stay invisible to it.
GRANT SELECT ON TABLE semantic.semantic_chunks TO agent_ro;

-- Belt and braces for the indexer write path (already covered by the
-- 02_schemas.sql default privileges for owner-created semantic tables).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE semantic.semantic_chunks TO indexer;

-- ------------------------------------------------------------------- state
SET ROLE harness_state;

-- 24h alert-dedup store (UC-10, owned by 01-13). fingerprint holds
-- SHA256(recipientId | metric | dimensionKey | date | direction); a row is
-- inserted ONLY after send_alert succeeds (write-after-send), so retries of
-- failed sends are never falsely suppressed.
CREATE TABLE app_state.alert_history (
  fingerprint TEXT PRIMARY KEY,
  recipient_id TEXT,
  metric TEXT,
  dimension_key TEXT,
  alert_date DATE,
  direction TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

RESET ROLE;
