// Pure Vietnamization transforms (Phase 2, plan 02-02, D-01). Data in,
// data out: no `pg` and no `node:fs` imports — the sql-guard purity rule
// applied to the input layer so UC owners can read every mapping without
// touching loader or database code.
//
// Determinism contract: every function here is total and pure. The only
// randomness in the pipeline flows through `createSeededFaker(seed)` — never
// Math.random or Date.now (Pitfall P7).
import { base, en, Faker, vi } from "@faker-js/faker";
import {
  BRL_TO_VND_RATE,
  CATEGORY_VI_BY_EN,
  DATASET_MIN_DATE,
  PROVINCES,
  REGION_GROUPS,
  SHIFT_DAYS,
  STATE_TO_PROVINCE,
  UNMAPPED_CATEGORY_FALLBACKS,
} from "./constants.js";

export {
  BRL_TO_VND_RATE,
  CATEGORY_VI_BY_EN,
  DATASET_MIN_DATE,
  PROVINCES,
  REGION_GROUPS,
  SHIFT_DAYS,
  STATE_TO_PROVINCE,
  UNMAPPED_CATEGORY_FALLBACKS,
};

// 34 post-merger provinces (Res. 202/2025/QH15, effective 2025-07-01) grouped
// into the three Bắc/Trung/Nam regions per D-01. Same rows as the regions
// TABLE_LOADERS slice in load.ts; Task 3 asserts they stay in sync.

// Deterministic map of all 27 Olist state codes to Vietnamese provinces.
// Ordered alphabetically on both sides so the assignment is reviewable; every
// value is a member of PROVINCES. Provinces beyond the first 27 (Đồng Tháp,
// An Giang, Vĩnh Long, Cần Thơ, Cà Mau, plus two Nam spares) carry no Olist
// code and are populated by synthetic expansion in plan 02-03.

export function stateToProvince(stateCode: string): string {
  const province = STATE_TO_PROVINCE[stateCode];
  if (!province) {
    throw new Error(
      `Unknown Olist state code "${stateCode}" — expected one of the 27 mapped codes`,
    );
  }
  return province;
}

export function regionOfProvince(province: string): string {
  const entry = PROVINCES.find(([name]) => name === province);
  if (!entry) {
    throw new Error(
      `Unknown province "${province}" — expected one of the 34 post-merger provinces`,
    );
  }
  return entry[1];
}

// English (translation-CSV) to Vietnamese category map. All 71 english names
// from product_category_name_translation.csv are covered; the three values
// the join cannot produce (Pitfall P4) fall back explicitly below.

// Explicit fallbacks for the three product_category_name values the
// translation join cannot produce (Pitfall P4, measured in RESEARCH).

// Portuguese product_category_name (plus its english translation) to
// Vietnamese. Never returns null or empty: blank input becomes
// "Chưa phân loại", the two unmapped codes use their explicit fallbacks,
// any other unknown english name becomes "Khác" (fail-open on display text,
// fail-closed on shape via the seeds schema).
export function translateCategory(
  ptName: string | null | undefined,
  enName?: string | null,
): string {
  if (ptName === null || ptName === undefined || ptName.trim() === "") {
    return "Chưa phân loại";
  }
  const fallback = UNMAPPED_CATEGORY_FALLBACKS[ptName];
  if (fallback) return fallback;
  if (enName !== null && enName !== undefined && enName !== "") {
    const mapped = CATEGORY_VI_BY_EN[enName];
    if (mapped) return mapped;
  }
  return "Khác";
}

// Fixed VND conversion: round(BRL × 5150 / 1000) × 1000. Rate ≈ Oct-2025
// market 5,095–5,162, documented as a constant in README per DATA-07.

export function brlToVnd(brl: number): number {
  return Math.round((brl * BRL_TO_VND_RATE) / 1000) * 1000;
}

// Date shift: +2905 days (415 weeks — weekday-preserving by construction,
// verified Wed→Wed in RESEARCH), applied in UTC. Orders landing before
// 2025-01-01 are clipped (return null) per Pitfall P5 so 2027 stays empty
// and Sept-2026 scenarios land in-window. Accepts "YYYY-MM-DD" or
// "YYYY-MM-DD HH:MM:SS" (space or T separator), preserving the time part.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2}):(\d{2}))?$/;

export function shiftOrderDate(input: string): string | null {
  const match = DATE_RE.exec(input.trim());
  if (!match) {
    throw new Error(
      `Unparseable order date "${input}" — expected YYYY-MM-DD or YYYY-MM-DD HH:MM:SS`,
    );
  }
  const [, y, mo, d, , hh, mi, ss] = match;
  const base = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? "00"),
    Number(mi ?? "00"),
    Number(ss ?? "00"),
  );
  const shifted = new Date(base + SHIFT_DAYS * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const datePart = `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  if (datePart < DATASET_MIN_DATE) return null;
  if (hh === undefined) return datePart;
  return `${datePart} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

// The eight measured Olist order statuses folded into the three business
// statuses. `returned` never comes from Olist — it is reserved for anomaly
// injection only (UC-10 A1). Unknown statuses throw fail-fast so data drift
// surfaces at load instead of silently becoming canceled.
const ORDER_STATUS_FOLD: Readonly<Record<string, string>> = {
  delivered: "delivered",
  shipped: "shipped",
  canceled: "canceled",
  unavailable: "canceled",
  invoiced: "canceled",
  processing: "canceled",
  created: "canceled",
  approved: "canceled",
};

export type BusinessOrderStatus = "delivered" | "shipped" | "canceled";

export function foldOrderStatus(status: string): BusinessOrderStatus {
  const folded = ORDER_STATUS_FOLD[status];
  if (!folded) {
    throw new Error(
      `Unknown Olist order status "${status}" — expected one of the eight measured statuses`,
    );
  }
  return folded as BusinessOrderStatus;
}

// Synthetic PII factory (Pitfall P7): `[vi, en, base]` locale chain so thin
// `vi` coverage falls back silently, with a single `faker.seed(seed)` as the
// only RNG in the pipeline. Callers draw every random decision from the
// returned instance.
export function createSeededFaker(seed: number): Faker {
  const faker = new Faker({ locale: [vi, en, base] });
  faker.seed(seed);
  return faker;
}
