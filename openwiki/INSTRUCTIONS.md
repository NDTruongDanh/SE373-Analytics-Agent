# OpenWiki brief for SE373 Analytics Agent

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

Audience: teammates, course reviewers, and coding agents answering questions
about this repo. Write in English with Vietnamese business terms where the PRD
uses them. Keep Mermaid diagrams small and valid. Never invent dataset facts —
cite the loader script and schema files.
