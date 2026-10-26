// Seed-hiding enforcement (Phase 1, plan 01-07, DB-07): seeded scenario ids,
// injection payloads, and gold reference paths must never reach agent code,
// app code, skills, evals, or OpenWiki-indexed docs. The scan below is the
// boundary — convention alone leaks via globs. DB-free: runs in CI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSeedsFile } from "../src/seeds.js";

const SCAN_ROOTS: readonly string[] = [
  "packages/agent",
  "apps",
  "skills",
  "evals",
  "docs",
  "policies",
  "semantic",
  "scripts",
];
const SCAN_FILES: readonly string[] = ["README.md", "AGENTS.md"];
const SCAN_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".md",
  ".yaml",
  ".yml",
  ".json",
];

function collectSourceFiles(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out; // Tree absent in this checkout — nothing to scan.
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectSourceFiles(path, out);
    } else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

// Every committed scenario id plus every injection payload: the secret tokens
// an agent-visible file must never contain. Reference-SQL fragments reduce to
// these ids in practice (each reference_sql names its own slice), and gold
// magnitudes live only in seeds.json plus the allow-listed scenario doc.
// Path pointers (data/seeded_scenarios.md etc.) are a separate list: docs may
// point at the scenario file, code must never reach for it.
const PATH_FRAGMENTS: readonly string[] = [
  "data/seeded_scenarios.md",
  "packages/data/src/seeds.json",
  "src/seeds.json",
  "seed_manifest", // covers seed_manifest.json and seed_manifest.small.json
];

// Roots where even a path pointer is a leak (code that could load the file).
const CODE_ROOTS: readonly string[] = [
  "packages/agent",
  "apps",
  "skills",
  "evals",
  "policies",
  "semantic",
  "scripts",
];

// Pre-existing spec files that mandate the injection example strings
// (PRD §4.3 attack cases; architecture §6 failure matrix row 3). The seeds
// instantiate these spec examples — direction is spec → seed, not a leak —
// so payload matching exempts exactly these two files. Scenario-id matching
// has no exemption anywhere.
const PAYLOAD_EXEMPT_FILES: readonly string[] = [
  "docs/prd.md",
  "docs/architecture.md",
];

describe("DB-07 seed hiding", () => {
  it("finds no seed id or payload outside data-side files", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const seeds = loadSeedsFile();
    const ids = [
      ...seeds.scenarios_uc05,
      ...seeds.anomalies_uc10,
      ...seeds.injections,
    ].map((entry) => entry.id);
    const payloads = [
      ...seeds.scenarios_uc05,
      ...seeds.anomalies_uc10,
      ...seeds.injections,
    ].flatMap((entry) => (entry.payload ? [entry.payload] : []));
    expect(ids.length).toBeGreaterThanOrEqual(11);
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    const files: string[] = [];
    for (const root of [...SCAN_ROOTS, ...CODE_ROOTS]) {
      collectSourceFiles(join(repoRoot, root), files);
    }
    for (const file of SCAN_FILES) {
      try {
        if (statSync(join(repoRoot, file)).isFile()) files.push(join(repoRoot, file));
      } catch {
        // Optional file absent — nothing to scan.
      }
    }
    const exempted = new Set(
      PAYLOAD_EXEMPT_FILES.map((file) => join(repoRoot, file)),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (ids.some((id) => content.includes(id))) {
        offenders.push(file);
        continue;
      }
      if (exempted.has(file)) continue;
      if (payloads.some((payload) => content.includes(payload))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds no seed or gold path pointer in code roots", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const files: string[] = [];
    for (const root of CODE_ROOTS) {
      collectSourceFiles(join(repoRoot, root), files);
    }
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (PATH_FRAGMENTS.some((fragment) => content.includes(fragment))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the seed paths out of OpenWiki reads", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const ignore = readFileSync(join(repoRoot, ".openwikiignore"), "utf8");
    for (const fragment of [
      "data/seeded_scenarios.md",
      "packages/data/src/seeds.json",
      "seed_manifest.json",
      "seed_manifest.small.json",
    ]) {
      expect(ignore).toContain(fragment);
    }
  });
});
