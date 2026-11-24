import type { SkillSectionRule } from "./skills/loader.js";

export const RESULT_PREVIEW_MAX = 50;

export const BUDGET_DEFAULTS = { maxLlmCalls: 20, maxTokens: 60000, runDeadlineMs: 120000 } as const;

export const BUDGET_LIMITS = {
  maxLlmCalls: 20,
  maxTokens: 60000,
  runDeadlineMs: 120000,
} as const;

/** Total attempts including the initial try. */
export const MAX_ATTEMPTS = 3;

export const TIMEOUT_RETRY_LIMIT = 50;

export const DETAIL_QUERY_LIMIT = 200;

// Child tables of orders: joining two at one level before SUM/AVG/COUNT repeats rows.
export const FANOUT_CHILD_TABLES: readonly string[] = ["order_items", "payments", "reviews"];

export const FANOUT_SENSITIVE_AGGREGATES: readonly string[] = ["avg", "count", "sum"];

export const TEXT_TO_SQL_UC_ID = "text-to-sql";

export const RCA_UC_ID = "root-cause-analysis";

export const DEFAULT_ROUTE_ID = "tracer";

export const THREAD_ID_MAX_LENGTH = 255;

export const MCP_SERVER_NAME = "mcp";

export const TRACER_DEMO_QUESTION = "How many orders do we have per status?";

export const TRACER_SQL_PROPOSAL = {
  sql: "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status",
  tablesUsed: ["orders"],
};

export const DEFAULT_MODEL_ID = "agent-default";

export const UNTRUSTED_DATA_OPEN = "<untrusted_data>";
export const UNTRUSTED_DATA_CLOSE = "</untrusted_data>";

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

export const CHECKPOINT_SCHEMA = "langgraph" as const;

export const NO_MATCHING_TABLE_OPTION =
  "Không có bảng phù hợp (đặt lại câu hỏi)";

export const AGENT_SHELL =
  "Agent shell: LangGraph.js root graph skeleton (AGENT-01) with registry seam; services land in sibling plans";
