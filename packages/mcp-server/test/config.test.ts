// Gateway client registry: evalOnly opt-in (issue #39). DB-free: inline
// YAML plus an explicit env object, never process.env or live secrets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVAL_CLIENTS_ENV,
  loadMcpClients,
  resolveClientTokens,
} from "../src/config.js";

const YAML = `
version: 1
clients:
  - clientId: hr
    role: hr
    tokenEnv: MCP_TOKEN_HR
    scopes: [schema:read, data:read]
  - clientId: eval_probe
    role: eval_probe
    tokenEnv: MCP_TOKEN_EVAL_PROBE
    scopes: [schema:read]
    evalOnly: true
`;

describe("resolveClientTokens evalOnly opt-in", () => {
  it("skips eval-only clients by default, so their token is not required", () => {
    const resolved = resolveClientTokens(loadMcpClients(YAML), {
      MCP_TOKEN_HR: "hr-token",
    } as NodeJS.ProcessEnv);
    expect(resolved.map((c) => c.clientId)).toEqual(["hr"]);
  });

  it("does not opt in on any value other than \"1\"", () => {
    const resolved = resolveClientTokens(loadMcpClients(YAML), {
      MCP_TOKEN_HR: "hr-token",
      MCP_TOKEN_EVAL_PROBE: "eval-token",
      [EVAL_CLIENTS_ENV]: "true",
    } as NodeJS.ProcessEnv);
    expect(resolved.map((c) => c.clientId)).toEqual(["hr"]);
  });

  it("loads eval-only clients when the flag is \"1\"", () => {
    const resolved = resolveClientTokens(loadMcpClients(YAML), {
      MCP_TOKEN_HR: "hr-token",
      MCP_TOKEN_EVAL_PROBE: "eval-token",
      [EVAL_CLIENTS_ENV]: "1",
    } as NodeJS.ProcessEnv);
    expect(resolved.map((c) => c.clientId)).toEqual(["hr", "eval_probe"]);
  });

  it("fails closed when opted in without the eval token", () => {
    expect(() =>
      resolveClientTokens(loadMcpClients(YAML), {
        MCP_TOKEN_HR: "hr-token",
        [EVAL_CLIENTS_ENV]: "1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_TOKEN_EVAL_PROBE/);
  });

  it("still requires every regular client token", () => {
    expect(() =>
      resolveClientTokens(loadMcpClients(YAML), {} as NodeJS.ProcessEnv),
    ).toThrow(/MCP_TOKEN_HR/);
  });

  it("rejects a non-boolean evalOnly flag", () => {
    expect(() =>
      loadMcpClients(YAML.replace("evalOnly: true", "evalOnly: yes-please")),
    ).toThrow();
  });

  it("marks the real eval_schema_only client as evalOnly", () => {
    const text = readFileSync(
      new URL("../../../policies/mcp_clients.yaml", import.meta.url),
      "utf8",
    );
    const probe = loadMcpClients(text).clients.find(
      (c) => c.clientId === "eval_schema_only",
    );
    expect(probe?.evalOnly).toBe(true);
  });
});
