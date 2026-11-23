import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  PERSONA_TO_CLIENT,
  THREAD_ID_MAX_LENGTH,
} from "./constants.js";

export { PERSONA_TO_CLIENT, THREAD_ID_MAX_LENGTH };

export interface RowScope {
  column: string;
  value: string;
}

export interface McpClientEntry {
  clientId: string;
  role: string;
  tokenEnv: string;
  scopes: string[];
  rowScope?: RowScope;
}

export interface ClientRegistry {
  version: number;
  clients: McpClientEntry[];
}

export interface Principal {
  userId: string;
  role: string;
  scopes: string[];
  rowScope?: RowScope;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(shape: string): never {
  throw new Error(
    `principals: malformed mcp_clients.yaml (expected ${shape}); refusing to boot with an untrusted role map.`,
  );
}

// Validate structurally instead of using zod because zod does not resolve from apps/api under pnpm isolation.
export function parseClientRegistry(raw: unknown): ClientRegistry {
  if (!isRecord(raw)) fail("a mapping with version and clients");
  if (raw["version"] !== 1) fail("version: 1");
  if (!Array.isArray(raw["clients"]) || raw["clients"].length === 0) {
    fail("a non-empty clients list");
  }
  const entries = raw["clients"] as unknown[];
  // Check uniqueness across eval-only entries too since the gateway loads both sets when MCP_ENABLE_EVAL_CLIENTS=1.
  const allIds: string[] = [];
  const clients: McpClientEntry[] = entries.flatMap((entry, index) => {
    if (!isRecord(entry)) fail(`clients[${index}] to be a mapping`);
    const { clientId, role, tokenEnv, scopes, rowScope, evalOnly } = entry;
    if (evalOnly !== undefined && typeof evalOnly !== "boolean") {
      fail(`clients[${index}].evalOnly to be a boolean`);
    }
    if (typeof clientId !== "string" || clientId.length === 0) {
      fail(`clients[${index}].clientId to be a non-empty string`);
    }
    allIds.push(clientId as string);
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
    // Validate eval-only clients for uniqueness, then drop them so no persona maps to them or requires their tokens.
    if (evalOnly === true) return [];
    return [
      {
        clientId: clientId as string,
        role: role as string,
        tokenEnv: tokenEnv as string,
        scopes: [...(scopes as string[])],
        ...(parsedScope ? { rowScope: parsedScope } : {}),
      },
    ];
  });
  if (new Set(allIds).size !== allIds.length) fail("unique clientId values");
  return { version: 1, clients };
}

export function defaultRegistryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "policies", "mcp_clients.yaml");
}

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

export interface RunContext {
  runId: string;
  threadId: string;
}

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
