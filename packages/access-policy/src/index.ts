import type { DbToolError } from "@se373/contracts";

export const ACCESS_POLICY_SHELL =
  "Access-policy shell: the AccessPolicy interface seam lands in Phase 3";

export type AccessPolicyShellError = DbToolError;

export * from "./tracerPrecheck.js";
