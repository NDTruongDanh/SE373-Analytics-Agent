import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/", "**/dist/", "coverage/"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/agent/**/*.ts", "apps/**/*.ts"],
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
    files: ["packages/sql-guard/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "sql-guard is a pure validator — it must never import the DB driver (UC-09 F11, D-01 purity).",
            },
            {
              name: "pg-cursor",
              message:
                "sql-guard is a pure validator — it must never import the DB cursor (UC-09 F11, D-01 purity).",
            },
          ],
        },
      ],
    },
  },
);
