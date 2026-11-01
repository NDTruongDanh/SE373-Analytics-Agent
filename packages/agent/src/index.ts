import type { DbToolError } from "@shared/contracts";
export { AGENT_SHELL } from "./constants.js";

export type AgentShellError = DbToolError;

// Public surface owned by 01-10: shared state, the frozen root builder with
// its deps injection point, and the registry seam. Sibling plans own their
// modules and satisfy the RootGraphDeps hooks without editing graph.ts:
// 01-11 ValidatedQueryExecutor, 01-12 models/skills/mcpClient/hitl/telemetry,
// 01-13 ports. Later-wave note: 01-14 may extend this file for host wiring.
export * from "./state.js";
export * from "./graph.js";
export * from "./subgraphs/registry.js";
