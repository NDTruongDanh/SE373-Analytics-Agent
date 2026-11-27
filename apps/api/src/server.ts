import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushLangSmith } from "@shared/agent/telemetry";
import { buildApp } from "./app.js";
import {
  createHostPorts,
  DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS,
  type HostPorts,
} from "./ports.js";
import { assertTokensPresent, loadRegistryFromFile } from "./principals.js";
import {
  LANGSMITH_FLUSH_TIMEOUT_MS,
  startApiCheckpointLifecycle,
} from "./runtime/execution.js";

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const apiPort = Number(env["API_PORT"] ?? 3001);
  const mcpPort = Number(env["MCP_PORT"] ?? 8081);
  const tracesDir = env["TRACES_DIR"] ?? "traces";
  const mcpUrl = env["MCP_URL"] ?? `http://127.0.0.1:${mcpPort}/mcp`;
  const rawInterval = Number(env["CHECKPOINT_CLEANUP_INTERVAL_MS"]);
  const intervalMs =
    Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : DEFAULT_CHECKPOINT_CLEANUP_INTERVAL_MS;

  const ports: HostPorts = await createHostPorts(env);
  const registry = loadRegistryFromFile();
  assertTokensPresent(registry, env);

  const app = buildApp({
    checkpointer: ports.checkpointer,
    store: ports.store,
    acquireThreadLock: ports.acquireThreadLock,
    mcpUrl,
    tracesDir,
    registry,
    env,
  });

  const server = app.listen(apiPort, () => {
    console.log(`[api] listening on 127.0.0.1:${apiPort}`);
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));

  const checkpointScheduler = startApiCheckpointLifecycle({
    ports,
    intervalMs,
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      checkpointScheduler.stop();
      void Promise.allSettled([
        ports.lockPool.end(),
        flushLangSmith({ timeoutMs: LANGSMITH_FLUSH_TIMEOUT_MS }),
      ]).finally(() => process.exit(0));
    });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await startServer();
}
