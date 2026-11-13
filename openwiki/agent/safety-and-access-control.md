---
type: safety-guide
title: Safety and access control
description: Cross-cutting safety for the Analytics Agent covering read-only connections, SQL validation, agent pre-checks, RBAC with masking, PII redaction, error-code routing, budgets, and human approval.
tags: [safety, access-control, rbac, pii-masking, read-only, security]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-13T15:50:35.780Z
sources:
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-ba5c039f004135618d4a749a
    resource: repo://docs/UC-plan/UC01.md
  - id: openwiki-source-2fda883e9b76745f69f487f7
    resource: repo://eslint.config.mjs
  - id: openwiki-source-a55e0aedff6bc7c1b180ad4e
    resource: repo://packages/access-policy/src/constants.ts
  - id: openwiki-source-8a4a02a97b3e26db6e2b78f1
    resource: repo://packages/access-policy/src/guard.ts
  - id: openwiki-source-c16e3c66d0f5ea30d7c07479
    resource: repo://packages/access-policy/src/policy.ts
  - id: openwiki-source-3f82b4be2a1410e16d9ef4b7
    resource: repo://packages/access-policy/src/redactor.ts
  - id: openwiki-source-bb7cebdc5c6ade7e59d6a8b9
    resource: repo://packages/access-policy/src/sensitive-columns.ts
  - id: openwiki-source-bfb9871db1c11a0b91b0e3c3
    resource: repo://packages/agent/src/constants.ts
  - id: openwiki-source-2b41979f39c43eeafef4e2e9
    resource: repo://packages/agent/src/hitl.ts
  - id: openwiki-source-838b92d36d280a2d1f63bcc2
    resource: repo://packages/agent/src/queryExecutor/budgets.ts
  - id: openwiki-source-634e4e64a4c4f79f29496091
    resource: repo://packages/agent/src/queryExecutor/executor.ts
  - id: openwiki-source-7405bf10324bacfc1a6b7abd
    resource: repo://packages/agent/src/queryExecutor/safetyGate.ts
  - id: openwiki-source-f2db2c9ab36ff7be6949082d
    resource: repo://packages/contracts/README.md
  - id: openwiki-source-3e1ec54e40c3b23967c408a1
    resource: repo://packages/contracts/src/constants.ts
  - id: openwiki-source-4c4499ad1e842a81b6f27cfc
    resource: repo://packages/contracts/src/tools.ts
  - id: openwiki-source-a21c007774a13621a14b7859
    resource: repo://packages/mcp-server/src/audit.ts
  - id: openwiki-source-af866a7ab8db1e37b5da722b
    resource: repo://packages/mcp-server/src/auth.ts
  - id: openwiki-source-c0a91056179fae92fe592626
    resource: repo://packages/mcp-server/src/catalog.ts
  - id: openwiki-source-edb0df25ab85a5dd65a32711
    resource: repo://packages/mcp-server/src/config.ts
  - id: openwiki-source-80d7c64af501ca63c5b59584
    resource: repo://packages/mcp-server/src/constants.ts
  - id: openwiki-source-6059339105a2039b4704c0b6
    resource: repo://packages/mcp-server/src/errors.ts
  - id: openwiki-source-556e762ce8bac7b936e1dff4
    resource: repo://packages/mcp-server/src/executor.ts
  - id: openwiki-source-c6764c62ef243702a1e271ac
    resource: repo://packages/mcp-server/src/pipeline.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-13T15:50:35.780Z" }
---

# Safety and access control

This page owns the cross-cutting safety rules every query path must satisfy: read-only connections, SQL validation, role-based access with masking, PII redaction, run budgets, error-code routing with retryable versus repairable handling, and human-in-the-loop approval including the costly-query decision. Enforcement lives in the shared `access-policy` package, the agent `ValidatedQueryExecutor` pre-checks described in [Workflow Architecture](./workflow-architecture.md), the gateway pipeline described in [MCP Server](../integrations/mcp-server.md), and the generation path in [Text to SQL](../use-cases/text-to-sql.md).

> Core invariant: prompting alone is never a safety layer. Every guarantee below is enforced in code — in the validator, in the agent gate, in the policy rewrite, at the connection, in the budget check, in the approval interrupt, or in the redaction choke-point — so disabling or tricking the prompt does not lift the restriction.

## 1. Defense-in-depth layers

Safety is independent checks that must all agree before data returns:

1. **Validator layer (before any MCP call).** The shared `sqlGuard` parses the candidate with `pgsql-parser` (real PostgreSQL grammar compiled to WASM, warmed once at startup), allows exactly one `SelectStmt`, rejects DDL/DML and dangerous functions, denies system schemas, and checks tables and columns against the catalog whitelist.
2. **Agent gate layer (still before any MCP call).** `localQuerySafetyGate` runs after `sqlGuard` and owns the agent-side extras: sensitive-column denial in any clause, unconditioned-join denial, large-table clarification, and a detail-query `LIMIT` clamp. The server remains authoritative.
3. **Policy layer (on the server, before execution).** Bearer authentication resolves a server-built principal, a scope gate checks the tool's required scope, zod validates inputs, then `ColumnScopePolicy` rewrites or denies the SQL (masking, row predicates, fail-closed resolution).
4. **Connection and output layers (during and after execution).** The only database identity runs `BEGIN READ ONLY` with a 30-second timeout and bounded cursor reads; every result row, semantic chunk, resource read, audit line, and error message passes a shared PII/error redaction choke-point.
5. **Budget and approval layer (around the run).** `checkBudget` is consulted before every LLM and MCP call and a trip stops further calls; `pauseForApproval` / `resumeDecision` suspend the graph for human review on the same thread id instead of re-running generation.

Turning off any one layer still leaves the others blocking: a validator bypass still faces the policy rewrite and the database's own read-only rejection.

## 2. Read-only connections

The agent never opens its own database handle. All access goes through the `db-tools` MCP server over an authenticated client, and lint forbids `pg`, `pg-cursor`, and `mcp-server` internals in `packages/agent`, `packages/access-policy`, and `apps/api` — except the `apps/api` state-store DAO and its test, which legitimately own `pg`. Only the gateway and its operator loader plus that DAO may touch the driver.

Each execution borrows a pooled `agent_ro` client and follows a fixed contract:

- `BEGIN READ ONLY`, then `SET LOCAL statement_timeout = '30s'`.
- Bounded read through `pg-cursor`: `read(maxRows + 1)` detects overflow; over-limit results return `truncated = true` instead of streaming unbounded rows. `maxRows` must be an integer in `1..1000`.
- `ROLLBACK` plus client `release()` in `finally`, so teardown failures never mask the original error and connections never leak.
- Zero-row results still recover column names with a cheap `SELECT * FROM (...) AS _cols LIMIT 0` probe in the same read-only transaction.

Timeouts surface as a distinct `TIMEOUT` code mapped from PostgreSQL cancel code `57014`; write attempts that slipped the guard map to `FORBIDDEN_STATEMENT` via `25006` (read-only transaction) or `42501` (insufficient privilege). Runtime data errors (class `22`, residual class `42`) map to repairable `SQL_EXECUTION_ERROR`; connection and resource classes stay retryable `INTERNAL_ERROR`; unknown codes fail safe to `INTERNAL_ERROR`.

## 3. SQL validator (`sqlGuard`)

Every candidate statement passes `sqlGuard` locally in the agent and independently again on the server, reusing the parsed AST downstream so the pipeline never parses twice.

Allowed shape:

- Exactly **one** statement in the parse result; empty input is `INVALID_SQL`.
- Root node is `SelectStmt`, which covers plain `SELECT`, `WITH`, and set operations such as `UNION`.
- Referenced tables and columns exist in the schema catalog (exact match first, lowercase fallback for PG folding); unknown names are `UNKNOWN_TABLE`. CTE names, FROM-subquery outputs, table aliases, and `ORDER BY`/`GROUP BY` alias resolution are handled explicitly; unknown qualifiers and unresolvable references deny fail-closed.

Denylist (absolute bans):

- All DDL/DML statement tags: `InsertStmt`, `UpdateStmt`, `DeleteStmt`, `MergeStmt`, `CopyStmt`, `TruncateStmt`, plus transaction/session tags (`TransactionStmt`, `VariableSetStmt`, `VariableShowStmt`, `DiscardStmt`), DDL tags (`CreateStmt`, `DropStmt`, `AlterStmt`, `AlterTableStmt`, `RenameStmt`, `GrantStmt`, `CommentStmt`), and execution/introspection tags (`ExplainStmt`, `PrepareStmt`, `ExecuteStmt`, `DeallocateStmt`, `CallStmt`, `DoStmt`, `ListenStmt`, `NotifyStmt`, `LockStmt`, `VacuumStmt`, `CheckPointStmt`, `ReindexStmt`, `ClusterStmt`). DML nested inside CTEs such as `WITH x AS (DELETE ... RETURNING *) SELECT *` is caught because the tags are denied anywhere in the walked tree.
- `SELECT INTO` (via `intoClause`) and `FOR UPDATE`-style locking clauses.
- Dangerous functions matched on the lowercased last segment of `FuncCall.funcname`, so schema-qualified and any-case spellings are caught: `pg_sleep`, `pg_read_file`, `pg_ls_dir`, `pg_logdir_ls`, `dblink`, `dblink_exec`, `lo_import`, `lo_export`, `lo_unlink`, `set_config`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_execute_server_program`, `nextval`, `setval`, `currval`. Everything not listed passes — the function check is deny-by-exception.
- System schemas `pg_catalog`, `information_schema`, `pg_toast` are denied explicitly even if a future catalog listed them.
- Multi-statement payloads such as `SELECT 1; DROP TABLE orders` fail the single-statement rule.

Error behavior is part of the guard: parse failures return `INVALID_SQL` with a cursor position for self-repair; policy denials use the frozen 12-code contract (`SCOPE_DENIED`, `FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION`, `SENSITIVE_COLUMN_DENIED`, `UNKNOWN_TABLE`, `TIMEOUT`, and others). Only these sanitized codes reach the repair prompt — never raw driver errors, connection strings, or secrets.

## 4. Agent-side safety gate

`localQuerySafetyGate` is a pure, DB-free pre-check that runs after `sqlGuard` and before any MCP call. Its verdicts are `pass` (with possibly clamped SQL), `deny`, or `needs_clarification`.

- **Sensitive columns:** denies with `SENSITIVE_COLUMN_DENIED` when any catalog-marked sensitive column of a scanned table appears in `guard.columns`, which already collects named refs from every clause (projection, `WHERE`, `JOIN ON`, `GROUP BY`, `HAVING`, `ORDER BY`, function and aggregate args). This is intentionally stricter than the server: the agent gate blocks even projection reads that the server would mask.
- **Joins:** denies any `JoinExpr` with no `ON`/`USING` condition (both `CROSS JOIN` and condition-less inner joins parse this way) and any comma-separated `FROM` list, which is an implicit cross join. `NATURAL JOIN` is left to the server-side guard.
- **Large tables:** when a scanned table has any `large`-flagged column (the gateway catalog marks `order_items` and `orders` large; agent tests inject the flag via catalog override), and the query is not an aggregate and lacks an indexed time bound, the gate returns `needs_clarification` asking for a time range before running. An aggregate is a known aggregate call in the root `targetList` (for example `COUNT(*)`) or a root `GROUP BY`/`HAVING`; scalar functions such as `LOWER(status)` and aggregates hidden inside a CTE do not exempt an outer detail scan. The time bound must be a direct conjunctive comparison on `purchase_date` (`>`, `>=`, `<`, `<=`, `BETWEEN`), qualified refs and `CURRENT_DATE` windows included; string literals, `IS NOT NULL`, and predicates hidden behind `OR` do not satisfy it. `order_items` satisfies the policy through the required join to `orders` when the parent `purchase_date` filter is present; province or status filters narrow but never replace it.
- **Detail-query clamp:** non-aggregate queries pass with `clampLimit(sql, 200)` — an existing `LIMIT` at or under the cap is untouched, a larger or `ALL` limit is tightened, an offset-only query gains a `LIMIT 200`, otherwise `LIMIT 200` is appended. Non-numeric limits are left for the server rather than producing invalid SQL.
- **Timeout simplification:** a `TIMEOUT` gets exactly one forced rewrite that drops the `ORDER BY` tail and tightens the limit to 50, then re-passes guard plus gate before any MCP call.

Only `REPAIRABLE_CODES` (`INVALID_SQL`, `UNKNOWN_TABLE`, `SQL_EXECUTION_ERROR`) retry with repair feedback; hard security codes (`SCOPE_DENIED`, `SENSITIVE_COLUMN_DENIED`, `FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION`, `UNAUTHORIZED`) map to a `restricted` terminal status and never enter the repair loop.

## 5. Validate-policy-execute decision path

The required server order is authenticate, then scope, then zod, then `sqlGuard`, then `AccessPolicy` (reusing the guard AST with no double parse), then the read-only executor, then PII scan plus exactly one audit line. Non-SQL tools skip the middle stages vacuously; the audit stage always runs, including on denials.

```mermaid
flowchart TD
  A["Receive tool call plus Bearer token"] --> B["Authenticate and check tool scope"]
  B --> C["Validate inputs and guard SQL"]
  C --> D["Apply RBAC rewrite or deny"]
  D --> E["Execute read-only with row cap"]
  E --> F["Redact PII and write audit line"]
  C -- Denied --> F
  D -- Denied --> F
```

*Caption: Server pipeline order from authentication through guard and policy to redacted audit.*

Concretely:

- Unknown tools are `INVALID_PARAMS`; missing or bad tokens are `UNAUTHORIZED` before any SQL is read; a client with only `schema:read` calling `run_query` is `SCOPE_DENIED`. Field paths — never values — are echoed on zod failures.
- `run_query` and `sample_rows` run the shared `runSqlStages` (guard, policy, `executeReadOnly` on the rewritten SQL, `redactRow` per row, `maskedColumns` echoed back). `sample_rows` is synthesized as `SELECT * FROM "table" LIMIT n` with `n <= 5`.
- `explain_query` runs guard plus policy, then `EXPLAIN (FORMAT JSON)` on the rewritten SQL and returns `estimatedCost` plus `estimatedRows`. Inputs containing `ANALYZE` are rejected without running; unparseable plans are `INTERNAL_ERROR`. There is no server-side cost threshold or automatic human pause — cost-driven approval, if any, is a caller/workflow decision made from the returned estimate.
- The agent executor describes only the candidate tables (budget-checked per call; describe failures return immediately), proposes SQL, then runs the local `sqlGuard` plus safety-gate pre-check with no MCP call past a failure. It calls `explain_query` before `run_query` on the gate-approved SQL (both budget-checked), then `run_query` with `maxRows: 1000` as the transient in-process validation buffer (checkpoint previews keep only 50 rows). A gate `needs_clarification` returns immediately unless the user already supplied a `timeRange`, which triggers one `selected_time_range` repair instead. An empty result at attempt one with a `WHERE` filter runs a single-pass zero-row diagnostic — resolve direct string-literal filters to table/column pairs, re-describe and `sample_rows` (`n=5`) each relevant table once, then run guarded `DISTINCT` probes capped at 20 rows — and only a concrete near-match retries; otherwise it concludes `no_data`.

### 5.1 Frozen error contract and retry routing

The 12 frozen contract codes are the single authority for retry versus repair decisions. `retryable` and `repairable` are computed by `dbToolError()` from `RETRYABLE_CODES` and `REPAIRABLE_CODES`; truncation is the `truncated` flag rather than an error, and `RATE_LIMITED` remains reserved.

| Category | Codes | Handling |
|---|---|---|
| Transport / transient | `TIMEOUT`, `RATE_LIMITED`, `INTERNAL_ERROR` | MCP client retries with backoff; `TIMEOUT` allows one simplification rewrite |
| SQL / schema diagnostic | `INVALID_SQL`, `UNKNOWN_TABLE`, `SQL_EXECUTION_ERROR` | `ValidatedQueryExecutor` repairs with sanitized code plus `cursorPosition`, at most 3 attempts total |
| Hard security / policy | `UNAUTHORIZED`, `SCOPE_DENIED`, `INVALID_PARAMS`, `FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION`, `SENSITIVE_COLUMN_DENIED` | Immediate hard abort on attempt 1, never a repair loop; `UNAUTHORIZED`, `SCOPE_DENIED`, `FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION` and `SENSITIVE_COLUMN_DENIED` surface as `restricted`, while other hard codes such as `INVALID_PARAMS` surface as `error` |

`SQL_EXECUTION_ERROR` covers runtime data errors from valid-parse SQL (PostgreSQL classes `22` and residual `42`): repairable by the SQL generator, never retried by the transport.

## 6. RBAC and PII masking in code

Each caller acts under a server-built principal. Example roles: a southern regional sales lead restricted to southern rows, a marketing specialist with nationwide aggregates but no unmasked contact details, an HR staffer who may see salary data, and an administrator. Role comes from the verified Bearer token mapped through `policies/mcp_clients.yaml` — never from the utterance — so claiming to be an administrator has no effect.

### 6.1 Policy files and scopes

Access is declared in YAML and validated at boot with strict `zod` schemas; any violation (malformed YAML, wrong version, empty names, unknown scopes, extra keys, duplicate client or token names, missing token env values) throws so the server never boots half-secured. Tokens live only in the environment variables named by `tokenEnv`, are compared with `timingSafeEqual`, and are never logged. `X-Run-Id`, `X-User-Id`, and `X-Role-Scope` headers are transport telemetry only, never proof.

- `policies/mcp_clients.yaml` maps each client to `role`, `scopes`, and an optional `rowScope` (`column` plus `value`; today `sales_south` is scoped to `region_group = Nam`). Valid scopes are exactly `schema:read`, `data:read`, `data:sensitive`.
- `policies/sensitive_columns.yaml` declares the sensitive registry (today `customers.phone`, `customers.email`, `customers.address`, `employees.salary`; version literal `1`). The catalog builder merges these flags with the `information_schema` columns and marks `large` tables (gateway `order_items` and `orders`); an empty catalog throws instead of serving nothing as something.
- Tool-to-scope mapping requires `schema:read` for `list_tables` and `describe_table`, and `data:read` for `explain_query`, `run_query`, `sample_rows`, and `search_semantic_layer`. Callers without `data:sensitive` get masked — not raw — sensitive output.

### 6.2 Rewrite, fail-closed resolution, and indirect-leak blocking

`ColumnScopePolicy` rewrites SQL before execution:

1. Resolves every column reference to `table.column` with clause (`projection`, `where`, `join`, `group`, `having`, `order`, `funcarg`, `aggregate`), expanding `*`, aliases, joins, and single-level CTEs.
2. Without `data:sensitive`, a sensitive column in the projection is replaced with a masking fragment that preserves the output column name: `left("qual"."col", 3) || '****'` for text-like types, `CAST(NULL AS <type>)` for other typed columns. Star lists that would expose sensitive columns are spliced item-by-item; stars over only non-sensitive columns stay byte-identical.
3. Without `data:sensitive`, a sensitive column anywhere else — `WHERE`, `JOIN`, aggregate, scalar function, or ordering — denies with `SENSITIVE_COLUMN_DENIED`. Probing with `WHERE phone LIKE '090%'` or averaging a restricted salary column therefore fails even though the caller never sees the raw value.
4. Anything that cannot be resolved unambiguously on a table with sensitive columns denies fail-closed with `SENSITIVE_COLUMN_DENIED` or `FORBIDDEN_STATEMENT`: ambiguous unqualified columns, unknown qualifiers, non-enumerable subquery outputs (star, unaliased expression, set operation inside the subquery), multi-level CTEs, and `LATERAL` over sensitive tables.
5. Row predicates are AND-ed per query level using that level's alias or bare name (equality on the scoped column). Opaque or ambiguous placement over a scoped table denies instead of guessing.
6. Every rewrite is deparsed, re-parsed, and re-guarded; a rewrite that fails to render, re-parse, or re-guard denies instead of running.

Metadata and search respect the same principal: `describe_table` exposes column `sensitive` and `large` flags plus keys so callers can avoid what they may not see; `search_semantic_layer` and resource reads withhold `## ... [restricted_pii]` sections from callers without `data:sensitive`.

Denials identify themselves as permission decisions (`SCOPE_DENIED`, `SENSITIVE_COLUMN_DENIED`) so the agent says access was denied for that role instead of pretending no data exists.

## 7. Prompt-injection defenses

Query results are treated as untrusted data: rows are scanned and masked before display but never followed as instructions. The remaining defenses are code enforcement, not prompt wording:

- **SQL injection in the question** (for example appending a drop-table fragment) is blocked by the single-statement validator and the read-only connection.
- **Privilege escalation** (for example a marketing role requesting bulk customer phones or another employee's salary) is blocked by scope checks, column policy, and the post-execution scan.
- **Injection inside data** (for example a product name telling the model to disclose phone numbers) is contained because tool output is rendered as masked data, never executed.
- **Hanging or exploding queries** (for example an embedded sleep function or unconstrained join) are blocked by the function denylist, the agent join check, `EXPLAIN` estimation, and the database `statement_timeout`.
- **Fabrication pressure** (for example demanding data for a future year) is handled by returning `no_data`/`cannot_answer` with the missing table or column named, never an invented estimate.
- **Impersonation** (for example claiming administrator rights) has no effect because scopes come from the token-to-client map alone.

## 8. Observability without leaking data

Every run carries a run ID that joins the agent trace to the server audit log. Each tool call records client, scope, tool, parameters, returned row count, duration, decision (`allow`/`deny`), error code on denial, `explainCost`, and `piiHits`; resource reads are audited under `resource:<uri>` the same way.

Leak prevention is centralized:

- `sanitizeError` is the single choke-point for driver errors: it strips DSN credentials, `host=` assignments, IPv4 literals, `user "..."` fragments, filesystem paths (detail/hint only, never the message where `/` may be division), and stack-frame lines; runs the shared PII redactor over the composed message; caps at 500 characters; and maps PostgreSQL SQLSTATEs to the frozen contract codes.
- `redactPII` masks Vietnamese phone shapes (mobile `03/05/07/08/09`, landline `02X`, international `+84`, with separators between any digits) and standard email shapes with `[MASKED_PHONE]` / `[MASKED_EMAIL]`, returning a hit flag; `redactRow` applies it to every string cell of each result row.
- `auditCall` appends exactly one synchronous JSONL line per call: SQL string literals are collapsed to `'?'` (shapes, never values), then the whole line is PII-scrubbed. Traces and logs must never contain unmasked PII values, literal PII inside logged SQL parameters, or connection secrets.

## 9. Budgets and human-in-the-loop approval

Safety also bounds how long a run may try and when a human must decide.

- **Run budgets:** `createBudgetState` builds per-run counters (`llmCalls`, `tokensUsed`) plus an absolute `deadlineMs` from `BUDGET_LIMITS` (`maxLlmCalls: 20`, `maxTokens: 60000`, `runDeadlineMs: 120000`). `checkBudget` is pure and never mutates state — it returns `{ tripped: false }` or `{ tripped: true, reason, state }` with reason `llm-calls`, `tokens`, or `deadline`. The executor calls it before every LLM and MCP call (selective describe, propose, guard, `explain_query`, `run_query`, zero-row probe); a trip stops further calls and degrades to synthesis with partial findings, surfacing `cannot_answer` with `budgetExceeded: true`, the `tripReason`, and `partials` (`tablesDescribed`, `lastSql`, `rowsFetched`). `recordLlmCall` records count plus token usage after each proposal, with `estimateTokens` (length divided by 4) as the conservative fallback when the provider omits usage.
- **Costly-query approval:** `explain_query` is the cost gate. The server returns `estimatedCost` and `estimatedRows` from `EXPLAIN (FORMAT JSON)` on the policy-rewritten SQL, but enforces no threshold itself. Approval policy lives with the caller or workflow: the agent path always explains before running so the estimate is observable in spans and audit, the large-table clarification path forces a time range before expensive scans, run budgets bound total attempts, and any hard human pause uses the HITL primitive below. Lightweight queries must never request approval.
- **Clarification vs approval:** the large-table gate returns `needs_clarification` (ask for a time range, an aggregate, or a smaller table) via `requestClarification`, which requires a non-empty question, two to four options, and an `attempts` count from `0` to `2`, and carries `pendingClarification` with `sql: null`. True human approval uses a different primitive: `pauseForApproval` wraps LangGraph `interrupt` and must be called inside a node — the graph suspends there and resumes only when the host invokes the `resumeDecision` command (`new Command({ resume: value })`) on the same thread id. Resuming with a fresh input object is forbidden because it would re-run generation and risk double-executing side effects.
- **Thread identity:** `makeThreadId(userId, sessionId)` builds the stable `chat:{userId}:{sessionId}` key, throwing on empty parts or ids at or over the 255-character limit so resume never lands in a truncated thread; `isSameThread` is strict equality. The interrupt plus same-thread resume pattern is proven DB-free on `MemorySaver`: completed nodes are not re-run, while a fresh thread starts clean.

## 10. Configuration and operations

- Declare clients, tokens, scopes, row predicates, and sensitive columns in YAML under `policies/` and validate at boot; fail startup on invalid config or missing token env values.
- Authenticate every MCP request with a Bearer token mapped to `{clientId, scopes, role}` plus optional `rowScope`; share input/output shapes from a single contracts package so scope and error-code drift is a type error.
- Keep the parser warm: run one `SELECT 1` parse at server boot (and in test setup) so per-call overhead stays at tens of milliseconds; never use the synchronous parse on a request path.
- Enforce the MCP boundary in lint plus code review: the agent reaches the database only through the MCP client, never a direct import.
- Cap outputs by contract: `run_query` defaults to 200 rows and rejects `maxRows` outside `1..1000` (the executor passes 1000 as its transient validation buffer while checkpoint previews keep 50); `sample_rows` caps at 5; over-limit reads set `truncated` rather than streaming.
- Keep budgets at their locked defaults unless an explicit override is passed to `createBudgetState`; inject `nowMs` only in tests for deterministic deadline checks.

## 11. Focused tests that matter

- **Validator matrix:** valid selects, DDL/DML in every clause position (including inside CTEs), multi-statements, `SELECT INTO`, locking clauses, banned functions (including qualified and mixed-case spellings), unknown tables and columns, system-schema access, alias and subquery resolution edges.
- **Connection proof:** attempt a write as the agent identity directly and assert the database rejects it with its native read-only error.
- **Scope matrix:** `schema:read` calling `run_query`, missing or bad tokens, masked versus raw salary access by role, `ANALYZE` in `explain_query`, and wildcard selects over sensitive tables.
- **Indirect-leak cases:** filtered, aggregated, concatenated, and alias-renamed sensitive columns, plus unresolvable shapes over sensitive tables asserting fail-closed denial.
- **Agent-gate cases:** large-table scans with and without `purchase_date` bounds and aggregates (including `OR`-hidden, literal, `IS NOT NULL`, scalar-function, and CTE-aggregate bypass attempts), unconditioned and comma joins, `LIMIT` clamping (including `ALL`, oversized, offset-only, and parameter forms), and the single TIMEOUT simplification (matrix covered DB-free in `packages/agent/test/safetyGate.test.ts`).
- **Budget and HITL cases:** tripped `llm-calls`, `tokens`, and `deadline` budgets degrading to `cannot_answer` with partials preserved; stable thread-id validation and same-thread resume without re-running completed nodes versus a fresh thread starting clean.
- **Leak scan:** pattern plus policy cross-check over every result, chunk, trace, and audit line asserting zero raw leaks while in-scope accuracy stays above target.
