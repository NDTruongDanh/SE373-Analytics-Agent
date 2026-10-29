// @shared/access-policy public barrel: pure guard, policy, and redaction
// stages consumed by mcp-server (gateway stages 4, 5, 7) and the agent-side
// pre-check. No DB or network I/O lives behind any of these exports.
export * from "./guard.js";
export * from "./denylist.js";
export * from "./policy.js";
export * from "./sensitive-columns.js";
export * from "./redactor.js";
