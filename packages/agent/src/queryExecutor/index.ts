// Query-executor public surface (G-01): explicit named re-exports so the
// eval safety driver can drive the REAL ValidatedQueryExecutor plus the
// LocalQuerySafetyGate without importing agent internals by relative path.
// No new runtime surface for the graph — additive exports only.
export {
  ValidatedQueryExecutor,
  simplifyForTimeout,
  SqlProposalSchema,
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
  MAX_ATTEMPTS,
  TIMEOUT_RETRY_LIMIT,
} from "../constants.js";
export {
  localQuerySafetyGate,
  clampLimit,
  hasWhereFilter,
  type SafetyGateResult,
} from "./safetyGate.js";
export { DETAIL_QUERY_LIMIT } from "../constants.js";
