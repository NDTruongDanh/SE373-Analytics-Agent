import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "**/dist/", "coverage/"],
  },
  ...tseslint.configs.recommended,
  {
    // Architecture §5.2 (REPO-01, final pass 01-15): the DB driver and the
    // MCP server package are reachable only from their owners. The agent
    // reaches the database only through the MCP client; the host reaches
    // state only through the PostgresSaver and AppStateStore ports; policy
    // code is pure (no driver, no network, no server imports).
    //
    // apps/api is deliberately absent from the pg ban (01-13 carve-out:
    // the AppStateStore DAO legitimately owns pg) but present in the
    // mcp-server ban. The UI (apps/web) carries both bans plus the
    // contracts-only rule in the block below.
    // apps/api is covered by both bans below EXCEPT the AppStateStore DAO
    // and its test (01-13 carve-out: the DAO legitimately owns pg).
    // ignores here excepts those two files from this block only.
    files: [
      "packages/agent/**/*.ts",
      "packages/access-policy/**/*.ts",
      "apps/api/**/*.ts",
    ],
    ignores: ["apps/api/src/store/**", "apps/api/test/store.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Only the MCP gateway, the operator data loader, and the apps/api AppStateStore host may import the DB driver — agent, policy, and API code reach data through the MCP client or the injected ports (architecture §5.2).",
            },
            {
              name: "pg-cursor",
              message:
                "Only the MCP gateway may import the DB cursor — agent, policy, and API code reach data through the MCP client or the injected ports (architecture §5.2).",
            },
          ],
          patterns: [
            {
              group: ["**/mcp-server/src/**"],
              message:
                "Agent, policy, and app code must not import mcp-server internals — DB access goes through the MCP client only (architecture §5.2).",
            },
            {
              group: ["@se373/mcp-server", "@se373/mcp-server/*"],
              message:
                "Agent, policy, and app code must not import the MCP server package — DB access goes through the MCP client only (architecture §5.2).",
            },
          ],
        },
      ],
    },
  },
  {
    // Architecture §5.2 (REPO-01, final pass 01-15): apps/web combines the
    // driver ban, the MCP server ban, and the contracts-only workspace rule
    // in ONE entry — flat-config blocks setting the same rule replace (not
    // merge), so splitting them would silently shadow all but the last.
    // When a new workspace package appears, add it to the paths list: the
    // rule is deny-by-default in intent, enumerated so a new package can
    // never slip through silently.
    files: ["apps/web/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Web UI must not import the DB driver — shared types come from @se373/contracts only (architecture §5.2).",
            },
            {
              name: "pg-cursor",
              message:
                "Web UI must not import the DB cursor — shared types come from @se373/contracts only (architecture §5.2).",
            },
            {
              name: "@se373/agent",
              message:
                "Web UI must not import the agent package — shared types come from @se373/contracts only (architecture §5.2).",
            },
            {
              name: "@se373/mcp-server",
              message:
                "Web UI must not import the MCP server package — shared types come from @se373/contracts only (architecture §5.2).",
            },
            {
              name: "@se373/access-policy",
              message:
                "Web UI must not import the access-policy package — shared types come from @se373/contracts only (architecture §5.2).",
            },
            {
              name: "@se373/api",
              message:
                "Web UI must not import the API package — shared types come from @se373/contracts only (architecture §5.2).",
            },
            {
              name: "@se373/data",
              message:
                "Web UI must not import the operator data-loader package — shared types come from @se373/contracts only (architecture §5.2).",
            },
          ],
          patterns: [
            {
              group: ["**/mcp-server/src/**"],
              message:
                "Web UI must not import mcp-server internals — shared types come from @se373/contracts only (architecture §5.2).",
            },
          ],
        },
      ],
    },
  },
);
