// Seeds validation plus DATA-05 hiding enforcement (Phase 2, plan 02-02).
// No database: every case runs in CI. Follows the sensitive-columns
// validation-matrix shape: one `it` per schema violation. The source scan
// walks the agent and apps trees and fails any source file that reaches for
// the hidden seed or gold paths — the test is the boundary (convention
// alone leaks via globs).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSeeds, loadSeedsFile } from "../src/seeds.js";

// Hidden seed/gold path fragments, defined once here and used by the scan
// below. Agent and app source must never reference any of them.
const HIDDEN_PATH_FRAGMENTS: readonly string[] = [
  "data/seeded_scenarios.md",
  "seeded_scenarios",
  "packages/data/src/seeds.json",
  "src/seeds.json",
  "seed_manifest.json",
];

const SCAN_ROOTS: readonly string[] = ["packages/agent", "apps"];
const SCAN_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs"];

function collectSourceFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectSourceFiles(path, out);
    } else if (
      SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))
    ) {
      out.push(path);
    }
  }
  return out;
}

const VALID_ENTRY = {
  id: "uc05-test",
  description: "test scenario",
  dimension_filter: "channel=Shopee",
  period: { start: "2026-09-01", end: "2026-09-30" },
  magnitude: -0.18,
  reference_sql: "SELECT 1",
};

function seedsJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    scenarios_uc05: [VALID_ENTRY, VALID_ENTRY, VALID_ENTRY],
    anomalies_uc10: [
      VALID_ENTRY,
      VALID_ENTRY,
      VALID_ENTRY,
      VALID_ENTRY,
      VALID_ENTRY,
    ],
    injections: [VALID_ENTRY, VALID_ENTRY, VALID_ENTRY],
    ...overrides,
  });
}

describe("loadSeeds validation matrix", () => {
  it("parses the real seeds file with the D-04 minima", () => {
    const seeds = loadSeedsFile();
    expect(seeds.version).toBe(1);
    expect(seeds.scenarios_uc05.length).toBeGreaterThanOrEqual(3);
    expect(seeds.anomalies_uc10.length).toBeGreaterThanOrEqual(5);
    expect(seeds.injections.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a missing version", () => {
    expect(() =>
      loadSeeds(seedsJson({ version: undefined })),
    ).toThrow();
  });

  it("rejects a wrong version literal", () => {
    expect(() => loadSeeds(seedsJson({ version: 2 }))).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() =>
      loadSeeds(
        seedsJson({ scenarios_uc05: [{ ...VALID_ENTRY, id: "" }] }),
      ),
    ).toThrow();
  });

  it("rejects extra keys via strictness", () => {
    expect(() =>
      loadSeeds(seedsJson({ owner: "someone" })),
    ).toThrow();
    expect(() =>
      loadSeeds(
        seedsJson({
          scenarios_uc05: [{ ...VALID_ENTRY, scope: "extra" }],
        }),
      ),
    ).toThrow();
  });

  it("rejects a malformed reference_sql", () => {
    expect(() =>
      loadSeeds(
        seedsJson({
          scenarios_uc05: [
            { ...VALID_ENTRY, reference_sql: "DELETE FROM t" },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => loadSeeds("version: [1\nscenarios: :\n")).toThrow();
  });
});

describe("DATA-05 hiding enforcement", () => {
  it("finds no hidden seed or gold path referenced from agent or app sources", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      const absolute = join(repoRoot, root);
      let files: string[];
      try {
        files = collectSourceFiles(absolute);
      } catch {
        continue; // Tree absent in this checkout — nothing to scan.
      }
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        if (
          HIDDEN_PATH_FRAGMENTS.some((fragment) => content.includes(fragment))
        ) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the hidden paths out of OpenWiki reads", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const ignore = readFileSync(join(repoRoot, ".openwikiignore"), "utf8");
    for (const fragment of [
      "data/seeded_scenarios.md",
      "packages/data/src/seeds.json",
      "seed_manifest.json",
    ]) {
      expect(ignore).toContain(fragment);
    }
  });
});
