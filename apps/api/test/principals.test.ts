// Persona mapping plus run-identity legs (API-01, 01-14). DB-free per D-21:
// the registry is parsed from inline yaml text plus a stub env, never from
// live secrets or the network.

import { describe, expect, it } from "vitest";
import {
  assertTokensPresent,
  InvalidThreadError,
  isValidThreadId,
  loadRegistryFromFile,
  mintRunContext,
  PERSONA_TO_CLIENT,
  parseClientRegistry,
  resolvePersona,
  THREAD_ID_MAX_LENGTH,
  UnknownPersonaError,
  type ClientRegistry,
} from "../src/principals.js";

const REGISTRY_YAML = `
version: 1
clients:
  - clientId: sales_south
    role: sales_south
    tokenEnv: MCP_TOKEN_SALES_SOUTH
    scopes: [schema:read, data:read]
    rowScope: { column: region_group, value: Nam }
  - clientId: marketing
    role: marketing
    tokenEnv: MCP_TOKEN_MARKETING
    scopes: [schema:read, data:read]
  - clientId: hr
    role: hr
    tokenEnv: MCP_TOKEN_HR
    scopes: [schema:read, data:read, data:sensitive]
  - clientId: admin
    role: admin
    tokenEnv: MCP_TOKEN_ADMIN
    scopes: [schema:read, data:read, data:sensitive]
`;

// Minimal YAML-subset parser for the fixture shape above (key: value pairs,
// nested lists/maps by indentation). Keeps this suite DB-free and
// dependency-free; the source module parses with the real yaml package.
function fixtureRegistry(): ClientRegistry {
  const lines = REGISTRY_YAML.split("\n");
  const clients: ClientRegistry["clients"] = [];
  let current: Record<string, unknown> | null = null;
  for (const line of lines) {
    const clientMatch = /^\s*-\s*clientId:\s*(\S+)/.exec(line);
    if (clientMatch) {
      current = { clientId: clientMatch[1] };
      clients.push(current as unknown as ClientRegistry["clients"][number]);
      continue;
    }
    if (!current) continue;
    const kv = /^\s*([A-Za-z]+):\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (key === "scopes") {
      current[key] = raw.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
    } else if (key === "rowScope") {
      const column = /column:\s*([^,}]+)/.exec(raw)?.[1].trim() ?? "";
      const value = /value:\s*([^,}]+)/.exec(raw)?.[1].trim() ?? "";
      current[key] = { column, value };
    } else {
      current[key] = raw;
    }
  }
  return parseClientRegistry({ version: 1, clients });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stubEnv(): NodeJS.ProcessEnv {
  return {
    MCP_TOKEN_SALES_SOUTH: "stub-sales",
    MCP_TOKEN_MARKETING: "stub-marketing",
    MCP_TOKEN_HR: "stub-hr",
    MCP_TOKEN_ADMIN: "stub-admin",
    MCP_TOKEN_EVAL_SCOPE: "stub-eval-scope",
  } as NodeJS.ProcessEnv;
}

describe("persona to principal mapping (D-11)", () => {
  it("resolves all four UI personas to their yaml scopes and rowScopes", () => {
    const registry = fixtureRegistry();
    const south = resolvePersona("regional_manager_south", registry, stubEnv());
    expect(south.principal).toMatchObject({
      role: "sales_south",
      scopes: ["schema:read", "data:read"],
      rowScope: { column: "region_group", value: "Nam" },
    });
    expect(south.token).toBe("stub-sales");

    const marketing = resolvePersona("marketing", registry, stubEnv());
    expect(marketing.principal.scopes).toEqual(["schema:read", "data:read"]);
    expect(marketing.principal.rowScope).toBeUndefined();

    const hr = resolvePersona("hr", registry, stubEnv());
    expect(hr.principal.scopes).toContain("data:sensitive");

    const admin = resolvePersona("data_admin", registry, stubEnv());
    expect(admin.principal.role).toBe("admin");
    expect(admin.token).toBe("stub-admin");
  });

  it("keeps the sales_south demo alias on the same client", () => {
    const registry = fixtureRegistry();
    const viaAlias = resolvePersona("sales_south", registry, stubEnv());
    const viaFull = resolvePersona("regional_manager_south", registry, stubEnv());
    expect(viaAlias.principal).toEqual(viaFull.principal);
    expect(PERSONA_TO_CLIENT["default"]).toBeUndefined();
  });

  it("fails closed on unknown personas with no default role", () => {
    const registry = fixtureRegistry();
    for (const persona of ["admin", "root", "", "SALES_SOUTH", "default"]) {
      expect(() => resolvePersona(persona, registry, stubEnv())).toThrow(UnknownPersonaError);
    }
    try {
      resolvePersona("nope", registry, stubEnv());
      expect.unreachable();
    } catch (error) {
      expect((error as UnknownPersonaError).status).toBe(400);
    }
  });

  it("throws fail-fast when a token env var is missing", () => {
    const registry = fixtureRegistry();
    const env = stubEnv();
    delete env["MCP_TOKEN_HR"];
    expect(() => assertTokensPresent(registry, env)).toThrow(/MCP_TOKEN_HR/);
    expect(() => resolvePersona("hr", registry, env)).toThrow(/MCP_TOKEN_HR/);
  });

  it("loads the real policies file with five clients", () => {
    const registry = loadRegistryFromFile();
    expect(registry.version).toBe(1);
    expect(registry.clients.map((c) => c.clientId).sort()).toEqual(
      ["admin", "eval_schema_only", "hr", "marketing", "sales_south"].sort(),
    );
  });
});

describe("client registry shape guard", () => {
  it("rejects malformed registries", () => {
    expect(() => parseClientRegistry(null)).toThrow(/mapping/);
    expect(() => parseClientRegistry({ version: 2, clients: [] })).toThrow();
    expect(() => parseClientRegistry({ version: 1, clients: [] })).toThrow(/non-empty/);
    expect(() =>
      parseClientRegistry({
        version: 1,
        clients: [{ clientId: "a", role: "a", scopes: ["data:read"] }],
      }),
    ).toThrow(/tokenEnv/);
    expect(() =>
      parseClientRegistry({
        version: 1,
        clients: [
          { clientId: "a", role: "a", tokenEnv: "T_A", scopes: ["data:read"] },
          { clientId: "a", role: "b", tokenEnv: "T_B", scopes: ["data:read"] },
        ],
      }),
    ).toThrow(/unique/);
  });
});

describe("run context minting (D-13)", () => {
  it("mints UUID runIds with one thousand unique values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const ctx = mintRunContext("sales_south");
      expect(ctx.runId).toMatch(UUID_RE);
      seen.add(ctx.runId);
    }
    expect(seen.size).toBe(1000);
  });

  it("mints chat:userId:runId threads and keeps run and thread distinct", () => {
    const ctx = mintRunContext("sales_south");
    expect(ctx.threadId).toBe(`chat:sales_south:${ctx.runId}`);
    expect(ctx.threadId).not.toBe(ctx.runId);
    expect(isValidThreadId(ctx.threadId, "sales_south")).toBe(true);
  });

  it("accepts a well-formed client threadId and rejects malformed ones", () => {
    const ok = mintRunContext("u1", "chat:u1:session-7");
    expect(ok.threadId).toBe("chat:u1:session-7");
    expect(ok.runId).toMatch(UUID_RE);
    expect(() => mintRunContext("u1", "chat:other:session-7")).toThrow(InvalidThreadError);
    expect(() => mintRunContext("u1", "nota-chat-id")).toThrow(InvalidThreadError);
    expect(() => mintRunContext("u1", `chat:u1:${"s".repeat(THREAD_ID_MAX_LENGTH)}`)).toThrow(
      InvalidThreadError,
    );
    expect(() => mintRunContext("u1", "")).toThrow(InvalidThreadError);
  });
});
