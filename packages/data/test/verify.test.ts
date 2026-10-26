// Unit suite for the data package (Phase 1, plan 01-07, DB-08): manifest
// hash/gate fixtures, seeds.ts strict-zod validation matrix (minima
// enforced), D-22 province-list verification, verifier-helper checks with a
// stub client, plus a skipped-if-no-DB leg that runs the real assertions
// against the loaded database. No DB is required for any case except the
// final live leg.
import { describe, expect, it } from "vitest";
import { REGION_ROWS, TABLE_LOADERS } from "../src/load.js";
import {
  compareManifests,
  hashCanonicalCsv,
} from "../src/manifest.js";
import { loadSeeds, loadSeedsFile } from "../src/seeds.js";
import {
  brlToVnd,
  foldOrderStatus,
  PROVINCES,
  REGION_GROUPS,
  regionOfProvince,
  shiftOrderDate,
  STATE_TO_PROVINCE,
  stateToProvince,
  translateCategory,
} from "../src/transform.js";
import { runChecks } from "../src/verify.js";

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

describe("manifest hash and reload gate", () => {
  it("hashes a fixed row set deterministically and avalanches on change", () => {
    const rows = "a,1\nb,2";
    expect(hashCanonicalCsv(rows)).toBe(hashCanonicalCsv(rows));
    expect(hashCanonicalCsv(rows)).not.toBe(hashCanonicalCsv("a,1\nb,3"));
  });

  it("reports no mismatch on identical manifests", () => {
    const manifest = {
      version: 1 as const,
      seed: 42,
      dataset_version: "x",
      tables: { t: { rows: 2, sha256: hashCanonicalCsv("a,1\nb,2") } },
    };
    expect(compareManifests(manifest, manifest)).toEqual([]);
  });

  it("reports row, hash, seed, and version drift", () => {
    const base = {
      version: 1 as const,
      seed: 42,
      dataset_version: "x",
      tables: { t: { rows: 2, sha256: hashCanonicalCsv("a,1\nb,2") } },
    };
    const drifted = {
      ...base,
      tables: { t: { rows: 3, sha256: hashCanonicalCsv("a,1\nb,3") } },
    };
    const mismatches = compareManifests(base, drifted);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.join("\n")).toContain("t:");
    expect(
      compareManifests(base, { ...base, seed: 43 }).join("\n"),
    ).toContain("seed");
    expect(
      compareManifests(base, { ...base, dataset_version: "y" }).join("\n"),
    ).toContain("dataset_version");
  });
});

describe("loadSeeds validation matrix", () => {
  it("parses the real seeds file with the DB-07 minima", () => {
    const seeds = loadSeedsFile();
    expect(seeds.version).toBe(1);
    expect(seeds.scenarios_uc05.length).toBeGreaterThanOrEqual(3);
    expect(seeds.anomalies_uc10.length).toBeGreaterThanOrEqual(5);
    expect(seeds.injections.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a missing or wrong version literal", () => {
    expect(() => loadSeeds(seedsJson({ version: undefined }))).toThrow();
    expect(() => loadSeeds(seedsJson({ version: 2 }))).toThrow();
  });

  it("rejects below-minimum scenario counts", () => {
    expect(() =>
      loadSeeds(
        seedsJson({ scenarios_uc05: [VALID_ENTRY, VALID_ENTRY] }),
      ),
    ).toThrow();
    expect(() =>
      loadSeeds(
        seedsJson({
          anomalies_uc10: [
            VALID_ENTRY,
            VALID_ENTRY,
            VALID_ENTRY,
            VALID_ENTRY,
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      loadSeeds(
        seedsJson({ injections: [VALID_ENTRY, VALID_ENTRY] }),
      ),
    ).toThrow();
  });

  it("rejects an empty id and extra keys via strictness", () => {
    expect(() =>
      loadSeeds(
        seedsJson({ scenarios_uc05: [{ ...VALID_ENTRY, id: "" }] }),
      ),
    ).toThrow();
    expect(() => loadSeeds(seedsJson({ owner: "someone" }))).toThrow();
    expect(() =>
      loadSeeds(
        seedsJson({
          scenarios_uc05: [{ ...VALID_ENTRY, scope: "extra" }],
        }),
      ),
    ).toThrow();
  });

  it("rejects a non-SELECT reference_sql and malformed JSON", () => {
    expect(() =>
      loadSeeds(
        seedsJson({
          scenarios_uc05: [
            { ...VALID_ENTRY, reference_sql: "DELETE FROM t" },
          ],
        }),
      ),
    ).toThrow();
    expect(() => loadSeeds("version: [1\nscenarios: :\n")).toThrow();
  });

  it("keeps every committed reference_sql on public.* with float division", () => {
    const seeds = loadSeedsFile();
    const all = [
      ...seeds.scenarios_uc05,
      ...seeds.anomalies_uc10,
      ...seeds.injections,
    ];
    for (const entry of all) {
      expect(entry.reference_sql).toMatch(/^\s*select\b/i);
      expect(entry.reference_sql).not.toContain("business.");
    }
    for (const entry of [
      ...seeds.scenarios_uc05,
      ...seeds.anomalies_uc10,
    ]) {
      if (entry.reference_sql.includes("/ NULLIF")) {
        expect(entry.reference_sql).toContain("::float");
      }
    }
  });
});

describe("D-22 province list (Resolution 202/2025/QH15)", () => {
  // Re-verified 2026-10-26 against the vi.wikipedia merge table for
  // Resolution 202/2025/QH15 (effective 12/6/2025; 34 units: 28 provinces +
  // 6 centrally-governed cities) plus the thuvienphapluat full text. The
  // Bac/Trung/Nam grouping is the project's own convention (CONTEXT D-01),
  // not part of the resolution.
  const EXPECTED_34 = [
    "Hà Nội",
    "Hải Phòng",
    "Lai Châu",
    "Điện Biên",
    "Sơn La",
    "Lạng Sơn",
    "Cao Bằng",
    "Tuyên Quang",
    "Lào Cai",
    "Thái Nguyên",
    "Phú Thọ",
    "Bắc Ninh",
    "Hưng Yên",
    "Ninh Bình",
    "Quảng Ninh",
    "Thanh Hóa",
    "Nghệ An",
    "Hà Tĩnh",
    "Quảng Trị",
    "Huế",
    "Đà Nẵng",
    "Quảng Ngãi",
    "Gia Lai",
    "Khánh Hòa",
    "Lâm Đồng",
    "Đắk Lắk",
    "Đồng Nai",
    "Tây Ninh",
    "TP.HCM",
    "Đồng Tháp",
    "An Giang",
    "Vĩnh Long",
    "Cần Thơ",
    "Cà Mau",
  ];

  it("carries exactly the 34 post-merger provinces", () => {
    expect(PROVINCES.map(([name]) => name).sort()).toEqual(
      [...EXPECTED_34].sort(),
    );
    expect(REGION_GROUPS).toEqual(["Bắc", "Trung", "Nam"]);
  });

  it("keeps the loader REGION_ROWS in sync with transform PROVINCES", () => {
    expect([...REGION_ROWS].sort()).toEqual([...PROVINCES].sort());
    for (const [name] of PROVINCES) {
      expect(REGION_GROUPS).toContain(regionOfProvince(name));
    }
  });

  it("resolves all 27 Olist state codes into the 34 provinces", () => {
    expect(Object.keys(STATE_TO_PROVINCE)).toHaveLength(27);
    const provinces = new Set(PROVINCES.map(([name]) => name));
    expect(provinces.size).toBe(34);
    for (const code of Object.keys(STATE_TO_PROVINCE)) {
      expect(provinces.has(stateToProvince(code))).toBe(true);
    }
    expect(() => stateToProvince("XX")).toThrow();
    expect(() => regionOfProvince("Atlantis")).toThrow();
  });

  it("folds statuses and converts currency without float leakage", () => {
    expect(foldOrderStatus("delivered")).toBe("delivered");
    expect(foldOrderStatus("shipped")).toBe("shipped");
    expect(foldOrderStatus("created")).toBe("canceled");
    expect(() => foldOrderStatus("returned")).toThrow();
    expect(brlToVnd(100)).toBe(515000);
    expect(translateCategory("pc_gamer")).toBe("Máy tính & Linh kiện");
    expect(shiftOrderDate("2018-10-17")).toBe("2026-09-30");
  });
});

// Stub client: exact-SQL map for seed reference queries, pattern rules for
// the count/FK aggregates. Lets runChecks prove its exit-1 contract with no
// database.
function stubClient(overrides: Record<string, unknown[]> = {}): {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
} {
  return {
    query: async (sql: string) => {
      if (sql in overrides) return { rows: overrides[sql] as Record<string, unknown>[] };
      if (sql.includes("LEFT JOIN")) return { rows: [{ n: 0 }] };
      const table = Object.values(TABLE_LOADERS).find((def) =>
        sql.includes(`FROM ${def.table}`),
      );
      if (sql.startsWith("SELECT COUNT(*)") && table) {
        return { rows: [{ n: 10 }] };
      }
      throw new Error(`unstubbed query: ${sql}`);
    },
  };
}

describe("runChecks exit contract", () => {
  const seeds = loadSeeds(
    seedsJson({
      scenarios_uc05: [
        { ...VALID_ENTRY, id: "uc05-a", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "uc05-b", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "uc05-c", reference_sql: "SELECT 0.0 AS v" },
      ],
      anomalies_uc10: [
        { ...VALID_ENTRY, id: "uc10-a", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "uc10-b", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "uc10-c", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "uc10-d", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "uc10-e", reference_sql: "SELECT 0.0 AS v" },
      ],
      injections: [
        { ...VALID_ENTRY, id: "inj-a", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "inj-b", reference_sql: "SELECT 0.0 AS v" },
        { ...VALID_ENTRY, id: "inj-c", reference_sql: "SELECT 0.0 AS v" },
      ],
    }),
  );
  const manifestFor = (rows: number): Record<string, { rows: number }> =>
    Object.fromEntries(
      Object.keys(TABLE_LOADERS).map((name) => [name, { rows }]),
    );

  it("passes on consistent counts with zero orphans", async () => {
    const report = await runChecks(
      stubClient(),
      { tables: manifestFor(10) },
      { ...seeds, scenarios_uc05: [], anomalies_uc10: [], injections: [] },
      "olist-vi-2025-2026-v1-small",
    );
    expect(report.failures).toEqual([]);
    expect(report.checkedTables).toBe(12);
  });

  it("fails naming the table on a count mismatch", async () => {
    const report = await runChecks(
      stubClient(),
      { tables: manifestFor(11) },
      { ...seeds, scenarios_uc05: [], anomalies_uc10: [], injections: [] },
      "olist-vi-2025-2026-v1-small",
    );
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]).toContain("public.regions");
  });

  it("fails on an unregistered scenario id (fail-closed assertion map)", async () => {
    const report = await runChecks(
      stubClient({ "SELECT 0.0 AS v": [{ v: 0 }] }),
      { tables: manifestFor(10) },
      seeds,
      "olist-vi-2025-2026-v1-small",
    );
    expect(
      report.failures.some((message) =>
        message.includes("no assertion rule registered"),
      ),
    ).toBe(true);
  });
});

describe.skipIf(!process.env["OWNER_DATABASE_URL"])(
  "data:verify live assertions",
  () => {
    it("runs the real checks against the loaded DB", async () => {
      const { createOwnerPool } = await import("../src/copy.js");
      const { readManifest, manifestPathFor } = await import(
        "../src/manifest.js"
      );
      const { loadSeedsFile } = await import("../src/seeds.js");
      // DATA_SCALE=small when the live DB holds the small-scale load (CI).
      const scale = process.env["DATA_SCALE"] === "small" ? "small" : "full";
      const manifest = readManifest(manifestPathFor(scale));
      const pool = createOwnerPool();
      try {
        const client = await pool.connect();
        try {
          const report = await runChecks(
            { query: (sql: string) => client.query(sql) },
            manifest,
            loadSeedsFile(),
            manifest.dataset_version,
          );
          expect(report.failures).toEqual([]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    }, 120000);
  },
);
