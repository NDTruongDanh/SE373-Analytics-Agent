// Bearer authentication (MCP-04, T-01-08-01): tokens resolve through the
// loaded policies/mcp_clients.yaml to a server-built principal. Tokens live
// in env vars named by tokenEnv, are compared in full with timingSafeEqual,
// and are never logged. Missing or bad tokens reject 401 UNAUTHORIZED.
// X-Run-Id / X-User-Id / X-Role-Scope headers are transport only (telemetry
// and run correlation) — never proof; scopes come from the yaml map alone.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { dbToolError, type DbToolError } from "@shared/contracts";
import type { Principal } from "@shared/access-policy";
import type { ResolvedClient } from "./config.js";

export interface AuthContext {
  principal: Principal;
  runId: string;
  userId: string;
  roleScope: string;
}

export type AuthResult = { auth: AuthContext } | { error: DbToolError };

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

type HeaderMap = Record<string, string | string[] | undefined>;

/** Resolve the Bearer token to a server-built principal plus run identity. */
export function authenticateRequest(
  headers: HeaderMap,
  clients: ResolvedClient[],
): AuthResult {
  const presented = firstHeader(headers["authorization"]) ?? "";
  const match = /^Bearer (.+)$/.exec(presented.trim());
  if (match) {
    const candidate = match[1] as string;
    for (const client of clients) {
      if (tokenMatches(client.token, candidate)) {
        const userId =
          firstHeader(headers["x-user-id"]) || client.clientId;
        return {
          auth: {
            principal: {
              userId,
              role: client.role,
              scopes: [...client.scopes],
              rowScope: client.rowScope ?? null,
            },
            runId: firstHeader(headers["x-run-id"]) || randomUUID(),
            userId,
            roleScope: firstHeader(headers["x-role-scope"]) || "",
          },
        };
      }
    }
  }
  return { error: dbToolError("UNAUTHORIZED", "missing or invalid Bearer token") };
}

export type ScopeName = "schema:read" | "data:read" | "data:sensitive";

/** Server-side scope gate (MCP-05): the principal's yaml scopes decide. */
export function requireScope(
  principal: Pick<Principal, "scopes">,
  scope: ScopeName,
): DbToolError | null {
  if (principal.scopes.includes(scope)) return null;
  return dbToolError("SCOPE_DENIED", `scope '${scope}' is required`);
}
