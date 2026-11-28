import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

export { API_SHELL } from "./constants.js";
export { buildApp } from "./app.js";
export { API_CSP_HEADER } from "./middleware/security.js";
export { defaultReindex } from "./routes/semantic.js";
export {
  buildResumeInvokeOptions,
  configurableForRun,
  startApiCheckpointLifecycle,
} from "./runtime/execution.js";
export { rehydrateRun } from "./runtime/rehydrate.js";
export { startServer } from "./server.js";
export type {
  ApiShellError,
  BuildAppOptions,
  ReindexResult,
  StoredRun,
} from "./types.js";

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await startServer();
}
