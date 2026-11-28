import express from "express";
import { securityHeadersMiddleware } from "./middleware/security.js";
import { assertTokensPresent, loadRegistryFromFile } from "./principals.js";
import { createAskRouter } from "./routes/ask.js";
import { createHealthRouter } from "./routes/health.js";
import { createRunsRouter } from "./routes/runs.js";
import { createSemanticRouter } from "./routes/semantic.js";
import { createInMemoryLockAcquirer } from "./runtime/execution.js";
import type { AppContext, BuildAppOptions, StoredRun } from "./types.js";

export function buildApp(options: BuildAppOptions): express.Express {
  const tracesDir = options.tracesDir ?? "traces";
  const env = options.env ?? process.env;
  const registry = options.registry ?? loadRegistryFromFile();
  assertTokensPresent(registry, env);

  if (!options.acquireThreadLock && options.allowInMemoryLockForTests !== true) {
    throw new Error(
      "buildApp: acquireThreadLock is required in production; pass a PostgreSQL advisory lock acquirer or set allowInMemoryLockForTests: true for DB-free tests.",
    );
  }

  // Keyed by runId and write-once so concurrent asks cannot cross-contaminate run identity.
  const runs = new Map<string, StoredRun>();
  const acquireThreadLock = options.acquireThreadLock ?? createInMemoryLockAcquirer();

  const ctx: AppContext = {
    options,
    tracesDir,
    env,
    registry,
    runs,
    acquireThreadLock,
  };

  const app = express();
  app.use(securityHeadersMiddleware);
  app.use(express.json({ limit: "100kb" }));

  app.use(createHealthRouter());
  app.use("/api", createAskRouter(ctx));
  app.use("/api", createRunsRouter(ctx));
  app.use("/api", createSemanticRouter(ctx));

  return app;
}
