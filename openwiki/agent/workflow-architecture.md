---
type: workflow-architecture
title: Agent workflow and harness architecture
description: Reference agent loop and shared harness with frozen LangGraph root, registry seam, ValidatedQueryExecutor, memory ports, trace, and import boundaries.
tags: [agent-workflow, langgraph, harness, tools, skills, memory, guardrails, trace]
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-a53a8de5929686354550dafa
    resource: repo://docs/prd.md
  - id: openwiki-source-ba5c039f004135618d4a749a
    resource: repo://docs/UC-plan/UC01.md
  - id: openwiki-source-2fda883e9b76745f69f487f7
    resource: repo://eslint.config.mjs
  - id: openwiki-source-bfb9871db1c11a0b91b0e3c3
    resource: repo://packages/agent/src/constants.ts
  - id: openwiki-source-7a382cb67515f2241c13f47e
    resource: repo://packages/agent/src/graph.ts
  - id: openwiki-source-2b41979f39c43eeafef4e2e9
    resource: repo://packages/agent/src/hitl.ts
  - id: openwiki-source-efd354d1790c704138299c4c
    resource: repo://packages/agent/src/index.ts
  - id: openwiki-source-cf7b0783e74389747b99b53f
    resource: repo://packages/agent/src/mcpClient.ts
  - id: openwiki-source-d45ee892fc2196786928ff7e
    resource: repo://packages/agent/src/ports/checkpoints.ts
  - id: openwiki-source-634e4e64a4c4f79f29496091
    resource: repo://packages/agent/src/queryExecutor/executor.ts
  - id: openwiki-source-7405bf10324bacfc1a6b7abd
    resource: repo://packages/agent/src/queryExecutor/safetyGate.ts
  - id: openwiki-source-8f32b5188dc80fbc97e18ece
    resource: repo://packages/agent/src/state.ts
  - id: openwiki-source-6e14a80344fc52e883de4e14
    resource: repo://packages/agent/src/subgraphs/registry.ts
  - id: openwiki-source-0da85c5a9f665a701eb30287
    resource: repo://packages/agent/src/subgraphs/textToSql.ts
  - id: openwiki-source-93a03973ec4e89dfae3f10d6
    resource: repo://packages/agent/src/telemetry/spans.ts
  - id: openwiki-source-408f45a62f1908cd7c20780f
    resource: repo://packages/agent/src/traces/writer.ts
  - id: openwiki-source-2220f8a1f08f90507d34f468
    resource: repo://packages/agent/test/executor.test.ts
  - id: openwiki-source-3d6a5ae76ff0ff0b71d87e6c
    resource: repo://packages/agent/test/graph.test.ts
  - id: openwiki-source-3bf32d17acb1209db727f646
    resource: repo://packages/agent/test/safetyGate.test.ts
  - id: openwiki-source-f2db2c9ab36ff7be6949082d
    resource: repo://packages/contracts/README.md
  - id: openwiki-source-7e0040da42161d36a3d5b9e7
    resource: repo://packages/contracts/src/answers.ts
  - id: openwiki-source-3e1ec54e40c3b23967c408a1
    resource: repo://packages/contracts/src/constants.ts
  - id: openwiki-source-98368e815b09337901519116
    resource: repo://packages/contracts/src/errors.ts
  - id: openwiki-source-72efaf773522f7b91f911aa6
    resource: repo://packages/contracts/src/index.ts
  - id: openwiki-source-4c4499ad1e842a81b6f27cfc
    resource: repo://packages/contracts/src/tools.ts
  - id: openwiki-source-5fe6c5a5ba5566d0444a9992
    resource: repo://packages/contracts/src/trace.ts
  - id: openwiki-source-11c607a59793f98cdd3bfa50
    resource: repo://packages/contracts/test/schemas.test.ts
  - id: openwiki-source-5ce0b28a6cb6c2f639298bc1
    resource: repo://packages/contracts/test/tools.test.ts
generated: { by: "openwiki/0.7.2", at: "2026-11-06T15:32:05.739Z" }
verified:
  - by: openwiki/0.7.2
    at: 2026-11-06T15:32:05.739Z
---

# Agent workflow and harness architecture

This page owns the reference agent loop and the shared harness that makes it safe and observable. The normative product contract is the reference diagram in PRD §2.4 and the tool, skill, safety, and observability contracts in PRD §4.1–§4.4.

Detailed ownership of neighboring concerns lives in [Semantic Layer](./semantic-layer.md), [MCP Server](../integrations/mcp-server.md), [Safety and Access Control](./safety-and-access-control.md), and [Quickstart](../quickstart.md).

## 1. Ownership: agent equals model plus harness

The system is defined as `agent = model + harness`: the model proposes, the harness disposes. The model supplies language understanding, planning, SQL drafting, chart choice, and prose. The harness supplies everything that makes those outputs trustworthy:

- LangGraph workflow with typed state, branching, and bounded retries.
- Database tools over a read-only connection, exposed through MCP.
- Reusable skills, semantic index, checkpointer and memory, role-based access control plus PII policy, trace and audit log, guardrails, and eval runner.

Course rules reinforce this split: the team must build its own agent and must not wrap a hosted text-to-SQL or BI agent product; LangGraph is the recommended workflow framework; prompting alone is never accepted as a safety layer.

Package ownership is fixed: `contracts` owns shared validation shapes, `mcp-server` owns all database I/O, `access-policy` owns pure policy and redaction, `agent` owns the graph plus the shared `ValidatedQueryExecutor`, `api` owns run and thread identity plus persistence, and `web` owns the UI.

## 2. Public surface: shell marker plus state, graph, and registry

`packages/agent` exposes the shell marker plus the frozen shared modules (`packages/agent/src/constants.ts:111-112`, `packages/agent/src/index.ts:1-13`):

```ts
export const AGENT_SHELL =
  "Agent shell: LangGraph.js root graph skeleton (AGENT-01) with registry seam; services land in sibling plans";
export * from "./state.js";
export * from "./graph.js";
export * from "./subgraphs/registry.js";
```

`AGENT_SHELL` records the skeleton stage and lives in `constants.ts`, re-exported through the barrel. `AgentShellError` re-exports the contracts `DbToolError`, and the barrel comment assigns ownership: shared state, the frozen root builder with its dependency-injection point, and the registry seam are owned here, while sibling plans satisfy the `RootGraphDeps` hooks without editing `graph.ts`.

Upstream callers of the graph are the API host and scheduled triggers; downstream callees are the model through structured output and the MCP server through the MCP client. Until every UC subgraph lands, callers depend on the frozen contract shapes and the registry seam, not on UC node internals.

## 3. Implemented root graph and registry seam

The frozen root builder compiles `START -> budgetGuard -> understand -> retrieve -> router -> (ucEntry | defaultEntry) -> statusCheck -> (vizSeam -> answer | answer) -> END` (`packages/agent/src/graph.ts:107-197`). The router dispatches only to registry entries by allowlist: when `overlay.has(state.ucId)` it takes `ucEntry`, otherwise it takes `defaultEntry`. `ok` and `no_data` continue to the VIZ seam; `needs_clarification`, `restricted`, `cannot_answer`, and `error` synthesize with partial findings. A tripped `budgetGuard` short-circuits directly to `answer` so no model or MCP I/O runs after the trip.

Injection stays explicit through `RootGraphDeps` (`packages/agent/src/graph.ts:34-49`):

- `checkpointer` defaults to in-memory `MemorySaver`; the durable `PostgresSaver` is injected by the host and never falls back silently.
- `retrieve` defaults to a no-op; the executor describe path is injected.
- `ucHandlers` merges over the registry table at build time and never edits `graph.ts`.
- `viz` defaults to a no-op; the VIZ owner injects the renderer.
- `synthesize` defaults to keep-or-derive; the model factory injects the zero-tools writer.
- `emitSpan` defaults to a no-op sink; the tracer wires the redacted writer.
- `textToSql` carries the intent/SQL model plus executor seams; production uses real models, tests inject fakes.

The registry is the sole file the frozen builder reads for UC wiring (`packages/agent/src/subgraphs/registry.ts:18-46`). `registerUC`, `getUcEntry`, `isKnownUc`, and `listUcIds` manage the table, `DEFAULT_ROUTE_ID` is `tracer`, and the build fails when no default route is present (`packages/agent/src/graph.ts:92-96`). The per-graph text-to-SQL entry always overwrites the import-time registry entry so production transport and trace dependencies come from run time (`packages/agent/src/graph.ts:89-91`). Transport identity comes from `RunnableConfig.configurable` populated by the host, never from prompt text; the tracer default entry fails closed when any of `mcpUrl`, `token`, `runId`, `userId`, `roleScope`, `threadId`, or `tracesDir` is missing (`packages/agent/src/subgraphs/registry.ts:65-89`).

The tracer default route preserves the demo chain — propose SQL, `list_tables`, `run_query` capped to the preview limit, deterministic answer — writing the same span events so the demo path keeps passing while real subgraphs land (`packages/agent/src/subgraphs/registry.ts:99-197`). `runTracerGraph` builds the frozen root and invokes it on the demo question with per-call run identity headers (`packages/agent/src/graph.ts:220-267`).

```mermaid
flowchart TD
  A["Budget guard"] --> B["Understand"] --> C["Retrieve"] --> D["Router"] --> E["UC entry or default entry"] --> F["Status check"] --> G["VIZ seam or answer"]
```

*Caption: Implemented root request flow from budget governance through routed entry to gated synthesis.*

## 4. State, budgets, and memory ports

Shared root state is plain JSON only: no pool, class instance, function, or `pg` import may enter the schema because checkpoint payloads serialize verbatim into `PostgresSaver` rows (`packages/agent/src/state.ts:12-17`). Checkpointed preview rows are capped at `RESULT_PREVIEW_MAX = 50`; the full up-to-1000-row buffer lives in transient RAM outside state (`packages/agent/src/state.ts:15-16`).

Run-level budgets default to 20 LLM calls, 60000 tokens, and a 120000 ms creation window (`packages/agent/src/constants.ts:11-19`). `AgentStateSchema` carries question, `ucId`, structured intent with metric, dimensions, filters, time range, requested metrics, schema entities, and query mode, semantic chunks, capped `resultPreview`, columns, SQL, tables used, tools called, answer status defaulting to `no_data`, answer text, additive budget and telemetry reducers, run and thread identity, nullable VIZ spec, and nullable pending clarification (`packages/agent/src/state.ts:91-141`). Budget and telemetry use `ReducedValue` reducers so concurrent node writes add counters instead of overwriting limits and deadlines.

Runtime wiring is injected ports, not owned tables. `RootRuntime` hands every implementation a span sink plus the LangGraph runnable config; `RetrieveFn`, `UcEntryHandler`, `VizFn`, and `SynthesizeFn` share one `(state, runtime)` signature, and `SpanEvent` plus `SpanEmitter` standardize node, type, duration, payload, parent span, and attempt (`packages/agent/src/state.ts:152-185`).

The text-to-SQL path bridges state and executor budgets: `guardTextToSqlBudget` seeds one persistent absolute deadline on entry and stops before any I/O when already tripped, while generic UCs get an inline llm-calls, tokens, and deadline trip check in `budgetGuard` (`packages/agent/src/subgraphs/textToSql.ts:50-71`, `packages/agent/src/graph.ts:113-131`). The entry then copies the live counters into an executor-local `BudgetState`, runs, and writes back only the deltas so the root reducer stays additive (`packages/agent/src/subgraphs/textToSql.ts:359-390`).

Durable memory is built by the host through `createCheckpointer`, which takes only a connection string, pins the schema to `langgraph`, runs `setup()` exactly once so the four checkpoint tables exist before first invoke, and throws at factory time on unreachable hosts, bad credentials, or missing schema rights — never catching and continuing to `MemorySaver` (`packages/agent/src/ports/checkpoints.ts:42-72`). The factory rejects the read-only `agent_ro` URL before touching the network because checkpoints require the `harness_state` owner (`packages/agent/src/ports/checkpoints.ts:80-93`).

Human-in-the-loop state rides the same checkpointer. `pendingClarification` carries the offered options for `needs_clarification`; `requestClarification` requires a non-empty reason and at least one option, `makeThreadId` builds `chat:{userId}:{sessionId}` fail-closed on empty parts or over-length ids, `isSameThread` gates resume to the same thread, and `pauseForApproval` plus `resumeDecision` wrap LangGraph `interrupt` and `Command({ resume })` so approval suspends inside the node and resumes only on the same thread id (`packages/agent/src/hitl.ts:16-92`, `packages/agent/src/state.ts:140-141`).

## 5. Shared execution primitive: ValidatedQueryExecutor and safety gate

Every agent SQL query uses the same primitive: selective describe, generation, local pre-check, `explain_query`, `run_query`, then bounded repair (`packages/agent/src/queryExecutor/executor.ts:1-10`). The model seam is a narrow structured-output interface returning `SqlProposal` with SQL plus tables used, and the MCP seam is one `call(tool, args)` method that throws `DbToolError` on tool failure with per-call run identity inside args (`packages/agent/src/queryExecutor/executor.ts:42-71`).

Total attempts are hard-capped at `MAX_ATTEMPTS = 3`, and a `TIMEOUT` retry tightens to `TIMEOUT_RETRY_LIMIT = 50` rows after dropping the `ORDER BY` tail, always re-passing the local gates before any MCP call (`packages/agent/src/constants.ts:21-25`, `packages/agent/src/queryExecutor/executor.ts:235-241`). The safety-gate cap for non-aggregate detail queries is `DETAIL_QUERY_LIMIT = 200` (`packages/agent/src/constants.ts:27-28`).

Order inside the executor is selective `describe_table` for candidate tables only, structured SQL proposal, local `sqlGuard` plus `LocalQuerySafetyGate`, `explain_query` and `run_query`, then the repair loop with one `TIMEOUT` simplification and a single-pass zero-row diagnostic (`packages/agent/src/queryExecutor/executor.ts:313-358`, `packages/agent/src/queryExecutor/executor.ts:421-582`). Describe failures return immediately because the catalog they would build is the repair loop ground truth. Unknown MCP failure shapes fail closed as non-repairable `INTERNAL_ERROR`; the server `cursorPosition` is preserved so repair feedback can point at it (`packages/agent/src/queryExecutor/executor.ts:192-224`). Policy-restricted codes (`SCOPE_DENIED`, `SENSITIVE_COLUMN_DENIED`, `FORBIDDEN_STATEMENT`, `FORBIDDEN_FUNCTION`, `UNAUTHORIZED`) map to `restricted`; everything else maps to `error` (`packages/agent/src/queryExecutor/executor.ts:173-185`). The zero-row path issues at most one capped `sample_rows` probe on attempt 1 with filters present before concluding `no_data` (`packages/agent/src/queryExecutor/executor.ts:584-619`, `packages/agent/src/queryExecutor/executor.ts:693-736`).

The agent-side gate runs after `sqlGuard` and before any MCP call: server-side access policy remains authoritative (`packages/agent/src/queryExecutor/safetyGate.ts:1-7`). It denies any catalog-marked sensitive column referenced in any clause, denies `JoinExpr` nodes with no `ON` or `USING` condition and comma-separated `FROM` lists as implicit cross joins, and routes large-table scans to clarification (`packages/agent/src/queryExecutor/safetyGate.ts:57-112`). Non-aggregate queries that pass get a top-level `LIMIT` clamp; aggregates pass through untouched (`packages/agent/src/queryExecutor/safetyGate.ts:220-224`).

The first real UC overlay is text-to-SQL. Its `understand` node loads the `text-to-sql` skill contract and proposes a serializable intent with one budgeted LLM call; its entry handles `definition_lookup` from retrieved chunks with no executor or MCP, short-circuits unknown requested metrics before any MCP, normalizes schema entities to bare table names, and maps every executor outcome onto `AgentState` with the preview capped to 50 rows (`packages/agent/src/subgraphs/textToSql.ts:277-398`). Production MCP calls strip identity from tool args and send it as transport headers; fakes keep observing it inside args (`packages/agent/src/subgraphs/textToSql.ts:115-134`).

## 6. Shared frozen contracts

Contracts evolve additive-only after the freeze: adding optional fields, schemas, or widening enum members needs one code-owner review, while removing or renaming fields, tightening types, changing enum members, or changing error codes needs a `CONTRACTS_VERSION` major bump plus approval from every affected UC owner (`packages/contracts/README.md:8-19`). The single version constant is `CONTRACTS_VERSION = "1.1.0"` (`packages/contracts/src/constants.ts:1`, `packages/contracts/src/index.ts:13`). Version 1.1.0 is the additive precedent: `RunQueryOutputSchema` gains optional `rowScopeApplied` carrying the server-minted row-scope record (strict table plus column, column names only), with pre-1.1.0 payloads still parsing via default (`packages/contracts/README.md:21-28`). All fields are canonical `camelCase`; snake-case variants are not added and consumers map them at their own boundary (`packages/contracts/README.md:30-36`).

Errors are 12 frozen codes. Only `TIMEOUT`, `RATE_LIMITED`, and `INTERNAL_ERROR` are retryable; only `INVALID_SQL`, `UNKNOWN_TABLE`, and `SQL_EXECUTION_ERROR` are repairable, computed by `dbToolError()` from `RETRYABLE_CODES` and `REPAIRABLE_CODES` with an optional non-negative `cursorPosition` (`packages/contracts/src/constants.ts:8-33`, `packages/contracts/src/errors.ts:26-38`). Routing is transport retry with backoff for transient codes with one `TIMEOUT` simplification rewrite, bounded repair with sanitized code plus cursor for SQL diagnostics (at most 3 attempts), and immediate hard abort on attempt 1 for hard security and policy codes (`packages/contracts/README.md:54-64`).

`SQLAnswer` carries structured intent with metric, dimensions, filters, and time range, nullable SQL, tables used, citations defaulting to empty, attempts capped at 3, result preview capped at 50 rows, non-empty answer text, a seven-value status enum (`ok`, `no_data`, `cannot_answer`, `needs_clarification`, `restricted`, `error`, `false_premise`), and telemetry with prompt, completion, and embedding tokens plus cost and latency. The schema test rejects a fourth attempt and a 51-row preview. The `AgentResponse` union adds `insight_report`, `analysis_plan`, `root_cause`, and `anomaly_alert` envelope variants around the same status core.

Frozen tool schemas keep scope filtering server-side (`ListTablesInputSchema` is a strict empty object, so clients cannot claim scope), keep per-column `sensitive` flags on describe output, cap `run_query` with `maxRows` 1–1000 (default 200) plus `maskedColumns` and server-minted `rowScopeApplied` reporting (column names only), and cap `sample_rows` at `n <= 5` (default 5).

Trace identity is `runId`, `threadId`, `userId`, `role`, node, type, timestamp, and duration, with optional `spanId`, `parentSpanId`, and `attempt` so older writers stay valid. The schema test rejects an empty run ID. Trace and audit sinks must remain redacted of raw PII values.

## 7. Boundaries, identity, trace, and skills

Import boundaries make bypass structurally harder. ESLint forbids `pg`, `pg-cursor`, and MCP server internals in `packages/agent`, `packages/access-policy`, and `apps/api` (with only the `apps/api` store DAO and its test excepted because that DAO legitimately owns `pg`), forcing all database access through the MCP client. The web UI carries the driver ban plus the MCP server ban plus a contracts-only workspace rule, so it imports shared types from `@shared/contracts` only.

Per-call MCP identity travels as headers, not tool arguments: the long-lived client forks `Authorization Bearer` plus `X-Run-Id`, `X-User-Id`, and `X-Role-Scope` from `RunnableConfig.configurable` through a hook, so prompt-injected headers can never reach the transport (`packages/agent/src/mcpClient.ts:1-10`, `packages/agent/src/mcpClient.ts:73-100`).

Every span is stamped with a random UUID and delegated to the redacted trace writer; payloads carry counts and column names only, never cell values. `appendTraceEvent` redacts row payloads, validates against `TraceEventSchema`, scans the serialized line for residual PII, appends one JSON line per event under `traces/<runId>.jsonl`, and returns the span ID plus file and redaction flag (`packages/agent/src/traces/writer.ts:73-87`). `writeTraceEvent` keeps the graph and tracer call sites on the same redacted path (`packages/agent/src/traces/writer.ts:94-99`).

Skills stay declarative Markdown contracts validated against canonical sections, loaded at node entry and emitted as `skill_call` spans with no runnable scripts, database connections, or credentials.

## 8. Extension seams and failure behavior

Planned extension seams, with the contract and policy seams already usable:

- Add a new skill directory following the skill contract without changing the core loop.
- Add a corpus document type or metric alias and reindex only the changed chunk.
- Add a new UC handler through `registerUC` without editing the frozen root builder.
- Add a new role scope or sensitive column in the policy file; the rewrite and masking layers pick it up without prompt changes.
- Add a cheaper-alternative strategy to the approval gate or a new chart type behind `render_chart` validation.
- Add an additive contract field or schema with one owner review; breaking changes need a version bump and all affected owners.

Characteristic failures the harness is designed to contain: fan-out double counting on multi-row joins, wrong metric definitions, PII leakage, runaway cartesian queries, hallucinated numbers for unanswerable questions, and injected instructions in data. The corresponding mitigations are canonical join rules with pre-aggregation, semantic citations, code-enforced RBAC and masking, `EXPLAIN` gating with timeouts, `cannot_answer` with explicit missing-table reasons, and treating retrieved rows as data.

## 9. Focused tests

Representative focused tests pin each seam without live credentials:

- Root graph seam and allowlist routing with injected doubles (`packages/agent/test/graph.test.ts:32-95`).
- Executor core path with canned proposals and a stub MCP caller (`packages/agent/test/executor.test.ts:1-80`).
- Local safety-gate matrix for sensitive columns, aggregates, and joins (`packages/agent/test/safetyGate.test.ts:83-100`).
- Twelve-code error surface and retryability (`packages/contracts/test/errors.test.ts:34-36`).
- Answer attempt and preview bounds plus trace identity rejection.
- Checkpointer factory fail-fast and `agent_ro` rejection (`packages/agent/test/ports.test.ts`).
- HITL interrupt plus resume on `MemorySaver` without re-running completed work (`packages/agent/test/resume.test.ts:85-118`).
