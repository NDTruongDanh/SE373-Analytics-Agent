// Persona mapping plus run identity (API-01, 01-14, wave 6).
//
// Loads the D-11 role→scope map from policies/mcp_clients.yaml (parsed with
// the yaml package, validated by a local structural checker — zod does not
// resolve from apps/api under pnpm isolation, so the check below enforces
// the same fail-fast shape the 01-09 eval runner uses), maps the four UI
// personas from architecture section 3.2 through a static persona→client
// table, and mints D-13 run context (node:crypto randomUUID only).
//
// Security properties (T-01-14-01): unknown personas fail closed with a
// 400-class error (never a default role, never admin); scopes and rowScope
// come only from the server-side yaml map, never from request input; every
// tokenEnv named by the map must be present at boot, otherwise this module
// throws before the host listens. The returned principal stays structurally
// compatible with the 01-12 RunIdentity input ({token, runId, userId,
// roleScope}) the host forwards into RunnableConfig.configurable.
//
// Thread ids follow the 01-12 hitl shape (chat:{userId}:{sessionId}, under
// 255 chars) but are implemented here, not imported: thread helpers live in
// the agent package behind barrel/subpath exports this plan does not extend.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

/** Row-scope predicate: a single column equality enforced server-side. */
export interface RowScope {
  column: string;
  value: string;
}

/** One validated client entry from policies/mcp_clients.yaml. */
export interface McpClientEntry {
  clientId: string;
  role: string;
  tokenEnv: string;
  scopes: string[];
  rowScope?: RowScope;
}

/** Validated client registry (D-11, version 1). */
export interface ClientRegistry {
  version: number;
  clients: McpClientEntry[];
}

/** Static UI-persona → registry-client table (architecture section 3.2).
 * sales_south is the demo/compat alias for the Regional Manager South seat.
 */
export const PERSONA_TO_CLIENT: Record<string, string> = {
  sales_south: "sales_south",
  regional_manager_south: "sales_south",
  marketing: "marketing",
  hr: "hr",
  data_admin: "admin",
};

/** Principal resolved server-side for one ask. Scopes never come from input. */
export interface Principal {
  userId: string;
  role: string;
  scopes: string[];
  rowScope?: RowScope;
}

/** 400-class failure: unknown persona. Never a default role, never admin. */
export class UnknownPersonaError extends Error {
  readonly status = 400;
  readonly code = "INVALID_PARAMS";
  constructor(persona: string) {
    super(
      `unknown persona '${persona}'; expected one of ${Object.keys(PERSONA_TO_CLIENT).join(", ")}`,
    );
    this.name = "UnknownPersonaError";
  }
}

/** 400-class failure: malformed or overlong client-supplied threadId. */
export class InvalidThreadError extends Error {
  readonly status = 400;
  readonly code = "INVALID_PARAMS";
  constructor(threadId: string) {
    super(
      `invalid threadId '${threadId}'; expected chat:{userId}:{sessionId} under ${THREAD_ID_MAX_LENGTH} chars`,
    );
    this.name = "InvalidThreadError";
  }
}

/** Upper bound for thread ids (matches the 01-12 HITL limit). */
export const THREAD_ID_MAX_LENGTH = 255;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(shape: string): never {
  throw new Error(
    `principals: malformed mcp_clients.yaml (expected ${shape}); refusing to boot with an untrusted role map.`,
  );
}

/**
 * Structural validation of the parsed yaml (same fail-fast shape a zod
 * schema would enforce; see module note on pnpm isolation). Throws on any
 * bad shape so the host fails fast at boot, never with partial scopes.
 */
export function parseClientRegistry(raw: unknown): ClientRegistry {
  if (!isRecord(raw)) fail("a mapping with version and clients");
  if (raw["version"] !== 1) fail("version: 1");
  if (!Array.isArray(raw["clients"]) || raw["clients"].length === 0) {
    fail("a non-empty clients list");
  }
  const clients: McpClientEntry[] = (raw["clients"] as unknown[]).map(
    (entry, index) => {
      if (!isRecord(entry)) fail(`clients[${index}] to be a mapping`);
      const { clientId, role, tokenEnv, scopes, rowScope } = entry;
      if (typeof clientId !== "string" || clientId.length === 0) {
        fail(`clients[${index}].clientId to be a non-empty string`);
      }
      if (typeof role !== "string" || role.length === 0) {
        fail(`clients[${index}].role to be a non-empty string`);
      }
      if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
        fail(`clients[${index}].tokenEnv to be a non-empty string`);
      }
      if (
        !Array.isArray(scopes) ||
        scopes.length === 0 ||
        !scopes.every((s): s is string => typeof s === "string" && s.length > 0)
      ) {
        fail(`clients[${index}].scopes to be a non-empty string list`);
      }
      let parsedScope: RowScope | undefined;
      if (rowScope !== undefined) {
        if (!isRecord(rowScope)) fail(`clients[${index}].rowScope to be a mapping`);
        if (
          typeof rowScope["column"] !== "string" ||
          rowScope["column"].length === 0 ||
          typeof rowScope["value"] !== "string" ||
          rowScope["value"].length === 0
        ) {
          fail(`clients[${index}].rowScope to carry column and value strings`);
        }
        parsedScope = {
          column: rowScope["column"] as string,
          value: rowScope["value"] as string,
        };
      }
      return {
        clientId: clientId as string,
        role: role as string,
        tokenEnv: tokenEnv as string,
        scopes: [...(scopes as string[])],
        ...(parsedScope ? { rowScope: parsedScope } : {}),
      };
    },
  );
  const ids = new Set(clients.map((c) => c.clientId));
  if (ids.size !== clients.length) fail("unique clientId values");
  return { version: 1, clients };
}

/** Default registry path: <repo>/policies/mcp_clients.yaml from this file. */
export function defaultRegistryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "policies", "mcp_clients.yaml");
}

/** Read, parse, and validate the registry file. Throws fail-fast on any fault. */
export function loadRegistryFromFile(filePath: string = defaultRegistryPath()): ClientRegistry {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `principals: cannot read client registry at ${filePath}: ${(error as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(
      `principals: client registry at ${filePath} is not valid YAML: ${(error as Error).message}`,
    );
  }
  return parseClientRegistry(raw);
}

/**
 * Boot check: every tokenEnv named by the registry must resolve to a
 * non-empty value in env. Throws listing the missing names (no values).
 */
export function assertTokensPresent(
  registry: ClientRegistry,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const missing = registry.clients
    .map((c) => c.tokenEnv)
    .filter((name) => typeof env[name] !== "string" || (env[name] as string).length === 0);
  if (missing.length > 0) {
    throw new Error(
      `principals: missing bearer-token env vars for [${missing.join(", ")}]; refusing to boot without per-role tokens.`,
    );
  }
}

/**
 * Resolve a UI persona to its server-side principal plus bearer token.
 * Unknown personas throw UnknownPersonaError (400-class, fail-closed).
 */
export function resolvePersona(
  persona: string,
  registry: ClientRegistry,
  env: NodeJS.ProcessEnv = process.env,
): { principal: Principal; token: string } {
  const clientId = PERSONA_TO_CLIENT[persona];
  if (!clientId) {
    throw new UnknownPersonaError(persona);
  }
  const entry = registry.clients.find((c) => c.clientId === clientId);
  if (!entry) {
    throw new Error(
      `principals: persona '${persona}' maps to unknown client '${clientId}' in the loaded registry.`,
    );
  }
  const token = env[entry.tokenEnv];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `principals: token env ${entry.tokenEnv} is not set; refusing to serve persona '${persona}' without its bearer token.`,
    );
  }
  return {
    principal: {
      userId: entry.clientId,
      role: entry.role,
      scopes: [...entry.scopes],
      ...(entry.rowScope ? { rowScope: { ...entry.rowScope } } : {}),
    },
    token,
  };
}

/** Minted run identity propagated as X-Run-Id plus RunnableConfig. */
export interface RunContext {
  runId: string;
  threadId: string;
}

/**
 * Validate a client-supplied threadId against the chat:{userId}:{sessionId}
 * shape (under 255 chars). Returns false for any deviation — the caller
 * mints instead of coercing.
 */
export function isValidThreadId(threadId: string, userId: string): boolean {
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    threadId.length >= THREAD_ID_MAX_LENGTH ||
    /\s/.test(threadId)
  ) {
    return false;
  }
  const parts = threadId.split(":");
  return parts.length >= 3 && parts[0] === "chat" && parts[1] === userId && parts[2].length > 0;
}

/**
 * Mint run context per D-13: a fresh randomUUID runId on every ask, and a
 * threadId that is either the validated client-supplied chat:{userId}:{...}
 * value or minted as chat:{userId}:{runId}.
 */
export function mintRunContext(userId: string, threadId?: string): RunContext {
  if (!userId) {
    throw new Error("principals: mintRunContext requires a non-empty userId.");
  }
  const runId = randomUUID();
  if (threadId !== undefined && !isValidThreadId(threadId, userId)) {
    throw new InvalidThreadError(threadId);
  }
  return { runId, threadId: threadId ?? `chat:${userId}:${runId}` };
}
