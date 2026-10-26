// Query-executor public surface (G-01): explicit named re-exports so the
// eval safety driver can drive the REAL ValidatedQueryExecutor plus the
// LocalQuerySafetyGate without importing agent internals by relative path.
// No new runtime surface for the graph — additive exports only.
export {
  ValidatedQueryExecutor,
  simplifyForTimeout,
  SqlProposalSchema,
  MAX_ATTEMPTS,
  TIMEOUT_RETRY_LIMIT,
  type ChatModelLike,
  type McpToolCaller,
  type ExecutorDeps,
  type ExecutorPrincipal,
  type ExecutorResult,
  type ExecutorRunInput,
  type ExecutorSpan,
  type SqlProposal,
} from "./executor.js";
export {
  localQuerySafetyGate,
  clampLimit,
  hasWhereFilter,
  DETAIL_QUERY_LIMIT,
  type SafetyGateResult,
} from "./safetyGate.js";
