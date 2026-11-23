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

export function brlToVnd(brl: number): number {
  return Math.round((brl * BRL_TO_VND_RATE) / 1000) * 1000;
}

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

// 'returned' is reserved for anomaly injection; unknown statuses throw so data drift surfaces at load.
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

// Locale chain falls back vi -> en -> base where Faker's vi locale is sparse.
export function createSeededFaker(seed: number): Faker {
  const faker = new Faker({ locale: [vi, en, base] });
  faker.seed(seed);
  return faker;
}
