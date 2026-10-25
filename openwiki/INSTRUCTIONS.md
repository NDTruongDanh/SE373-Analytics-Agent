# OpenWiki brief for SE373 Analytics Agent

Audience: coding agents only. This wiki is code documentation for agents that
build, modify, and answer questions about this repo. Optimize every page for
retrieval and task execution: concrete entrypoints, commands, file paths, and
invariants — not human tutorials or product marketing.

Scope: document this repository as the course project evolves — the analytics
agent harness (LangGraph workflow, tools, semantic layer, RBAC/PII policy,
MCP server, evals) and the operator-facing software (CLI/Web/Notebook).

Priorities for generated pages:
1. Architecture (`agent = model + harness`): workflow graph, tools and their
   read-only guards, skills, semantic index, checkpointer/memory, guardrails,
   eval runner, trace/audit log — with file:line citations.
2. Database: source dataset + license, Vietnamesization steps, ER relationships,
   seeded scenarios/anomalies/injections (note they are hidden from the agent),
   one-command load (`python -m data.load` or equivalent).
3. Per-UC design for the UCs the team actually submits, including the K1–K8
   coverage table and failure-mode mitigations (fanout double-count, wrong
   metric definition, PII leak, runaway query).
4. Evals: how to run (`python -m evals.run --all`), EX definition, regression
   comparisons, safety cases (section 4.3 of docs/prd.md).

Taxonomy: organize by system and workflow (e.g. `openwiki/agent/…`,
`openwiki/data/…`, `openwiki/use-cases/…`, `openwiki/evals/…`), not by mirroring
source directories. Do not produce one page per file or a flat top-level dump.
Keep `openwiki/quickstart.md` as the task-routing map (entrypoints, one-command
setup/run, where to look next). Link conceptual and workflow neighbors via
`relatedPages`.

Per-page contract for agents: state responsibility and ownership, runtime/build
entrypoints, control/data flow, upstream/downstream callers, state/persistence
and lifecycle, invariants and failure behavior, config/security consequences
(especially read-only DB role, RBAC, PII masking, costly-query approval), and
extension seams. Cite one representative focused test per behavior page where
tests exist. Skip exhaustive symbol inventories.

Grounding (non-negotiable): never invent dataset facts, APIs, or behavior.
Ground every material claim in inspected source with `repo://` evidence and
`file:line` citations; document the loader script and schema files, never the
contents of ignored data dumps (`data/*.csv|*.parquet|*.db|*.sqlite|*.duckdb`,
see `.openwikiignore`). Never reproduce secrets (`.env`, keys) or generated
run state.

Style: English only — including for concepts sourced from
`docs/prd.md` and `docs/UC-plan/` (translate, do not keep Vietnamese terms). Retrieval-oriented `type/title/description`
and stable English `tags`. Keep Mermaid small and valid — only for request/
runtime flows, call sequences, lifecycles, or data models — with a one-line
caption below each diagram. No Mermaid on navigation, reference-table, or pure
config pages.

Out of scope: full PRD prose, course paperwork, human onboarding narratives,
BI-dashboard feature docs, ML-forecasting theory, vendored `node_modules/`
internals, and anything unreadable under `.openwikiignore`.
