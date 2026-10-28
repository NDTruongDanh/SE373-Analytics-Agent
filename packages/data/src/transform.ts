// Pure Vietnamization transforms (Phase 2, plan 02-02, D-01). Data in,
// data out: no `pg` and no `node:fs` imports — the sql-guard purity rule
// applied to the input layer so UC owners can read every mapping without
// touching loader or database code.
//
// Determinism contract: every function here is total and pure. The only
// randomness in the pipeline flows through `createSeededFaker(seed)` — never
// Math.random or Date.now (Pitfall P7).
import { base, en, Faker, vi } from "@faker-js/faker";

// 34 post-merger provinces (Res. 202/2025/QH15, effective 2025-07-01) grouped
// into the three Bắc/Trung/Nam regions per D-01. Same rows as the regions
// TABLE_LOADERS slice in load.ts; Task 3 asserts they stay in sync.
export const PROVINCES: readonly (readonly [string, string])[] = [
  ["Hà Nội", "Bắc"],
  ["Hải Phòng", "Bắc"],
  ["Lai Châu", "Bắc"],
  ["Điện Biên", "Bắc"],
  ["Sơn La", "Bắc"],
  ["Lạng Sơn", "Bắc"],
  ["Cao Bằng", "Bắc"],
  ["Tuyên Quang", "Bắc"],
  ["Lào Cai", "Bắc"],
  ["Thái Nguyên", "Bắc"],
  ["Phú Thọ", "Bắc"],
  ["Bắc Ninh", "Bắc"],
  ["Hưng Yên", "Bắc"],
  ["Ninh Bình", "Bắc"],
  ["Quảng Ninh", "Bắc"],
  ["Thanh Hóa", "Trung"],
  ["Nghệ An", "Trung"],
  ["Hà Tĩnh", "Trung"],
  ["Quảng Trị", "Trung"],
  ["Huế", "Trung"],
  ["Đà Nẵng", "Trung"],
  ["Quảng Ngãi", "Trung"],
  ["Gia Lai", "Trung"],
  ["Khánh Hòa", "Trung"],
  ["Lâm Đồng", "Trung"],
  ["Đắk Lắk", "Trung"],
  ["Đồng Nai", "Nam"],
  ["Tây Ninh", "Nam"],
  ["TP.HCM", "Nam"],
  ["Đồng Tháp", "Nam"],
  ["An Giang", "Nam"],
  ["Vĩnh Long", "Nam"],
  ["Cần Thơ", "Nam"],
  ["Cà Mau", "Nam"],
];

export const REGION_GROUPS: readonly string[] = ["Bắc", "Trung", "Nam"];

// Deterministic map of all 27 Olist state codes to Vietnamese provinces.
// Ordered alphabetically on both sides so the assignment is reviewable; every
// value is a member of PROVINCES. Provinces beyond the first 27 (Đồng Tháp,
// An Giang, Vĩnh Long, Cần Thơ, Cà Mau, plus two Nam spares) carry no Olist
// code and are populated by synthetic expansion in plan 02-03.
export const STATE_TO_PROVINCE: Readonly<Record<string, string>> = {
  AC: "Hà Nội",
  AL: "Hải Phòng",
  AM: "Lai Châu",
  AP: "Điện Biên",
  BA: "Sơn La",
  CE: "Lạng Sơn",
  DF: "Cao Bằng",
  ES: "Tuyên Quang",
  GO: "Lào Cai",
  MA: "Thái Nguyên",
  MG: "Phú Thọ",
  MS: "Bắc Ninh",
  MT: "Hưng Yên",
  PA: "Ninh Bình",
  PB: "Quảng Ninh",
  PE: "Thanh Hóa",
  PI: "Nghệ An",
  PR: "Hà Tĩnh",
  RJ: "Quảng Trị",
  RN: "Huế",
  RO: "Đà Nẵng",
  RR: "Quảng Ngãi",
  RS: "Gia Lai",
  SC: "Khánh Hòa",
  SE: "Lâm Đồng",
  SP: "Đắk Lắk",
  TO: "Đồng Nai",
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

// English (translation-CSV) to Vietnamese category map. All 71 english names
// from product_category_name_translation.csv are covered; the three values
// the join cannot produce (Pitfall P4) fall back explicitly below.
export const CATEGORY_VI_BY_EN: Readonly<Record<string, string>> = {
  health_beauty: "Sức khỏe & Làm đẹp",
  computers_accessories: "Phụ kiện máy tính",
  auto: "Ô tô & Phụ tùng",
  bed_bath_table: "Chăn ga gối nệm",
  furniture_decor: "Nội thất & Trang trí",
  sports_leisure: "Thể thao & Giải trí",
  perfumery: "Nước hoa & Mỹ phẩm",
  housewares: "Đồ gia dụng",
  telephony: "Điện thoại",
  watches_gifts: "Đồng hồ & Quà tặng",
  food_drink: "Thực phẩm & Đồ uống",
  baby: "Mẹ & Bé",
  stationery: "Văn phòng phẩm",
  tablets_printing_image: "Máy tính bảng & In ấn",
  toys: "Đồ chơi",
  fixed_telephony: "Điện thoại cố định",
  garden_tools: "Dụng cụ làm vườn",
  fashion_bags_accessories: "Túi xách & Phụ kiện thời trang",
  small_appliances: "Thiết bị gia dụng nhỏ",
  consoles_games: "Máy chơi game",
  audio: "Âm thanh",
  fashion_shoes: "Giày dép thời trang",
  cool_stuff: "Đồ độc lạ",
  luggage_accessories: "Vali & Phụ kiện du lịch",
  air_conditioning: "Điều hòa không khí",
  construction_tools_construction: "Dụng cụ xây dựng",
  kitchen_dining_laundry_garden_furniture: "Nội thất bếp & Sân vườn",
  costrution_tools_garden: "Dụng cụ sân vườn",
  fashion_male_clothing: "Thời trang nam",
  pet_shop: "Thú cưng",
  office_furniture: "Nội thất văn phòng",
  market_place: "Chợ tổng hợp",
  electronics: "Điện tử",
  home_appliances: "Điện gia dụng",
  party_supplies: "Đồ dùng tiệc tùng",
  home_confort: "Tiện nghi gia đình",
  costrution_tools_tools: "Dụng cụ cầm tay",
  agro_industry_and_commerce: "Nông công nghiệp",
  furniture_mattress_and_upholstery: "Nệm & Bọc nệm",
  books_technical: "Sách kỹ thuật",
  home_construction: "Xây dựng nhà cửa",
  musical_instruments: "Nhạc cụ",
  furniture_living_room: "Nội thất phòng khách",
  construction_tools_lights: "Đèn & Chiếu sáng",
  industry_commerce_and_business: "Công nghiệp & Thương mại",
  food: "Thực phẩm",
  art: "Nghệ thuật",
  furniture_bedroom: "Nội thất phòng ngủ",
  books_general_interest: "Sách tổng hợp",
  construction_tools_safety: "Thiết bị an toàn lao động",
  fashion_underwear_beach: "Đồ lót & Đồ biển",
  fashion_sport: "Thời trang thể thao",
  signaling_and_security: "Biển báo & An ninh",
  computers: "Máy tính",
  christmas_supplies: "Đồ Giáng sinh",
  fashio_female_clothing: "Thời trang nữ",
  home_appliances_2: "Điện gia dụng (2)",
  books_imported: "Sách ngoại văn",
  drinks: "Đồ uống",
  cine_photo: "Máy ảnh & Quay phim",
  la_cuisine: "Dụng cụ bếp cao cấp",
  music: "Âm nhạc",
  home_comfort_2: "Tiện nghi gia đình (2)",
  small_appliances_home_oven_and_coffee: "Lò nướng & Máy pha cà phê",
  cds_dvds_musicals: "Đĩa nhạc & Phim",
  dvds_blu_ray: "Đĩa DVD & Blu-ray",
  flowers: "Hoa tươi",
  arts_and_craftmanship: "Thủ công mỹ nghệ",
  diapers_and_hygiene: "Tã & Vệ sinh",
  fashion_childrens_clothes: "Thời trang trẻ em",
  security_and_services: "Bảo hiểm & Dịch vụ",
};

// Explicit fallbacks for the three product_category_name values the
// translation join cannot produce (Pitfall P4, measured in RESEARCH).
export const UNMAPPED_CATEGORY_FALLBACKS: Readonly<Record<string, string>> = {
  "": "Chưa phân loại",
  pc_gamer: "Máy tính & Linh kiện",
  portateis_cozinha_e_preparadores_de_alimentos: "Thiết bị nhà bếp",
};

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
export const BRL_TO_VND_RATE = 5150;

export function brlToVnd(brl: number): number {
  return Math.round((brl * BRL_TO_VND_RATE) / 1000) * 1000;
}

// Date shift: +2905 days (415 weeks — weekday-preserving by construction,
// verified Wed→Wed in RESEARCH), applied in UTC. Orders landing before
// 2025-01-01 are clipped (return null) per Pitfall P5 so 2027 stays empty
// and Sept-2026 scenarios land in-window. Accepts "YYYY-MM-DD" or
// "YYYY-MM-DD HH:MM:SS" (space or T separator), preserving the time part.
export const SHIFT_DAYS = 2905;
export const DATASET_MIN_DATE = "2025-01-01";

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
