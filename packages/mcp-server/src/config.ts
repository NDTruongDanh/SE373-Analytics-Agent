// Gateway config loader (MCP-04): strict zod schemas for
// policies/mcp_clients.yaml plus the sensitive-columns file, parsed with the
// `yaml` package. Any violation — malformed YAML, wrong version, empty
// clients, unknown scopes, extra keys, missing token env — throws, so bad
// config means no boot (fail-closed). Tokens are resolved from process.env
// at boot and never logged.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  loadSensitiveColumns as loadAccessPolicySensitiveColumns,
  type SensitiveColumns,
} from "@shared/access-policy";

const ScopeSchema = z.enum(["schema:read", "data:read", "data:sensitive"]);

export type McpScope = z.infer<typeof ScopeSchema>;

const RowScopeSchema = z.strictObject({
  column: z.string().min(1),
  value: z.string().min(1),
});

export type McpRowScope = z.infer<typeof RowScopeSchema>;

const McpClientSchema = z.strictObject({
  clientId: z.string().min(1),
  role: z.string().min(1),
  tokenEnv: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/),
  scopes: z.array(ScopeSchema).min(1),
  rowScope: RowScopeSchema.optional(),
  // Eval-only clients (issue #39) load only when EVAL_CLIENTS_ENV is "1";
  // otherwise they are dropped at boot, so their token cannot authenticate.
  evalOnly: z.boolean().optional(),
});

export type McpClient = z.infer<typeof McpClientSchema>;

export const McpClientsSchema = z
  .strictObject({
    version: z.literal(1),
    clients: z.array(McpClientSchema).min(1),
  })
  .superRefine((value, ctx) => {
    for (const key of ["clientId", "tokenEnv"] as const) {
      const seen = new Set<string>();
      value.clients.forEach((client, index) => {
        if (seen.has(client[key])) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate ${key}: ${client[key]}`,
            path: ["clients", index, key],
          });
        }
        seen.add(client[key]);
      });
    }
  });

export type McpClients = z.infer<typeof McpClientsSchema>;

export interface ResolvedClient {
  clientId: string;
  role: string;
  scopes: McpScope[];
  rowScope: McpRowScope | null;
  token: string;
}

function parseYamlText(yamlText: string, file: string): unknown {
  try {
    return parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `Invalid ${file} YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Pure loader: YAML text in, validated client map out. Throws fail-closed.
export function loadMcpClients(yamlText: string): McpClients {
  return McpClientsSchema.parse(parseYamlText(yamlText, "mcp_clients"));
}

/** Env flag that opts eval-only clients in (set by the eval runner only). */
export const EVAL_CLIENTS_ENV = "MCP_ENABLE_EVAL_CLIENTS";

// Token resolution: every loaded tokenEnv must name a non-empty env entry.
// Eval-only clients are skipped unless EVAL_CLIENTS_ENV is "1" — skipped
// means not registered at all (fail-closed: their token gets 401), never
// "registered without a token". Throws naming the variable, never its value.
export function resolveClientTokens(
  clients: McpClients,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedClient[] {
  const evalEnabled = env[EVAL_CLIENTS_ENV] === "1";
  const loaded = clients.clients.filter(
    (client) => client.evalOnly !== true || evalEnabled,
  );
  return loaded.map((client) => {
    const token = env[client.tokenEnv];
    if (!token) {
      throw new Error(
        `MCP client '${client.clientId}': environment variable ${client.tokenEnv} is not set or empty`,
      );
    }
    return {
      clientId: client.clientId,
      role: client.role,
      scopes: [...client.scopes],
      rowScope: client.rowScope ?? null,
      token,
    };
  });
}

// Sensitive-columns file through the shared access-policy loader (single
// validation authority — no second schema here). Re-exported so gateway
// callers have one config surface.
export function loadSensitiveColumns(yamlText: string): SensitiveColumns {
  return loadAccessPolicySensitiveColumns(yamlText);
}

export type { SensitiveColumns };
