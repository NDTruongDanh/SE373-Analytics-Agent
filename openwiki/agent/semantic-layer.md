---
type: semantic-layer
title: Semantic layer and retrieval
description: Versioned semantic corpus, incremental indexing, and 3-way hybrid retrieval with weighted RRF and join-rule expansion grounding the Analytics Agent.
tags: [semantic-layer, retrieval, rag, citations, knowledge-base, text-to-sql]
verified:
  - by: openwiki/0.7.2
    at: 2026-10-31T14:10:28.006Z
sources:
  - id: openwiki-source-4912fb87763cb10856716453
    resource: repo://docker/initdb/02_schemas.sql
  - id: openwiki-source-7c9e4d2d1e688a959951f03b
    resource: repo://docker/initdb/04_semantic_state.sql
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-b17e2a243524589eaf54306d
    resource: repo://docs/UC-plan/UC02.md
  - id: openwiki-source-7a382cb67515f2241c13f47e
    resource: repo://packages/agent/src/graph.ts
  - id: openwiki-source-8f32b5188dc80fbc97e18ece
    resource: repo://packages/agent/src/state.ts
  - id: openwiki-source-4ab6f6b20d8ae6cdc708e0b0
    resource: repo://packages/contracts/src/search.ts
  - id: openwiki-source-c6764c62ef243702a1e271ac
    resource: repo://packages/mcp-server/src/pipeline.ts
  - id: openwiki-source-cd6680271f1499ebe3fa5bf1
    resource: repo://packages/mcp-server/src/semantic/embedder.ts
  - id: openwiki-source-38ea9620ad4a090cbdc31b69
    resource: repo://packages/mcp-server/src/semantic/index.ts
  - id: openwiki-source-8fd27ad72220d2df3201af9d
    resource: repo://packages/mcp-server/src/semantic/retriever.ts
  - id: openwiki-source-d9ce283e9f5391f9fc225e35
    resource: repo://packages/mcp-server/src/semantic/rrf.ts
  - id: openwiki-source-133b0c7d08e8e3c7f7e4fda2
    resource: repo://packages/mcp-server/src/server.ts
  - id: openwiki-source-9ca63c47cf2805e788ed5fdb
    resource: repo://packages/mcp-server/src/tools.ts
  - id: openwiki-source-4fd3e19fe0c023887ba08260
    resource: repo://semantic/data_dictionary.md
  - id: openwiki-source-8eee263b27f3a1a6554edaea
    resource: repo://semantic/metrics.md
generated: { by: "openwiki/0.7.2", at: "2026-10-31T14:10:28.006Z" }
---

# Semantic layer and retrieval

This page owns the versioned semantic corpus, the chunking and incremental-indexing pipeline, and the hybrid retrieval path that grounds business language in tables, metrics, and join warnings before SQL generation. The normative UC-02 design (six YAML document types, three-way retrieval with join expansion, LangGraph guardrail, dual citations) lives in the UC-02 plan; what has landed is the MCP indexer, embedder, 3-way retriever, RRF helper, chunk table, gateway tool, and gateway resources described here. Runtime, data, and verification details live in [Workflow Architecture](./workflow-architecture.md), [Database and Seeding](../data/database-and-seeding.md), and [Text to SQL](../use-cases/text-to-sql.md).

> Implementation status: the indexer, embedder, 3-way retriever (dense plus BM25 plus alias), weighted RRF helper, join-rule expansion, hot-reload catalog, chunk table, gateway tool, and gateway resources are built. The LangGraph `retrieveSemantic` node with two-tier grounding, deterministic citation validator, and UC-02 eval gates are still plan, not code.

## 1. Responsibility and position in the loop

The semantic layer answers one question: which tables, columns, metric definitions, and business events apply to this user turn. The agent reaches it only through the MCP gateway — never by opening the database directly — via the `search_semantic_layer` tool and the `semantic://data-dictionary` and `semantic://metrics` resources.

It has three duties:

1. **Business-to-schema grounding.** Resolve non-schema terms such as revenue or average order value into authoritative tables, metric definitions, and fan-out warnings before SQL planning.
2. **Direct definitional answers.** Serve the dictionary and metric text itself so definitional questions can be answered from retrieved chunks without running SQL.
3. **Refusal by omission.** Withhold `restricted_pii` chunks and resource sections from principals lacking `data:sensitive`, instead of leaking them and redacting later.

The layer is read-only at query time. It never writes the business database, never edits user data, and every tool or resource call still passes authentication, scope checks, zod validation, PII redaction, and audit in the fixed gateway pipeline.

## 2. Knowledge corpus

The corpus is two versioned Markdown files at the repository root, not the six YAML files from the UC-02 plan:

- `semantic/data_dictionary.md` — twelve seeded business tables (`regions`, `channels`, `categories`, `sellers`, `products`, `customers`, `employees`, `promotions`, `orders`, `order_items`, `payments`, `reviews`) with grain, primary keys, aliases, and join rules. It carries no row counts, no example values, and no query fragments.
- `semantic/metrics.md` — six canonical metric definitions (`revenue_vnd`, `order_count`, `average_order_value`, `freight_share`, `review_score_avg`, `compensation_cost`) with the tables each derives from and Vietnamese plus English aliases. It carries no formulas, no thresholds, and no query fragments.

Chunking is by Markdown section: every `## ` heading starts one self-contained chunk, and preamble text before the first heading is skipped. The leading `Table:` / `Tables:` / `Metric:` / `Aliases:` lines populate metadata columns and stay in the stored content so lexical search still matches them. A header ending in `[restricted_pii]` marks the whole section restricted — currently `employees` in the dictionary and `compensation_cost` in metrics. The dictionary additionally flags `order_items` as the `large` table that must be filtered before a full scan, and marks review text as untrusted user input wrapped in untrusted-data delimiters.

```mermaid
flowchart TD
  A["Parse semantic Markdown or YAML"] --> B["Split on sections or entries"]
  B --> C["Parse Table Tables Metric Aliases"]
  C --> D["Tag restricted_pii headers"]
  D --> E["SHA-256 canonical hash"]
  E --> F["Embed only dirty chunks"]
  F --> G["Upsert plus delete with updated_at"]
```

*Caption: Corpus indexing flow from section split to incremental upsert.*

## 3. Chunk metadata contract

The `ParsedChunk` shape carries `chunkId`, `docType`, `table`, `tables`, `metricName`, `aliases`, `sensitivity`, and `content`. The Markdown chunk id is `source:slug`, where source is the file basename (`data_dictionary`, `metrics`) and slug is the lowercased, dash-joined heading. A heading with a single `Tables:` entry derives `table` from it; a `Table:` entry derives `tables` from it, so both columns are always populated together. The YAML chunker accepts `chunkId`/`chunk_id`/`id`, `docType`/`doc_type`, `table`, `tables`, `metricName`/`metric_name`/`metric`, `aliases`, `sensitivity`, and `content`/`body`/`description`/`text`, with the same table-to-tables derivation and slug fallback.

Storage is snake_case in `semantic.semantic_chunks`: `chunk_id`, `doc_type`, `table_name`, `tables`, `metric_name`, `aliases`, `sensitivity`, plus `additive`, `metadata`, `content`, `content_hash`, `updated_at`, `embedding`, and a generated `fts` column. Multi-value columns are stored as comma-joined text (`orders,order_items`) and split back into arrays at the contract boundary. The `additive` column exists in DDL for future attribution math but the current indexer leaves it unset, and `metadata` is always written as an empty JSON object.

The frozen `SearchSemanticLayer` wire contract takes `{ query, topK }` with `query` required from 1 to 2000 characters and `topK` defaulting to 5 and capped at 20. It returns `chunks` where each chunk carries `chunkId`, `docType` enumerating all six UC-02 values (`table`, `column`, `metric`, `join_rule`, `example`, `event`), `table`, `tables`, `metricName`, `content`, `score`, plus optional `aliasMatched` and `denseScore` set by the 3-way fusion path. Only `table` and `metric` chunks are indexed from the two Markdown files today, but the contract already covers the planned types so YAML-discovered `column`, `join_rule`, `example`, and `event` chunks pass validation without a contract change.

## 4. Chunking, hashing, and incremental indexing

The pure Markdown chunker exports `chunkMarkdown(source, text, docType)` for unit tests: split on `## ` headings, parse the leading metadata lines, derive `table` and `tables` from each other when only one is present, slug the heading for the id, and drop empty sections. The pure YAML chunker exports `chunkYaml(source, text, docType)` with the same derivation plus sensitivity normalization to `public`/`internal`/`restricted_pii`. The pure hasher exports `contentHash(chunk)` as `sha256` over the canonical JSON of id, type, table fields, metric name, aliases, sensitivity, and content.

`indexCorpus({ dbUrl, embedder, files })` implements the incremental path:

1. Read each file, splitting Markdown with the file basename as source and parsing YAML when the path ends in `.yaml`/`.yml`.
2. Select stored `(chunk_id, content_hash)` pairs.
3. Delete stored ids absent from the current corpus and count them as `deleted`.
4. Keep chunks whose stored hash differs or is missing; count all others as `skipped`.
5. Embed only the dirty chunks in one batch call.
6. `INSERT` new ids and `UPDATE` changed ids (type, table fields, metric, aliases, sensitivity, content, hash, embedding, `updated_at`), returning `{ added, updated, skipped, deleted }`.

There is no embedding-token, cost, or duration telemetry in the returned summary, and no `semantic:lint` Zod step — the metadata lines are parsed leniently.

The operator entry point is the indexer module itself run with `tsx` against `INDEXER_DATABASE_URL`, using `discoverDefaultFiles()` — the two `DEFAULT_FILES` (`semantic/data_dictionary.md` as `table`, `semantic/metrics.md` as `metric`) plus auto-discovered `semantic/*.yaml`/`*.yml` with doc-type inference from the filename (`join` to `join_rule`, `table`, `column`, `metric`, `example`, `event`) — and the environment-selected embedder. The indexer connects as the `indexer` role over a two-connection pool and logs `added`, `updated`, `skipped`, and `deleted`.

## 5. Embedders

The shared `Embedder` interface returns fixed-dimension vectors. Two implementations exist:

- **Fake embedder.** Deterministic 1536-dimension L2-normalized vectors from FNV-1a hashing plus a mulberry32 stream mapped to `[-1, 1]`. Repeat calls are byte-identical, so every unit test and CI run works without a key.
- **OpenAI-compatible embedder.** Calls an operator endpoint selected from `EMBEDDING_MODEL_ID`, `OPENAI_COMPATIBLE_BASE_URL`, and `EMBEDDING_API_KEY`, with dimension from `EMBEDDING_DIM` defaulting to 1536.

`selectEmbedderFromEnv` picks the OpenAI endpoint only when both a model id and an API key are set; otherwise it returns the fake with a boot warning, so fake embeddings in production are always a conscious choice.

## 6. Storage, indexes, and roles

`semantic.semantic_chunks` is created under `SET ROLE owner` with `chunk_id` as primary key, `embedding vector(1536)`, `content_hash` for incremental dedup, and `updated_at` as the reload watermark. A generated `tsvector` column built as `to_tsvector('simple', semantic.immutable_unaccent(content))` is retained in DDL with a GIN index; the `immutable_unaccent` SQL wrapper exists because the `unaccent()` extension function is `STABLE` while generated columns require an `IMMUTABLE` expression. The live `hybridSearch` path does not query that `fts` column — lexical matching is done by the in-memory Okapi BM25 index described below — so the column and index are currently unused reserve capacity.

Two indexes serve the dense leg and the reserve lexical column: an HNSW cosine index on the embedding (`m = 16`, `ef_construction = 64`) and a GIN index on the generated `fts` column. The `vector` and `unaccent` extensions are created as superuser before any role-scoped DDL.

Role grants are the read boundary. The `agent_ro` role used by the gateway has `USAGE` on the `semantic` schema plus chunk-only `SELECT` on `semantic_chunks` — no default privileges, so future semantic tables stay invisible. The `indexer` role holds full write grants on present and future `semantic` tables and zero rights on `public`.

## 7. Hybrid retrieval

`hybridSearch(query, embedder, text, topK, allowRestricted)` fuses three legs with weighted Reciprocal Rank Fusion at `k = 60` and weights `[1.0, 1.0, 1.5]`:

1. **Dense vector leg.** Cosine search (`embedding <=> $1::vector`) over rows with non-null embeddings, selecting `1 - distance` as `dense_score` and ordering by distance. It fetches `max(topK * 3, topK)` candidates.
2. **Lexical BM25 leg.** In-memory Okapi BM25 (`Bm25Retriever` with `k1 = 1.2`, `b = 0.75`) over a hot-reloaded catalog of `content` plus `metric_name`, `aliases`, `table_name`, and `tables`. Tokenization lowercases, preserves Vietnamese diacritics while also emitting ASCII-folded variants, splits `_`/`.`/`-` compounds into sub-tokens, and removes Vietnamese plus English stopwords. The leg returns at most `max(topK * 3, topK)` hits ordered by BM25 score.
3. **Deterministic alias leg.** `matchAliases` checks normalized query forms (lowercased, ASCII-folded, underscore-aware spaced variants) against `metric_name`, `aliases`, `chunk_id` plus its suffix and spaced form, and `table_name` with exact-first then longest-phrase then `chunk_id` ordering. Any exact or word-boundary substring hit (minimum two characters) ranks in this leg and sets `aliasMatched = true` on the fused chunk.

Unless `allowRestricted` is true, all three legs exclude `sensitivity = 'restricted_pii'`. Rank lists are fused by the pure `fuseRRF` helper: each hit contributes `weight / (60 + rank)` per leg it appears in with default weights `W_DENSE = 1.0`, `W_BM25 = 1.0`, `W_ALIAS = 1.5`, results sort by fused score with first-seen order breaking ties, and the list truncates to `topK`. `rrfScore` recomputes the same number for the returned `score` field, and the pure boundary mapper `toContractChunk` converts each fused storage row to the camelCase contract shape, splitting comma-joined `tables` and attaching `aliasMatched` plus `denseScore` whenever they are defined.

```mermaid
flowchart TD
  Q["User query"] --> D["pgvector cosine leg"]
  Q --> B["In-memory BM25 leg"]
  Q --> A["Alias matcher leg"]
  D --> R["Weighted RRF fusion k equals 60"]
  B --> R
  A --> R
  R --> J["Join-rule graph expansion"]
  J --> S["Contract chunks with score"]
```

*Caption: Three-way hybrid retrieval fusing vector, BM25, and alias ranks with RRF and join expansion.*

Automatic join-rule graph expansion runs after fusion: `expandJoinRules` collects tables from the top-5 fused chunks, finds `join_rule` rows whose tables overlap with at least two of those tables, and injects them while keeping the result within `topK` — appending when there is room, otherwise replacing the lowest non-join tail entry. Candidates sort by overlap descending, then fused score, then id.

The BM25 catalog is cross-process hot-reloaded. Before each search, `hybridSearch` probes `MAX(updated_at)` plus `COUNT(*)`; when either differs from the cache it reloads the full catalog, rebuilds the in-memory BM25 index, and refreshes the citation catalog (`chunk_id`, `metric:`, `table:`, bare table, and `column:`-stripped ids). A mockable query function plus a vector-row fallback keeps unit tests DB-free when the watermark probe is unavailable.

## 8. Gateway exposure

The `search_semantic_layer` tool is registered with description `Hybrid vector plus full-text search over the versioned semantic corpus`, requires the `data:read` scope, and takes `{ query, topK }` with `topK` defaulting to 5 and capped at 20. In the fixed pipeline it runs after bearer authentication, scope check, and zod validation; because it carries no client SQL it skips the guard and policy stages vacuously. The handler derives `allowRestricted` from the `data:sensitive` scope, calls the injected search function (production: `hybridSearch` over the `agent_ro` pool with the environment-selected embedder), runs `redactPII` over every returned chunk body while counting hits, and always writes exactly one audit line including on denials.

The two resources `semantic://data-dictionary` and `semantic://metrics` are served from the checked-in Markdown files. Resource reads require the `schema:read` scope, withhold every `## ` section whose header ends in `[restricted_pii]` unless the principal holds `data:sensitive`, then apply the same PII redaction and audit as tool calls.

## 9. UC-02 grounding contract (planned)

The following UC-02 behaviors are specified in the UC-02 plan but have no implementation in the agent package, whose root graph still exposes only a generic injectable `retrieve` hook and whose checkpointed state carries only a minimal `chunkId` plus `score` plus `text` semantic entry:

- **Three-route retrieve-then-decide node.** After intent understanding, a `retrieveSemantic` node would route to unknown-metric clarification (`cannot_answer` without inventing a formula), definitional fast-path (synthesize from the chunk without SQL), or grounded SQL generation with formulas and join rules injected.
- **Two-tier unknown-term guardrail.** Intent extraction would split `requested_metrics` (business KPIs) from `schema_entities` (plain tables, columns, filter literals) so empty metric lists never falsely refuse basic table queries, while unmatched metrics require an exact or substring alias hit, a dense score above the calibrated threshold plus a grounding confirmation, or an explicit user-supplied formula.
- **Deterministic dual citations.** Every SQL answer would carry a `citations` array plus a prepended `-- @citations: ...` SQL header comment, validated against the chunk catalog and current context for catalog membership, context grounding, and metric coverage, with up to two self-correction retries.
- **Acceptance and eval gates.** Recall at 5 of at least 0.85, execution-accuracy lift of at least 15 points with the layer on versus off, 100% valid citations, clarification without hallucination on unknown terms, and incremental reindex visibly changing behavior while re-embedding only the changed chunk — measured with token, cost, and latency telemetry over disjoint few-shot and graded question sets.

Coding agents must not assume any of these exist in code paths today; implement against the gateway tool and resources above and treat the plan as the spec for the missing pieces. The hot-reload citation catalog helper (`getCitationCatalog`) exists for future validator use but no validator calls it yet.

## 10. Configuration, invariants, and focused tests

Key configuration is the two Markdown corpus files plus auto-discovered `semantic/*.yaml`/`*.yml`, the `INDEXER_DATABASE_URL` write URL, the embedder environment (`EMBEDDING_MODEL_ID`, `OPENAI_COMPATIBLE_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_DIM`), the contract `topK` default and cap, the fixed `RRF_K = 60` with weights `[1.0, 1.0, 1.5]`, the BM25 parameters `k1 = 1.2` and `b = 0.75`, and the HNSW build parameters.

Invariants to preserve when changing this area:

- Never split one semantic unit across chunks; fixed-token windowing breaks metric-to-definition binding.
- Never skip the content-hash diff: re-embedding everything on every edit defeats the incremental guarantee.
- Never skip the delete pass: removed sections must leave the table or stale definitions keep grounding answers.
- Never serve `restricted_pii` chunks or resource sections to principals without `data:sensitive`; the retriever filter, alias filter, BM25 filter, join-expansion filter, and the section filter must agree.
- Never change the embedding dimension without DDL plus full reindex; the column is fixed at 1536.
- Never bypass the snake_case to camelCase boundary mapper; storage text with commas must split into clean arrays, and `aliasMatched` plus `denseScore` must only appear when the fusion path sets them.
- Never assume Postgres FTS is the lexical leg; the GIN/`fts` column is reserve DDL while `hybridSearch` uses in-memory BM25 plus the alias matcher.

Common failures are an unset indexer URL, an OpenAI embedder missing model or key, dimension mismatch after an endpoint change, and assuming join-rule expansion or alias matching can be skipped for short queries.

Focused tests live in the DB-free semantic unit suite: fake-embedder shape, determinism, and normalization; weighted RRF ordering at `k = 60` with stable tie-breaking and `topK` truncation plus alias-weight boost; BM25 diacritic folding, sub-token expansion, Okapi scoring, and `allowRestricted` filtering; alias exact-versus-substring ranking and `aliasMatched` propagation through `hybridSearch`; join-rule injection and tail replacement at `topK`; cross-process hot-reload of the BM25 index and citation catalog on watermark change; resource section filtering with and without `data:sensitive`; storage-to-contract mapping; and corpus chunking with metadata parsing and restricted-header tagging.
