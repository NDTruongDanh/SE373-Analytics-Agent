// Pinned Olist downloader (Phase 2, plan 02-02, D-01/D-02). Downloads the
// eight Olist CSVs at load time from Olist's official publisher repo over
// HTTPS into the git-ignored data/.cache/ — CSVs are never committed and no
// Kaggle token or browser step is ever required.
//
// Trust boundary (T-2-05): untrusted bytes enter here; the FILE table is the
// checkpoint. Every downloaded byte stream is verified (byte size + git blob
// SHA-1 + SHA-256) against the pinned table BEFORE any parse. Any mismatch
// throws fail-fast naming the file. Blob SHAs were resolved once at author
// time from the GitHub contents API for olist/work-at-olist-data; byte sizes
// and SHA-256 were measured from the same bytes.
//
// Follows the access-policy fail-fast plus override-precedence idioms
// (sensitive-columns.ts:31-52): pure verify function plus a thin IO wrapper
// where an explicit argument beats the env override beats the default.
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export interface OlistFileEntry {
  /** Publisher filename under datasets/. */
  name: string;
  /** Business table this CSV feeds. */
  businessTable: string;
  /** Exact byte size of the publisher bytes. */
  bytes: number;
  /** Git blob SHA (api.github.com contents API) of the publisher bytes. */
  blobSha: string;
  /** SHA-256 of the publisher bytes, measured at author time. */
  sha256: string;
  /** How this entry is verified. All entries use pinned SHAs (API was reachable). */
  mode: "blob-sha";
  /** True when the file starts with a UTF-8 BOM (csv-parse needs `bom: true`). */
  bom: boolean;
}

const BASE_URL =
  "https://raw.githubusercontent.com/olist/work-at-olist-data/master/datasets";

// Eight Olist CSVs feeding seven business tables plus the categories map.
// geolocation (61MB) is intentionally excluded — sellers carry city/state.
export const OLIST_FILES: readonly OlistFileEntry[] = [
  {
    name: "olist_customers_dataset.csv",
    businessTable: "customers",
    bytes: 8562270,
    blobSha: "247b44f6c4836b354fb90b89f0fb8927a670fa38",
    sha256:
      "c26c17f59f3027a6a0dbeb8f1fa373c38f3323ecc84f225a8f4820e5bb288df8",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_orders_dataset.csv",
    businessTable: "orders",
    bytes: 17654914,
    blobSha: "8133513ba3bcf576837c47aedd7fd81c5bb110fc",
    sha256:
      "8df58ef3d2d7e9944010f7beecd9b75367f5588ec6e3c91cec19ae3345ef9ecf",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_order_items_dataset.csv",
    businessTable: "order_items",
    bytes: 15007623,
    blobSha: "469094c4785f82d594796efe376fd18fdd1596b4",
    sha256:
      "4f6abdbbc94036d0df4a76fa0520c072e31a40119d70f7f370fba1e2285d2bcb",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_products_dataset.csv",
    businessTable: "products",
    bytes: 2379446,
    blobSha: "e5bd67eb7de63126b6b92aded29221303b124ed0",
    sha256:
      "3e6569628a17fbc75fd206ee357b59e20364b9afa90f5b6cd5b4d624c58aa9cc",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_sellers_dataset.csv",
    businessTable: "sellers",
    bytes: 163589,
    blobSha: "173500dec733fff76e2d4ca9eaee8995c481ea34",
    sha256:
      "31eb9bd50d684526a78f2389413ce61841e97692de7b828fe7d956b534586312",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_order_payments_dataset.csv",
    businessTable: "payments",
    bytes: 5647783,
    blobSha: "663679bc7a2911b806ef30ef1852f25b502005b2",
    sha256:
      "61674868ed7b872aac3dcd95bf774448a88f6426b183f21be55f75af021ffdec",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_order_reviews_dataset.csv",
    businessTable: "reviews",
    bytes: 14451670,
    blobSha: "2c32975b59dfa8335963fd4e94e3bebd60bd16f6",
    sha256:
      "012b61c7593e34f51fa614efdf802b9c7056ce6aae5307ddb93236e7cfc797d7",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "product_category_name_translation.csv",
    businessTable: "categories",
    bytes: 2613,
    blobSha: "316c88942fc31f7a22a6233a125e5dafea2af5d7",
    sha256:
      "a81f0d1f27b27e7293f761bc79e3ce8f348ee39c4b3ed3e49bde38f478586278",
    mode: "blob-sha",
    bom: true,
  },
];

// Cache dir resolved from this module's location so it works regardless of
// the caller's cwd (src and dist layouts both sit two levels below the repo
// root). No CSV is ever written outside this directory.
export const DEFAULT_CACHE_DIR = fileURLToPath(
  new URL("../../../data/.cache", import.meta.url),
);

// Explicit argument beats env beats default (sensitive-columns idiom).
export function resolveCacheDir(override?: string): string {
  return resolve(
    override ?? process.env["OLIST_CACHE_DIR"] ?? DEFAULT_CACHE_DIR,
  );
}

// Cache path for a registered file. Rejects anything outside the table so a
// caller can never be tricked into writing (or reading) an arbitrary path.
export function cachePathFor(name: string, dir?: string): string {
  const entry = OLIST_FILES.find((file) => file.name === name);
  if (!entry) {
    throw new Error(
      `Unknown Olist file "${name}" — registered: ${OLIST_FILES.map((file) => file.name).join(", ")}`,
    );
  }
  // basename strips any directory the name might smuggle in; the lookup
  // above already guarantees the name is a plain registered filename.
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

// Pure verification: byte size, git blob SHA, and SHA-256 of the downloaded
// bytes against the pinned table. Throws fail-fast naming the file and the
// mismatch. Runs BEFORE any parse (T-2-05).
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

// Downloads one registered file with global fetch, streaming straight into
// data/.cache/ (cache dir created on demand). Verifies bytes before
// returning the cache path. Network failures name the URL and the retry
// action — never a Kaggle token or a browser step.
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

// Downloads every registered file (or a caller-selected subset). Skips files
// already present in the cache whose bytes still verify, so re-runs are cheap.
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
