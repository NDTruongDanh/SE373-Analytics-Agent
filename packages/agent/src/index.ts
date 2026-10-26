import type { DbToolError } from "@se373/contracts";

export const AGENT_SHELL =
  "Agent shell: full LangGraph.js graph lands in Phase 5";

export type AgentShellError = DbToolError;

// TRACER thin-slice surface. The registry seam (01-10) owns the permanent
// module layout; until then the API host imports the tracer graph here.
export * from "./graph.js";
export * from "./mcpClient.js";
export * from "./models/factory.js";
export * from "./traces/writer.js";
