import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // D-04: a developer-exported tracing env must never auto-trace unit
    // tests (the bare env auto-tracer bypasses the anonymizer).
    env: {
      LANGSMITH_TRACING: "false",
      LANGSMITH_TRACING_V2: "false",
      LANGCHAIN_TRACING_V2: "false",
      LANGCHAIN_TRACING: "false",
    },
  },
});
