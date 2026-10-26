import { timingSafeEqual } from "node:crypto";
import { dbToolError, type DbToolError } from "@se373/contracts";

// TRACER static auth (T-01-03): a single shared Bearer token from
// MCP_TRACER_TOKEN plus a fixed demo principal. Server-side scopes only —
// client X-Role-Scope claims are recorded in audit, never trusted.
// policies/mcp_clients.yaml replaces this in 01-08.

export const TRACER_SCOPES = ["schema:read", "data:read"] as const;
export type TracerScope = (typeof TRACER_SCOPES)[number];

export interface TracerPrincipal {
  clientId: "tracer-demo";
  userId: string;
  role: "sales_south";
  scopes: TracerScope[];
}

export type AuthResult =
  | { principal: TracerPrincipal }
  | { error: DbToolError };

function tokenMatches(configured: string, presented: string): boolean {
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function firstHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Verify the Bearer token and build the fixed demo principal. */
export function authenticateRequest(
  headers: Record<string, string | string[] | undefined>,
): AuthResult {
  const configured = process.env.MCP_TRACER_TOKEN;
  if (!configured) {
    return {
      error: dbToolError(
        "UNAUTHORIZED",
        "server misconfigured: MCP_TRACER_TOKEN is not set",
      ),
    };
  }
  const presented = firstHeader(headers["authorization"]) ?? "";
  const match = /^Bearer (.+)$/.exec(presented.trim());
  if (!match || !tokenMatches(configured, match[1])) {
    return { error: dbToolError("UNAUTHORIZED", "missing or invalid Bearer token") };
  }
  return {
    principal: {
      clientId: "tracer-demo",
      userId: firstHeader(headers["x-user-id"]) || "demo-user",
      role: "sales_south",
      scopes: [...TRACER_SCOPES],
    },
  };
}

/** Server-side scope gate (D-03: run_query requires data:read). */
export function requireScope(
  principal: TracerPrincipal,
  scope: TracerScope,
): DbToolError | null {
  if (principal.scopes.includes(scope)) return null;
  return dbToolError("SCOPE_DENIED", `scope '${scope}' is required`);
}

export interface RunContext {
  runId: string;
  userId: string;
  roleScope: string;
}

/** Per-call run identity from headers (transport, never proof). */
export function readRunContext(
  headers: Record<string, string | string[] | undefined>,
  principal: TracerPrincipal,
): RunContext {
  return {
    runId: firstHeader(headers["x-run-id"]) || "unknown",
    userId: principal.userId,
    roleScope: firstHeader(headers["x-role-scope"]) || "",
  };
}
