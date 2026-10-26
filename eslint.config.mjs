import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "**/dist/", "coverage/"],
  },
  ...tseslint.configs.recommended,
  {
    files: [
      "packages/agent/**/*.ts",
      "packages/access-policy/**/*.ts",
      "apps/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Agent code must not import the DB driver directly — all DB access goes through the MCP client only (UC-09 F11).",
            },
            {
              name: "pg-cursor",
              message:
                "Agent code must not import the DB cursor directly — all DB access goes through the MCP client only (UC-09 F11).",
            },
          ],
          patterns: [
            {
              group: ["**/mcp-server/src/**"],
              message:
                "Agent code must not import mcp-server internals — DB access goes through the MCP client only (UC-09 F11).",
            },
            {
              group: ["@se373/mcp-server", "@se373/mcp-server/*"],
              message:
                "Agent code must not import the MCP server package — DB access goes through the MCP client only (UC-09 F11).",
            },
          ],
        },
      ],
    },
  },
  {
    // Architecture §5.2: apps/web imports workspace types from @se373/contracts only.
    // The full §5.2 graph pass (incl. the packages/data operator exemption note)
    // lands in 01-15, where REPO-01 reaches done.
    files: ["apps/web/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
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
          ],
        },
      ],
    },
  },
);
