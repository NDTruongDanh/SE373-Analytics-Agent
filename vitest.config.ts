import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/contracts",
      "packages/agent",
      "packages/mcp-server",
      "packages/access-policy",
      "packages/data",
      "apps/api",
      "apps/web",
    ],
  },
});
