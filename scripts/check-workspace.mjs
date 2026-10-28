// Workspace invariant checker (node stdlib only, no new deps).
// Verifies the pnpm workspace linking contract:
//  1. All intra-@shared deps use `workspace:*` (never a published version).
//  2. Every packages/* library with src/index.ts exposes exports["."]
//     -> dist (apps are deployables and exempt).
//  3. CONTRACTS_VERSION matches packages/contracts/package.json version.
//  4. node_modules/@shared/* symlinks resolve (catches broken Windows links).
//  5. Direct workspace deps are covered by tsconfig project references
//     (catches stale-dist incremental builds, e.g. apps/api -> @shared/agent).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};

const pkgDirs = [
  "packages/contracts",
  "packages/agent",
  "packages/mcp-server",
  "packages/access-policy",
  "packages/data",
  "apps/api",
  "apps/web",
];

const readJson = (rel) =>
  JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

// 1 + 2 + 5
for (const dir of pkgDirs) {
  const pkg = readJson(`${dir}/package.json`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, range] of Object.entries(deps)) {
    if (name.startsWith("@shared/") && range !== "workspace:*") {
      fail(`${dir}: ${name} must be "workspace:*" (got ${range})`);
    }
  }
  if (existsSync(join(ROOT, dir, "src", "index.ts"))) {
    // Apps are deployables, never imported (eslint bans importing them),
    // so only packages/* libraries must expose a dist entry point.
    if (dir.startsWith("packages/")) {
      const target = pkg?.exports?.["."]?.default;
      if (target !== "./dist/index.js") {
        fail(`${dir}: missing exports["."].default "./dist/index.js"`);
      }
    }
  }
  const tsconfigPath = join(ROOT, dir, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    const refs = (tsconfig.references ?? []).map((r) => r.path);
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!name.startsWith("@shared/") || range !== "workspace:*") continue;
      const depShort = name.replace("@shared/", "");
      const isSelf = pkg.name === name;
      if (isSelf) continue;
      const covered = refs.some(
        (p) =>
          p.endsWith(`/${depShort}`) ||
          p.endsWith(`packages/${depShort}`) ||
          p.includes(depShort),
      );
      if (!covered) {
        fail(`${dir}: tsconfig references missing workspace dep ${name}`);
      }
    }
  }
}

// 3. contracts version consistency
const contractsPkg = readJson("packages/contracts/package.json");
const contractsSrc = readFileSync(
  join(ROOT, "packages/contracts/src/index.ts"),
  "utf8",
);
const m = contractsSrc.match(/CONTRACTS_VERSION\s*=\s*"([^"]+)"/);
if (!m) fail("packages/contracts/src/index.ts: CONTRACTS_VERSION not found");
else if (m[1] !== contractsPkg.version) {
  fail(
    `CONTRACTS_VERSION ${m[1]} != packages/contracts version ${contractsPkg.version}`,
  );
}

// 4. symlinks resolve (pnpm isolated layout: each consumer carries its own
// node_modules/@shared/* links; the root only has the two it directly uses,
// so verify per-consumer links, including the root itself).
const consumers = [".", ...pkgDirs];
for (const dir of consumers) {
  const pkg = readJson(`${dir === "." ? "" : `${dir}/`}package.json`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [name, range] of Object.entries(deps)) {
    if (!name.startsWith("@shared/") || range !== "workspace:*") continue;
    const linkPath = join(ROOT, dir, "node_modules", ...name.split("/"));
    if (!existsSync(linkPath)) {
      fail(
        `${dir}: missing install link ${name} (run pnpm install --frozen-lockfile)`,
      );
      continue;
    }
    try {
      realpathSync(linkPath);
    } catch {
      fail(`broken symlink ${dir}/node_modules/${name} (re-run pnpm install)`);
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck:workspace failed with ${failures} issue(s).`);
  process.exit(1);
}
console.log("check:workspace ok");
