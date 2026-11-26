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
  // Eval-only clients load only when EVAL_CLIENTS_ENV === "1"; otherwise dropped at boot (fail-closed).
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

export function loadMcpClients(yamlText: string): McpClients {
  return McpClientsSchema.parse(parseYamlText(yamlText, "mcp_clients"));
}

export const EVAL_CLIENTS_ENV = "MCP_ENABLE_EVAL_CLIENTS";

// Skipped eval-only clients are not registered at all (401 on use); missing
// tokenEnv values throw naming the variable name only, never any secret.
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

export function loadSensitiveColumns(yamlText: string): SensitiveColumns {
  return loadAccessPolicySensitiveColumns(yamlText);
}

export type { SensitiveColumns };
