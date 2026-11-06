// Shared magic-value constants (AGENT-01 governance): single source for
// literal caps, ids, markers, and schema names. No schemas, types, or
// functions live here except the SKILL_SECTIONS rule list (whose `test`
// predicates are part of the literal value). Type-only imports only.

import type { SkillSectionRule } from "./skills/loader.js";

/** Hard cap on checkpointed preview rows (T-01-10-02 mitigation). */
export const RESULT_PREVIEW_MAX = 50;

/** Run-level budget limits (D-13). D-13 locked values duplicated intentionally. */
export const BUDGET_DEFAULTS = { maxLlmCalls: 20, maxTokens: 60000, runDeadlineMs: 120000 } as const;

/** Locked D-13 run-level budget limits. */
export const BUDGET_LIMITS = {
  maxLlmCalls: 20,
  maxTokens: 60000,
  runDeadlineMs: 120000,
} as const;

/** Hard cap on total attempts including the first try (D-02). */
export const MAX_ATTEMPTS = 3;

/** Tighter cap the TIMEOUT simplification enforces on the retry. */
export const TIMEOUT_RETRY_LIMIT = 50;

/** Cap applied to non-aggregate detail queries (GUARD-03). */
export const DETAIL_QUERY_LIMIT = 200;

/** Stable registry key for the text-to-SQL entry. */
export const TEXT_TO_SQL_UC_ID = "text-to-sql";

/** Stable registry key for the RCA entry (UC-05). */
export const RCA_UC_ID = "root-cause-analysis";

// Default route id. Unknown ucIds fall through to this entry.
export const DEFAULT_ROUTE_ID = "tracer";

/** Thread ids must stay well under the Postgres text limit. */
export const THREAD_ID_MAX_LENGTH = 255;

/** Server key under which the single gateway connection is registered. */
export const MCP_SERVER_NAME = "mcp";

// Legacy tracer-compatible surface, consumed by the 01-10 default route
// (subgraphs/registry.ts) and tracer.test.ts until 01-14 replaces the demo.
export const TRACER_DEMO_QUESTION = "How many orders do we have per status?";

export const TRACER_SQL_PROPOSAL = {
  sql: "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status",
  tablesUsed: ["orders"],
};

/**
 * Documented default model id when neither AGENT_MODEL_ID nor the
 * per-profile AGENT_MODEL_ID_<PROFILE> override is set.
 */
export const DEFAULT_MODEL_ID = "agent-default";

/** Delimiter tags marking query rows as untrusted data (never instructions). */
export const UNTRUSTED_DATA_OPEN = "<untrusted_data>";
export const UNTRUSTED_DATA_CLOSE = "</untrusted_data>";

/**
 * Canonical D-14 section list. Each rule must match at least one ATX
 * heading (case-insensitive); labels match the skills-check gate.
 */
export const SKILL_SECTIONS: SkillSectionRule[] = [
  {
    id: "name",
    label: "name/metadata",
    test: (h) => /skill\s*name|^name\b|metadata/.test(h),
  },
  {
    id: "description",
    label: "description",
    test: (h) => /description/.test(h),
  },
  {
    id: "triggers",
    label: "when-to-use/triggers",
    test: (h) => /when to use|trigger/.test(h),
  },
  {
    id: "io",
    label: "inputs/outputs",
    test: (h) => /input/.test(h) && /output/.test(h),
  },
  {
    id: "steps",
    label: "steps",
    test: (h) => /\bsteps?\b/.test(h),
  },
  {
    id: "guardrails",
    label: "constraints/guardrails",
    test: (h) => /constraint|guardrail/.test(h),
  },
  {
    id: "examples",
    label: "examples",
    test: (h) => /example/.test(h),
  },
  {
    id: "final-check",
    label: "final-check",
    test: (h) => /final check/.test(h),
  },
];

/** Postgres schema that PostgresSaver.setup() owns (harness_state). */
export const CHECKPOINT_SCHEMA = "langgraph" as const;

export const AGENT_SHELL =
  "Agent shell: LangGraph.js root graph skeleton (AGENT-01) with registry seam; services land in sibling plans";
