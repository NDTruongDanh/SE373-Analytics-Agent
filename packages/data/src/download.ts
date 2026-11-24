import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { DEFAULT_CACHE_DIR, OLIST_FILES } from "./constants.js";

export { DEFAULT_CACHE_DIR, OLIST_FILES };

export interface OlistFileEntry {
  name: string;
  businessTable: string;
  bytes: number;
  blobSha: string;
  sha256: string;
  mode: "blob-sha";
  bom: boolean;
}

const BASE_URL =
  "https://raw.githubusercontent.com/olist/work-at-olist-data/master/datasets";

export function resolveCacheDir(override?: string): string {
  return resolve(
    override ?? process.env["OLIST_CACHE_DIR"] ?? DEFAULT_CACHE_DIR,
  );
}

// Only registered filenames are allowed; basename prevents directory traversal.
export function cachePathFor(name: string, dir?: string): string {
  const entry = OLIST_FILES.find((file) => file.name === name);
  if (!entry) {
    throw new Error(
      `Unknown Olist file "${name}" — registered: ${OLIST_FILES.map((file) => file.name).join(", ")}`,
    );
  }
  return join(resolveCacheDir(dir), basename(entry.name));
}

function gitBlobSha1(content: Buffer): string {
  // Git blob object hash: sha1("blob <len>\0" + content).
  const header = Buffer.from(`blob ${String(content.length)}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function verifyDownloadedBytes(name: string, content: Buffer): void {
  const entry = OLIST_FILES.find((file) => file.name === name);
  if (!entry) {
    throw new Error(
      `Unknown Olist file "${name}" — cannot verify unregistered bytes`,
    );
  }
  if (content.length !== entry.bytes) {
    throw new Error(
      `Olist file ${name} failed verification: byte size ${String(content.length)} != pinned ${String(entry.bytes)} — the publisher bytes changed; re-resolve the FILE table`,
    );
  }
  const blob = gitBlobSha1(content);
  if (blob !== entry.blobSha) {
    throw new Error(
      `Olist file ${name} failed verification: blob SHA ${blob} != pinned ${entry.blobSha} — the publisher bytes changed; re-resolve the FILE table`,
    );
  }
  const digest = sha256Hex(content);
  if (digest !== entry.sha256) {
    throw new Error(
      `Olist file ${name} failed verification: SHA-256 ${digest} != pinned ${entry.sha256} — the publisher bytes changed; re-resolve the FILE table`,
    );
  }
}

export function fileUrl(name: string): string {
  return `${BASE_URL}/${name}`;
}

export async function downloadFile(
  name: string,
  options?: { cacheDir?: string; baseUrl?: string },
): Promise<string> {
  const entry = OLIST_FILES.find((file) => file.name === name);
  if (!entry) {
    throw new Error(
      `Unknown Olist file "${name}" — registered: ${OLIST_FILES.map((file) => file.name).join(", ")}`,
    );
  }
  const base = options?.baseUrl ?? process.env["OLIST_BASE_URL"] ?? BASE_URL;
  const url = `${base}/${entry.name}`;
  const cacheDir = resolveCacheDir(options?.cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, basename(entry.name));

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Failed to reach ${url}: ${error instanceof Error ? error.message : String(error)} — check network access to raw.githubusercontent.com and retry \`pnpm data:load\``,
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed for ${url}: HTTP ${String(response.status)} — check network access to raw.githubusercontent.com and retry \`pnpm data:load\``,
    );
  }
  try {
    await pipeline(response.body, createWriteStream(dest));
  } catch (error) {
    throw new Error(
      `Download failed for ${url}: ${error instanceof Error ? error.message : String(error)} — check disk space under ${cacheDir} and retry \`pnpm data:load\``,
    );
  }
  const { readFileSync } = await import("node:fs");
  verifyDownloadedBytes(entry.name, readFileSync(dest));
  return dest;
}

export async function downloadAll(
  names: readonly string[] = OLIST_FILES.map((file) => file.name),
  options?: { cacheDir?: string; baseUrl?: string },
): Promise<string[]> {
  const { readFileSync, existsSync } = await import("node:fs");
  const paths: string[] = [];
  for (const name of names) {
    const dest = cachePathFor(name, options?.cacheDir);
    if (existsSync(dest)) {
      try {
        verifyDownloadedBytes(name, readFileSync(dest));
        paths.push(dest);
        continue;
      } catch {
        // Cached copy is stale or corrupt — re-download below.
      }
    }
    paths.push(await downloadFile(name, options));
  }
  return paths;
}
