// Pure unit tests for the Vietnamization input layer (Phase 2, plan 02-02).
// No database: every case runs in CI. Follows the sql-guard pure-test idiom
// (guard.test.ts): named cases, direct return-value asserts, one shared
// helper for the rejection matrix.
import { describe, expect, it } from "vitest";
import {
  compareManifests,
  hashCanonicalCsv,
} from "../src/manifest.js";
import {
  BRL_TO_VND_RATE,
  brlToVnd,
  CATEGORY_VI_BY_EN,
  createSeededFaker,
  foldOrderStatus,
  PROVINCES,
  REGION_GROUPS,
  regionOfProvince,
  shiftOrderDate,
  STATE_TO_PROVINCE,
  stateToProvince,
  translateCategory,
  UNMAPPED_CATEGORY_FALLBACKS,
} from "../src/transform.js";

describe("state to province map", () => {
  it("resolves all 27 Olist state codes into the 34 provinces", () => {
    expect(Object.keys(STATE_TO_PROVINCE)).toHaveLength(27);
    const provinces = new Set(PROVINCES.map(([name]) => name));
    expect(provinces.size).toBe(34);
    for (const code of Object.keys(STATE_TO_PROVINCE)) {
      expect(provinces.has(stateToProvince(code))).toBe(true);
    }
  });

  it("carries a valid Bac Trung Nam region group on every province", () => {
    expect(REGION_GROUPS).toEqual(["Bắc", "Trung", "Nam"]);
    for (const [name] of PROVINCES) {
      expect(REGION_GROUPS).toContain(regionOfProvince(name));
    }
  });

  it("rejects an unknown state code fail-fast", () => {
    expect(() => stateToProvince("XX")).toThrow();
  });
});

describe("category translation", () => {
  it("covers all 71 english names with non-empty Vietnamese text", () => {
    expect(Object.keys(CATEGORY_VI_BY_EN)).toHaveLength(71);
    for (const vi of Object.values(CATEGORY_VI_BY_EN)) {
      expect(vi.length).toBeGreaterThan(0);
    }
  });

  it("falls back explicitly for the three unmapped values (P4)", () => {
    expect(UNMAPPED_CATEGORY_FALLBACKS).toEqual({
      "": "Chưa phân loại",
      pc_gamer: "Máy tính & Linh kiện",
      portateis_cozinha_e_preparadores_de_alimentos: "Thiết bị nhà bếp",
    });
    expect(translateCategory("")).toBe("Chưa phân loại");
    expect(translateCategory(null)).toBe("Chưa phân loại");
    expect(translateCategory("pc_gamer")).toBe("Máy tính & Linh kiện");
    expect(
      translateCategory("portateis_cozinha_e_preparadores_de_alimentos"),
    ).toBe("Thiết bị nhà bếp");
  });

  it("never returns a NULL or empty category", () => {
    expect(translateCategory("cama_mesa_banho", "bed_bath_table")).toBe(
      "Chăn ga gối nệm",
    );
    expect(translateCategory("unknown_pt", "unknown_en")).toBe("Khác");
    expect(translateCategory("unknown_pt")).toBe("Khác");
  });
});

describe("date shift", () => {
  it("shifts exactly plus 2905 days and preserves the weekday", () => {
    // 2018-10-17 (Wed) + 2905d = 2026-09-30 (Wed): max Olist date lands
    // in-window at the end of September 2026.
    expect(shiftOrderDate("2018-10-17")).toBe("2026-09-30");
    for (const date of ["2017-06-15", "2018-01-01", "2018-10-17"]) {
      const shifted = shiftOrderDate(date);
      expect(shifted).not.toBeNull();
      expect(new Date(`${shifted}T00:00:00Z`).getUTCDay()).toBe(
        new Date(`${date}T00:00:00Z`).getUTCDay(),
      );
    }
  });

  it("clips pre-2025 rows on the exact boundary", () => {
    // 2017-01-18 + 2905d = 2025-01-01 (kept); one day earlier clips.
    expect(shiftOrderDate("2017-01-18")).toBe("2025-01-01");
    expect(shiftOrderDate("2017-01-17")).toBeNull();
    expect(shiftOrderDate("2016-09-04")).toBeNull();
  });

  it("preserves the time part of timestamps", () => {
    expect(shiftOrderDate("2018-10-17 12:00:00")).toBe(
      "2026-09-30 12:00:00",
    );
  });

  it("rejects unparseable dates fail-fast", () => {
    expect(() => shiftOrderDate("not-a-date")).toThrow();
  });
});

describe("currency and status folds", () => {
  it("converts BRL to VND at the fixed 5150 rate rounded to thousands", () => {
    expect(BRL_TO_VND_RATE).toBe(5150);
    expect(brlToVnd(100)).toBe(515000);
    expect(brlToVnd(29.9)).toBe(154000);
  });

  it("folds the eight Olist statuses into delivered, shipped, canceled", () => {
    expect(foldOrderStatus("delivered")).toBe("delivered");
    expect(foldOrderStatus("shipped")).toBe("shipped");
    for (const status of [
      "canceled",
      "unavailable",
      "invoiced",
      "processing",
      "created",
      "approved",
    ]) {
      expect(foldOrderStatus(status)).toBe("canceled");
    }
    expect(() => foldOrderStatus("returned")).toThrow();
  });
});

describe("seeded faker determinism", () => {
  it("produces identical PII sequences across two instances with one seed", () => {
    const first = createSeededFaker(42);
    const second = createSeededFaker(42);
    const draw = (faker: ReturnType<typeof createSeededFaker>): string[] => [
      faker.person.fullName(),
      faker.phone.number(),
      faker.internet.email(),
      faker.location.streetAddress(),
      String(faker.number.int({ min: 1_000_000, max: 50_000_000 })),
    ];
    const a = [draw(first), draw(first), draw(first)];
    const b = [draw(second), draw(second), draw(second)];
    expect(a).toEqual(b);
  });
});

describe("manifest hash stability", () => {
  it("hashes a fixed row set deterministically and avalanches on change", () => {
    const rows = "a,1\nb,2";
    expect(hashCanonicalCsv(rows)).toBe(hashCanonicalCsv(rows));
    expect(hashCanonicalCsv(rows)).not.toBe(hashCanonicalCsv("a,1\nb,3"));
    expect(compareManifests(
      {
        version: 1,
        seed: 42,
        dataset_version: "x",
        tables: { t: { rows: 2, sha256: hashCanonicalCsv(rows) } },
      },
      {
        version: 1,
        seed: 42,
        dataset_version: "x",
        tables: { t: { rows: 2, sha256: hashCanonicalCsv(rows) } },
      },
    )).toEqual([]);
  });
});
