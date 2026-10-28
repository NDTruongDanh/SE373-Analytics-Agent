import type { DbToolError } from "@shared/contracts";

export const ACCESS_POLICY_SHELL =
  "Access-policy shell: the AccessPolicy interface seam lands in Phase 3";

export type AccessPolicyShellError = DbToolError;

export * from "./guard.js";
export * from "./denylist.js";
// 01-06 policy stage (re-exports land here, not in a later wave, because
// mcp-server/src/errors.ts imports redactPII from this barrel and the
// task-3 typecheck gate must resolve it now).
export * from "./policy.js";
export * from "./sensitive-columns.js";
export * from "./redactor.js";
