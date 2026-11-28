import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type {
  RetrieveFn,
  RootGraphDeps,
  SynthesizeFn,
  VizFn,
} from "@shared/agent";
import type { DbToolError } from "@shared/contracts";
import type { ThreadLockAcquirer } from "./ports.js";
import type { ClientRegistry, Principal } from "./principals.js";
import type { AppStateStore } from "./store/alertStore.js";

export type ApiShellError = DbToolError;

export interface ReindexResult {
  added: number;
  updated: number;
  skipped: number;
  deleted: number;
}

export interface BuildAppOptions {
  checkpointer: BaseCheckpointSaver;
  mcpUrl: string;
  tracesDir?: string;
  registry?: ClientRegistry;
  env?: NodeJS.ProcessEnv;
  // Held for UC-10 write-after-send; ask and resume never call it directly.
  store?: AppStateStore;
  acquireThreadLock?: ThreadLockAcquirer;
  allowInMemoryLockForTests?: boolean;
  routes?: RootGraphDeps["routes"];
  textToSql?: RootGraphDeps["textToSql"];
  retrieve?: RetrieveFn;
  viz?: VizFn;
  synthesize?: SynthesizeFn;
  reindex?: (ctx: { token: string; mcpUrl: string }) => Promise<ReindexResult>;
}

export interface StoredRun {
  threadId: string;
  userId: string;
  roleScope: string;
  rowScope?: Principal["rowScope"];
  token: string;
  mcpUrl: string;
  tracesDir: string;
}

export interface AppContext {
  options: BuildAppOptions;
  tracesDir: string;
  env: NodeJS.ProcessEnv;
  registry: ClientRegistry;
  runs: Map<string, StoredRun>;
  acquireThreadLock: ThreadLockAcquirer;
}
