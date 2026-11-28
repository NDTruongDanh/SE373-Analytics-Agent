import { closeSync, openSync, readSync } from "node:fs";
import type { ClientRegistry } from "../principals.js";
import type { StoredRun } from "../types.js";

// Parse only the trace header line with strict validation so malformed lines fail closed to 404 and cannot inject identity.
export function rehydrateRun(
  runId: string,
  registry: ClientRegistry,
  env: NodeJS.ProcessEnv,
  mcpUrl: string,
  tracesDir: string,
): StoredRun | null {
  try {
    const header = readTraceHeader(tracesDir, runId);
    if (!header || header.runId !== runId) return null;
    if (
      typeof header.threadId !== "string" ||
      header.threadId.length === 0 ||
      header.threadId.length >= 255 ||
      /\s/.test(header.threadId)
    ) {
      return null;
    }
    if (typeof header.userId !== "string" || header.userId.length === 0) return null;
    const client = registry.clients.find(
      (c) => c.role === header.role || c.clientId === header.role,
    );
    if (!client) return null;
    const token = env[client.tokenEnv];
    if (typeof token !== "string" || token.length === 0) return null;
    return {
      threadId: header.threadId,
      userId: header.userId,
      roleScope: client.role,
      token,
      mcpUrl,
      tracesDir,
    };
  } catch {
    return null;
  }
}

function readTraceHeader(
  tracesDir: string,
  runId: string,
): { runId?: unknown; threadId?: unknown; userId?: unknown; role?: unknown } | null {
  try {
    const first = readFirstLine(tracesDir, runId);
    if (!first) return null;
    const parsed: unknown = JSON.parse(first);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readFirstLine(tracesDir: string, runId: string): string | null {
  if (runId.includes("/") || runId.includes("\\") || runId.includes("..")) return null;
  let fd = -1;
  try {
    fd = openSync(`${tracesDir}/${runId}.jsonl`, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      chunks.push(buf.subarray(0, n));
      if (buf.subarray(0, n).includes(0x0a)) break;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const line = text.split("\n")[0] ?? "";
    return line.length > 0 ? line : null;
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
