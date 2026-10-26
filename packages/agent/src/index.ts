import type { DbToolError } from "@se373/contracts";

export const AGENT_SHELL =
  "Agent shell: LangGraph.js root graph skeleton (AGENT-01) with registry seam; services land in sibling plans";

export type AgentShellError = DbToolError;

// Public surface owned by 01-10: shared state, the frozen root builder with
// its deps injection point, and the registry seam. Sibling plans own their
// modules and satisfy the RootGraphDeps hooks without editing graph.ts:
// 01-11 ValidatedQueryExecutor, 01-12 models/skills/mcpClient/hitl/telemetry,
// 01-13 ports. Later-wave note: 01-14 may extend this file for host wiring.
export * from "./state.js";
export * from "./graph.js";
export * from "./subgraphs/registry.js";
// 01-13 ports barrel: re-exported at the root so the apps/api host builds
// the PostgresSaver via the barrel (direct deep imports are blocked by the
// package exports map). Additive only; no 01-10 surface changed.
export * from "./ports/index.js";
