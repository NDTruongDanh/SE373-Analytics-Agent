import tseslint from "typescript-eslint";

const DIRECTIVE_RE =
  /^(?:eslint-(?:disable|enable)(?:-(?:next-)?line)?|global\b|exported\b|@ts-(?:expect-error|ignore|nocheck|check)\b|@vitest-environment\b|(?:v8|c8|istanbul)\s+ignore\b|prettier-ignore\b|@license\b|@preserve\b|\/\s*<reference\b)/i;
const DIVIDER_LINE_RE = /^\s*[-=*~─═━#]{3,}|[-=*~─═━#]{4,}/;
const TRACKING_ID_RE =
  /\b0\d-\d{2}\b|\bwave\s+\d+\b|\bD-\d{2}\b|\b(?:REPO|API|AGENT|MCP|DATA|WEB|EVAL|POLICY|GUARD|TRACE|ALERT|RCA|VIZ|HITL|PORT)-\d{2}\b|#\d{2,4}\b/i;
const COMMENTED_CODE_RE =
  /^\s*(?:import\s+.+\s+from\s+["']|export\s+(?:default|const|let|var|function|class|type|interface)\b|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=|function\s+[A-Za-z_$][\w$]*\s*\(|console\.(?:log|debug|info|warn|error)\s*\()/;

const noUnnecessaryCommentsRule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow empty comments, divider banners, stale tracking IDs, and commented-out code",
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        const comments = context.sourceCode.getAllComments();
        const lineCommentsByLine = new Map();
        for (const comment of comments) {
          if (comment.type === "Line" && comment.loc) {
            lineCommentsByLine.set(comment.loc.start.line, comment.value.trim());
          }
        }

        for (const comment of comments) {
          const rawLines = comment.value.split("\n");
          const normalizedLines = rawLines.map((line) =>
            comment.type === "Block" ? line.replace(/^\s*\* ?/, "").trim() : line.trim(),
          );
          const joined = normalizedLines.join("\n").trim();

          if (DIRECTIVE_RE.test(joined)) {
            continue;
          }

          if (joined.length === 0) {
            if (comment.type === "Line" && comment.loc) {
              const line = comment.loc.start.line;
              const prev = lineCommentsByLine.get(line - 1);
              const next = lineCommentsByLine.get(line + 1);
              if (prev && prev.length > 0 && next && next.length > 0) {
                continue;
              }
            }
            context.report({
              loc: comment.loc,
              message: "Unnecessary empty comment.",
            });
            continue;
          }

          if (normalizedLines.some((line) => DIVIDER_LINE_RE.test(line))) {
            context.report({
              loc: comment.loc,
              message: "Unnecessary divider or banner comment.",
            });
            continue;
          }

          if (TRACKING_ID_RE.test(joined)) {
            context.report({
              loc: comment.loc,
              message:
                "Unnecessary stale plan, wave, decision, requirement, or issue reference in comment.",
            });
            continue;
          }

          if (comment.type === "Line" && COMMENTED_CODE_RE.test(comment.value)) {
            context.report({
              loc: comment.loc,
              message: "Unnecessary commented-out code.",
            });
          }
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ["node_modules/", "**/dist/", "coverage/"],
  },
  ...tseslint.configs.recommended,
  {
    files: [
      "packages/*/src/**/*.{ts,tsx,js,mjs}",
      "apps/*/src/**/*.{ts,tsx,js,mjs}",
      "scripts/**/*.{ts,tsx,js,mjs}",
      "eslint.config.mjs",
    ],
    plugins: {
      local: {
        rules: {
          "no-unnecessary-comments": noUnnecessaryCommentsRule,
        },
      },
    },
    rules: {
      "local/no-unnecessary-comments": "error",
    },
  },
  {
    // apps/api/src/store/** and its test legitimately own pg via AppStateStore;
    // ignores here exempts only those files from the pg/mcp-server restriction.
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
              group: ["@shared/mcp-server", "@shared/mcp-server/*"],
              message:
                "Agent, policy, and app code must not import the MCP server package — DB access goes through the MCP client only (architecture §5.2).",
            },
          ],
        },
      ],
    },
  },
  {
    // Flat-config blocks setting the same rule replace rather than merge, so
    // apps/web combines the driver, MCP server, and contracts-only bans here.
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Web UI must not import the DB driver — shared types come from @shared/contracts only (architecture §5.2).",
            },
            {
              name: "pg-cursor",
              message:
                "Web UI must not import the DB cursor — shared types come from @shared/contracts only (architecture §5.2).",
            },
            {
              name: "@shared/agent",
              message:
                "Web UI must not import the agent package — shared types come from @shared/contracts only (architecture §5.2).",
            },
            {
              name: "@shared/mcp-server",
              message:
                "Web UI must not import the MCP server package — shared types come from @shared/contracts only (architecture §5.2).",
            },
            {
              name: "@shared/access-policy",
              message:
                "Web UI must not import the access-policy package — shared types come from @shared/contracts only (architecture §5.2).",
            },
            {
              name: "@shared/api",
              message:
                "Web UI must not import the API package — shared types come from @shared/contracts only (architecture §5.2).",
            },
            {
              name: "@shared/data",
              message:
                "Web UI must not import the operator data-loader package — shared types come from @shared/contracts only (architecture §5.2).",
            },
          ],
          patterns: [
            {
              group: ["@shared/agent/*", "@shared/mcp-server/*", "@shared/access-policy/*", "@shared/api/*", "@shared/data/*"],
              message: "Web UI may import workspace types only from @shared/contracts.",
            },
            {
              group: ["**/mcp-server/src/**"],
              message:
                "Web UI must not import mcp-server internals — shared types come from @shared/contracts only (architecture §5.2).",
            },
          ],
        },
      ],
    },
  },
);
