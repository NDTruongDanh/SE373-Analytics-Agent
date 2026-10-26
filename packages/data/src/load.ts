// Full deterministic loader (Phase 2, plan 02-03, D-01/D-02/D-04/D-10/D-11):
// downloads all eight Olist CSVs into data/.cache/, stream-parses them with
// csv-parse, Vietnamizes every row through transform.ts maps row by row, and
// COPY-loads all twelve business tables through the copy.ts owner helpers
// inside owner transactions. After the base load it expands at order level
// (whole-order clones roughly nine times plus a top-up until order_items
// reaches 1,000,000 rows), then injects the seeds.json scenarios last per
// Pitfall P6 as data mutations (UC-05 deletes/updates, UC-10 anomaly and
// returned-status synthesis, injection product rows), and finally computes
// per-table row counts plus canonical ORDER BY pk hashes, compares the
// overlapping tables against any existing data/seed_manifest.json (refusing
// to finish on mismatch), and writes the merged manifest.
//
// Data-only by D-10: zero DDL here (schema lives in 03_public.sql). No
// schema-catalog export by D-11: data:catalog is deferred to Phase 4.
//
// Determinism contract: the single seeded faker instance created per dataset
// build is the ONLY RNG (never Math.random/Date.now). Same SEED_DATA plus
// the same pinned publisher bytes always yields byte-identical manifests.
//
// Scale: `pnpm data:load` runs the full pipeline (nine expansion passes,
// 1M order_items, ~6 min). `pnpm data:load --scale=small` runs the same
// pipeline with one pass and a 60k target (<2 min, CI per D-10); the FK
// graph, seed scenarios, and reload gate are identical, only volumes shrink.
// The scale is recorded in dataset_version, so a scale switch fails the
// reload gate loudly — delete data/seed_manifest.json when switching scale.
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Faker, base, en, vi } from "@faker-js/faker";
import { parse } from "csv-parse";
import type { Pool, PoolClient } from "pg";
import { copyTable, createOwnerPool, withOwnerTx } from "./copy.js";
import {
  downloadAll,
  OLIST_FILES,
  resolveCacheDir,
} from "./download.js";
import {
  compareManifests,
  DATASET_VERSION,
  DEFAULT_MANIFEST_PATH,
  hashCanonicalCsv,
  readManifest,
  type SeedManifest,
  writeManifest,
} from "./manifest.js";
import { loadSeedsFile } from "./seeds.js";
import {
  brlToVnd,
  CATEGORY_VI_BY_EN,
  createSeededFaker,
  foldOrderStatus,
  regionOfProvince,
  shiftOrderDate,
  stateToProvince,
  translateCategory,
  UNMAPPED_CATEGORY_FALLBACKS,
} from "./transform.js";

const SEED = Number(process.env["SEED_DATA"] ?? 42);

// Legacy module-level instance (Phase 2, plan 02-01): kept so existing
// importers keep working. The pipeline itself mints one fresh seeded faker
// per dataset build, so repeated builds in one process stay deterministic.
export const faker = new Faker({ locale: [vi, en, base] });
faker.seed(SEED);

export interface TableDef {
  table: string;
  columns: readonly string[];
  pk: string;
}

// Registry of every loadable table: physical name, COPY column order, and
// the pk used for the canonical ORDER BY in the manifest hash. Table and
// column names come from here — never from user input (copy.ts contract).
export const TABLE_LOADERS: Record<string, TableDef> = {
  regions: {
    table: "public.regions",
    columns: ["province", "region_group"] as const,
    pk: "province",
  },
  categories: {
    table: "public.categories",
    columns: ["category_id", "name_vi"] as const,
    pk: "category_id",
  },
  channels: {
    table: "public.channels",
    columns: ["channel_id", "channel_name"] as const,
    pk: "channel_id",
  },
  promotions: {
    table: "public.promotions",
    columns: ["promotion_id", "name", "starts_on", "ends_on", "discount_pct"] as const,
    pk: "promotion_id",
  },
  employees: {
    table: "public.employees",
    columns: ["employee_id", "name", "salary", "province"] as const,
    pk: "employee_id",
  },
  customers: {
    table: "public.customers",
    columns: ["customer_id", "name", "phone", "email", "address", "province", "region_group"] as const,
    pk: "customer_id",
  },
  sellers: {
    table: "public.sellers",
    columns: ["seller_id", "province", "region_group"] as const,
    pk: "seller_id",
  },
  products: {
    table: "public.products",
    columns: ["product_id", "category_id", "name", "price_vnd", "weight_g", "length_cm", "height_cm", "width_cm"] as const,
    pk: "product_id",
  },
  orders: {
    table: "public.orders",
    columns: ["order_id", "customer_id", "channel_id", "status", "purchase_date"] as const,
    pk: "order_id",
  },
  order_items: {
    table: "public.order_items",
    // Identity pk (order_item_id) is DB-assigned; COPY excludes it. The
    // manifest still orders by it, which is insertion order — deterministic
    // because the build order is fixed.
    columns: ["order_id", "product_id", "seller_id", "price_vnd", "freight_vnd"] as const,
    pk: "order_item_id",
  },
  payments: {
    table: "public.payments",
    columns: ["order_id", "payment_type", "installments", "value_vnd"] as const,
    pk: "payment_id",
  },
  reviews: {
    table: "public.reviews",
    columns: ["review_id", "order_id", "score", "title", "message", "created_at"] as const,
    pk: "review_id",
  },
};

// FK-safe load order: parents before children. Reset runs this in reverse.
const LOAD_ORDER = [
  "regions",
  "categories",
  "channels",
  "promotions",
  "employees",
  "customers",
  "sellers",
  "products",
  "orders",
  "order_items",
  "payments",
  "reviews",
] as const;

// 34 post-merger provinces (Res. 202/2025/QH15, effective 2025-07-01) grouped
// into the three Bắc/Trung/Nam regions per D-01. Mirrors PROVINCES in
// transform.ts (same source of truth, asserted in sync by construction).
export const REGION_ROWS: (readonly [string, string])[] = [
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

const CHANNEL_ROWS: (readonly [string, string])[] = [
  ["shopee", "Shopee"],
  ["lazada", "Lazada"],
  ["tiktok", "TikTok Shop"],
  ["website", "Website"],
  ["cuahang", "Cửa hàng"],
];
const CHANNEL_IDS = CHANNEL_ROWS.map(([id]) => id);

// Weighted spread cycle for the seven Olist-unmapped provinces plus the two
// thin scenario provinces (Đà Nẵng, Hà Nội). Every 4th customer/seller is
// reassigned to the next entry, so all 34 provinces carry real base volume
// and the seeded TP.HCM / Đà Nẵng / Hà Nội scenarios have measurable
// baselines. Deterministic by construction (fixed cycle, file order).
const SPREAD_CYCLE: readonly string[] = [
  "TP.HCM", "TP.HCM", "TP.HCM", "TP.HCM", "TP.HCM", "TP.HCM",
  "Đà Nẵng", "Đà Nẵng", "Đà Nẵng",
  "Hà Nội", "Hà Nội", "Hà Nội",
  "Cần Thơ", "Cần Thơ",
  "An Giang", "An Giang",
  "Đồng Tháp", "Đồng Tháp",
  "Vĩnh Long", "Vĩnh Long",
  "Tây Ninh", "Tây Ninh",
  "Cà Mau", "Cà Mau",
];

export type LoadScale = "full" | "small";

export function parseLoadScale(argv: readonly string[]): LoadScale {
  const flag = argv.find((arg) => arg.startsWith("--scale="));
  if (!flag) return "full";
  const scale = flag.slice("--scale=".length);
  if (scale !== "full" && scale !== "small") {
    throw new Error(
      `Unknown --scale "${scale}" — expected "full" or "small"`,
    );
  }
  return scale;
}

// Small scale (CI per D-10): one expansion pass and a 60k-item top-up target
// instead of nine passes plus the 1M target, so `data:load && data:verify`
// finishes in under 2 minutes. The full FK graph, every seed scenario, and
// the manifest reload gate are unchanged — only absolute volumes shrink, and
// every seed magnitude is a ratio engineered against its own baseline.
export const EXPANSION_PASSES: Record<LoadScale, number> = {
  full: 9,
  small: 1,
};
export const EXPANSION_ITEM_TARGET: Record<LoadScale, number> = {
  full: 1_000_000,
  small: 60_000,
};

export function datasetVersionFor(scale: LoadScale): string {
  return scale === "small" ? `${DATASET_VERSION}-small` : DATASET_VERSION;
}

function parseTablesFilter(argv: readonly string[]): string[] {
  const flag = argv.find((arg) => arg.startsWith("--tables="));
  if (!flag) return [...LOAD_ORDER];
  const wanted = flag
    .slice("--tables=".length)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  for (const name of wanted) {
    if (!TABLE_LOADERS[name]) {
      throw new Error(
        `Unknown table "${name}" — registered: ${Object.keys(TABLE_LOADERS).join(", ")}`,
      );
    }
  }
  // Keep FK-safe order regardless of flag order.
  return LOAD_ORDER.filter((name) => wanted.includes(name));
}

// Stream-parse one cached CSV with csv-parse (columns from the header row,
// BOM honored per the download registry). Rows come out in file order, which
// keeps every downstream draw deterministic.
function readCachedCsv(
  cacheDir: string,
  name: string,
): Promise<Record<string, string>[]> {
  const entry = OLIST_FILES.find((file) => file.name === name);
  const bom = entry?.bom ?? false;
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    const parser = parse({
      columns: true,
      bom,
      skip_empty_lines: true,
      trim: false,
    });
    parser.on("readable", () => {
      let record: unknown;
      while ((record = parser.read()) !== null) {
        rows.push(record as Record<string, string>);
      }
    });
    parser.on("error", (err: unknown) => {
      reject(
        err instanceof Error
          ? new Error(`Failed to parse cached ${name}: ${err.message}`)
          : new Error(`Failed to parse cached ${name}: ${String(err)}`),
      );
    });
    parser.on("end", () => resolve(rows));
    const source = createReadStream(join(cacheDir, name), { encoding: "utf8" });
    source.on("error", (err) => {
      reject(new Error(`Failed to read cached ${name}: ${err.message}`));
    });
    source.pipe(parser);
  });
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const intOrNull = (value: unknown): number | null => {
  const text = str(value).trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

// ---- In-memory working set (post-expansion, pre-COPY) ----

interface BuiltOrder {
  id: string;
  customerId: string;
  channelId: string;
  status: string;
  purchaseDate: string; // "YYYY-MM-DD HH:MM:SS" UTC
}

// order_items COPY columns: order_id, product_id, seller_id, price_vnd, freight_vnd
type BuiltItem = [string, string, string, number, number];
// payments COPY columns: order_id, payment_type, installments, value_vnd
type BuiltPayment = [string, string, number, number];
interface BuiltReview {
  id: string;
  orderId: string;
  score: number;
  title: string;
  message: string;
  createdAt: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export interface BuildStats {
  clippedOrders: number;
  skippedItems: number;
  skippedPayments: number;
  skippedReviews: number;
  duplicateReviews: number;
  expansionPasses: number;
  topUpClones: number;
  injectionNotes: string[];
}

async function buildDataset(
  tableNames: readonly string[],
  cacheDir: string,
  scale: LoadScale = "full",
): Promise<{ rows: Map<string, (readonly unknown[])[]>; stats: BuildStats }> {
  const wanted = new Set(tableNames);
  const full = LOAD_ORDER.every((name) => wanted.has(name));
  // -- Partial loads (non-full table sets) are iteration-only: they build
  // just the requested tables and skip the manifest gate below, leaving the
  // stored manifest untouched. Child-row FK filtering is tolerant when the
  // parent table is not part of this build (the database FKs then enforce
  // truthfully at COPY time). Run a full load before verify.
  const ordersBuilt = wanted.has("orders");
  const rng = createSeededFaker(SEED);
  const stats: BuildStats = {
    clippedOrders: 0,
    skippedItems: 0,
    skippedPayments: 0,
    skippedReviews: 0,
    duplicateReviews: 0,
    expansionPasses: 0,
    topUpClones: 0,
    injectionNotes: [],
  };
  const rows = new Map<string, (readonly unknown[])[]>();

  // -- Static synthetic tables (no CSV, no RNG) --
  if (wanted.has("regions")) {
    rows.set("regions", REGION_ROWS.map(([a, b]) => [a, b] as const));
  }
  if (wanted.has("channels")) {
    rows.set("channels", CHANNEL_ROWS.map(([a, b]) => [a, b] as const));
  }
  if (wanted.has("promotions")) {
    // 30 deterministic promos cycling 2025-01..2026-09: name, month span,
    // discount from a fixed ladder. Standalone (no FKs) per research.
    const discounts = [5, 10, 15, 20, 25, 30];
    const out: (readonly unknown[])[] = [];
    for (let i = 0; i < 30; i++) {
      const monthIndex = i % 21; // 21 months: 2025-01 .. 2026-09
      const year = 2025 + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const mm = String(month).padStart(2, "0");
      const discount = discounts[i % discounts.length];
      if (discount === undefined) throw new Error("unreachable discount ladder");
      out.push([
        `promo-${String(i + 1).padStart(3, "0")}`,
        `Ưu đãi tháng ${mm}/${String(year)} −${String(discount)}%`,
        `${String(year)}-${mm}-01`,
        `${String(year)}-${mm}-${String(lastDay).padStart(2, "0")}`,
        discount,
      ]);
    }
    rows.set("promotions", out);
  }
  if (wanted.has("employees")) {
    // ~200 synthetic employees; province cycles the 34 so every region group
    // is covered. Names + salaries flow from the single seeded faker.
    const out: (readonly unknown[])[] = [];
    for (let i = 0; i < 200; i++) {
      const province = REGION_ROWS[i % REGION_ROWS.length];
      if (!province) throw new Error("unreachable province cycle");
      out.push([
        `emp-${String(i + 1).padStart(4, "0")}`,
        rng.person.fullName(),
        rng.number.int({ min: 8_000_000, max: 60_000_000 }),
        province[0],
      ]);
    }
    rows.set("employees", out);
  }

  // -- Categories from the translation CSV (71 EN→VI + fallbacks) --
  // category_id is the EN key for mapped rows and a stable fallback: id
  // otherwise, so products can resolve PT names without touching the DB.
  let ptToCategoryId = new Map<string, string>();
  const viByCategoryId = new Map<string, string>();
  if (wanted.has("categories") || wanted.has("products")) {
    await downloadAll(["product_category_name_translation.csv"], {
      cacheDir,
    });
    const translation = await readCachedCsv(
      cacheDir,
      "product_category_name_translation.csv",
    );
    const enByPt = new Map<string, string>();
    for (const row of translation) {
      enByPt.set(str(row["product_category_name"]), str(row["product_category_name_english"]));
    }
    const seenVi = new Set<string>();
    const register = (id: string, viName: string): void => {
      if (seenVi.has(viName)) {
        throw new Error(`Duplicate Vietnamese category name "${viName}" — name_vi must stay UNIQUE`);
      }
      seenVi.add(viName);
      viByCategoryId.set(id, viName);
    };
    for (const [en, viName] of Object.entries(CATEGORY_VI_BY_EN)) {
      register(en, viName);
    }
    register("fallback:empty", UNMAPPED_CATEGORY_FALLBACKS[""] ?? "Chưa phân loại");
    register("fallback:pc_gamer", UNMAPPED_CATEGORY_FALLBACKS["pc_gamer"] ?? "Máy tính & Linh kiện");
    register(
      "fallback:portateis",
      UNMAPPED_CATEGORY_FALLBACKS["portateis_cozinha_e_preparadores_de_alimentos"] ?? "Thiết bị nhà bếp",
    );
    register("fallback:other", "Khác");
    ptToCategoryId = new Map<string, string>();
    for (const [pt, en] of enByPt) {
      const viName = CATEGORY_VI_BY_EN[en];
      ptToCategoryId.set(pt, viName !== undefined ? en : "fallback:other");
    }
    ptToCategoryId.set("", "fallback:empty");
    ptToCategoryId.set("pc_gamer", "fallback:pc_gamer");
    ptToCategoryId.set(
      "portateis_cozinha_e_preparadores_de_alimentos",
      "fallback:portateis",
    );
    if (wanted.has("categories")) {
      const catRows: (readonly unknown[])[] = [...viByCategoryId.entries()].map(
        ([id, viName]) => [id, viName] as const,
      );
      rows.set("categories", catRows);
    }
  }

  const categoryIdForPt = (pt: string): string =>
    ptToCategoryId.get(pt) ?? "fallback:other";

  // -- Customers / sellers (synthetic PII via the seeded faker) --
  const customerById = new Map<string, { province: string; region: string }>();
  if (wanted.has("customers")) {
    await downloadAll(["olist_customers_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_customers_dataset.csv");
    const out: (readonly unknown[])[] = [];
    let spread = 0;
    let rowIndex = 0;
    for (const row of raw) {
      const id = str(row["customer_id"]);
      // Every 4th customer spreads into the weighted cycle so the seven
      // Olist-unmapped provinces (and thin scenario provinces) gain real
      // base volume; the rest keep their mapped province.
      let province = stateToProvince(str(row["customer_state"]));
      if (rowIndex % 4 === 3) {
        const spreadProvince = SPREAD_CYCLE[spread % SPREAD_CYCLE.length];
        if (spreadProvince) province = spreadProvince;
        spread += 1;
      }
      rowIndex += 1;
      const region = regionOfProvince(province);
      customerById.set(id, { province, region });
      out.push([
        id,
        rng.person.fullName(),
        rng.phone.number(),
        rng.internet.email(),
        rng.location.streetAddress(),
        province,
        region,
      ]);
    }
    rows.set("customers", out);
  }
  const sellerById = new Map<string, true>();
  if (wanted.has("sellers")) {
    await downloadAll(["olist_sellers_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_sellers_dataset.csv");
    const out: (readonly unknown[])[] = [];
    let spread = 0;
    let rowIndex = 0;
    for (const row of raw) {
      const id = str(row["seller_id"]);
      let province = stateToProvince(str(row["seller_state"]));
      if (rowIndex % 4 === 3) {
        const spreadProvince = SPREAD_CYCLE[spread % SPREAD_CYCLE.length];
        if (spreadProvince) province = spreadProvince;
        spread += 1;
      }
      rowIndex += 1;
      sellerById.set(id, true);
      out.push([id, province, regionOfProvince(province)]);
    }
    rows.set("sellers", out);
  }

  // -- Products (category resolved, synthetic catalog names/prices) --
  const productCategory = new Map<string, string>();
  if (wanted.has("products")) {
    await downloadAll(["olist_products_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_products_dataset.csv");
    const out: (readonly unknown[])[] = [];
    let seq = 0;
    for (const row of raw) {
      const id = str(row["product_id"]);
      const pt = str(row["product_category_name"]);
      const categoryId = categoryIdForPt(pt);
      const viName =
        viByCategoryId.get(categoryId) ?? translateCategory(pt);
      productCategory.set(id, categoryId);
      seq += 1;
      out.push([
        id,
        categoryId,
        `${viName} mẫu ${String(seq).padStart(4, "0")}`,
        Math.round(rng.number.int({ min: 50_000, max: 5_000_000 }) / 1000) * 1000,
        intOrNull(row["product_weight_g"]),
        intOrNull(row["product_length_cm"]),
        intOrNull(row["product_height_cm"]),
        intOrNull(row["product_width_cm"]),
      ]);
    }
    rows.set("products", out);
  }

  // -- Orders (date-shifted, clipped pre-2025, folded statuses) --
  const orders: BuiltOrder[] = [];
  const validOrderIds = new Set<string>();
  const orderById = new Map<string, BuiltOrder>();
  if (wanted.has("orders")) {
    await downloadAll(["olist_orders_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_orders_dataset.csv");
    for (const row of raw) {
      const id = str(row["order_id"]);
      const shifted = shiftOrderDate(str(row["order_purchase_timestamp"]));
      if (shifted === null) {
        stats.clippedOrders += 1; // Pre-2025 after shift (Pitfall P5) — children filtered below.
        continue;
      }
      const customerId = str(row["customer_id"]);
      if (wanted.has("customers") && !customerById.has(customerId)) {
        stats.clippedOrders += 1;
        continue;
      }
      const order: BuiltOrder = {
        id,
        customerId,
        channelId: rng.helpers.arrayElement(CHANNEL_IDS),
        status: foldOrderStatus(str(row["order_status"])),
        purchaseDate: shifted,
      };
      orders.push(order);
      validOrderIds.add(id);
      orderById.set(id, order);
    }
  }

  // -- order_items / payments / reviews (children of surviving orders) --
  const items: BuiltItem[] = [];
  const payments: BuiltPayment[] = [];
  const reviews: BuiltReview[] = [];
  const productKnown = (id: string): boolean =>
    !wanted.has("products") || productCategory.has(id);
  const sellerKnown = (id: string): boolean =>
    !wanted.has("sellers") || sellerById.has(id);
  if (wanted.has("order_items")) {
    await downloadAll(["olist_order_items_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_order_items_dataset.csv");
    for (const row of raw) {
      const orderId = str(row["order_id"]);
      const productId = str(row["product_id"]);
      const sellerId = str(row["seller_id"]);
      // Tolerant when the parent table is not part of a partial build: the
      // database FKs enforce truthfully at COPY time instead.
      if (
        (ordersBuilt && !validOrderIds.has(orderId)) ||
        !productKnown(productId) ||
        !sellerKnown(sellerId)
      ) {
        stats.skippedItems += 1;
        continue;
      }
      items.push([
        orderId,
        productId,
        sellerId,
        brlToVnd(Number(str(row["price"]))),
        brlToVnd(Number(str(row["freight_value"]))),
      ]);
    }
  }
  if (wanted.has("payments")) {
    await downloadAll(["olist_order_payments_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_order_payments_dataset.csv");
    for (const row of raw) {
      const orderId = str(row["order_id"]);
      if (ordersBuilt && !validOrderIds.has(orderId)) {
        stats.skippedPayments += 1;
        continue;
      }
      // DDL CHECK (installments >= 1): Olist carries 0 for not_defined rows.
      const installments = Math.max(1, intOrNull(row["payment_installments"]) ?? 1);
      payments.push([
        orderId,
        str(row["payment_type"]),
        installments,
        brlToVnd(Number(str(row["payment_value"]))),
      ]);
    }
  }
  if (wanted.has("reviews")) {
    await downloadAll(["olist_order_reviews_dataset.csv"], { cacheDir });
    const raw = await readCachedCsv(cacheDir, "olist_order_reviews_dataset.csv");
    const seenReview = new Set<string>();
    for (const row of raw) {
      const reviewId = str(row["review_id"]);
      const orderId = str(row["order_id"]);
      if (ordersBuilt && !validOrderIds.has(orderId)) {
        stats.skippedReviews += 1;
        continue;
      }
      if (seenReview.has(reviewId)) {
        stats.duplicateReviews += 1; // 814 publisher dupes — first wins.
        continue;
      }
      seenReview.add(reviewId);
      const order = orderById.get(orderId);
      const shifted = shiftOrderDate(str(row["review_creation_date"]));
      reviews.push({
        id: reviewId,
        orderId,
        score: intOrNull(row["review_score"]) ?? 5,
        title: str(row["review_comment_title"]),
        message: str(row["review_comment_message"]),
        createdAt: shifted ?? order?.purchaseDate ?? "2025-01-01 00:00:00",
      });
    }
  }

  // -- Expansion + injection run only on the full twelve-table build --
  if (full) {
    expandToMillion(orders, items, payments, reviews, orderById, rng, stats, scale);
    injectSeeds(
      orders,
      items,
      payments,
      reviews,
      orderById,
      customerById,
      productCategory,
      viByCategoryId,
      rows.get("products") as (readonly unknown[])[],
      rng,
      stats,
    );
  }

  // -- Convert the working set to COPY row arrays --
  if (wanted.has("orders")) {
    rows.set(
      "orders",
      orders.map((o) => [o.id, o.customerId, o.channelId, o.status, o.purchaseDate] as const),
    );
  }
  if (wanted.has("order_items")) {
    rows.set("order_items", items);
  }
  if (wanted.has("payments")) {
    rows.set("payments", payments);
  }
  if (wanted.has("reviews")) {
    rows.set(
      "reviews",
      reviews.map((r) => [r.id, r.orderId, r.score, r.title, r.message, r.createdAt] as const),
    );
  }
  return { rows, stats };
}

// Clone whole orders (new surrogate ids, same customer/channel, child rows
// cloned under the new order id) until order_items reaches 1,000,000 rows:
// nine full passes over the base orders, then a top-up cycling base orders.
// Same-weekday guarantee: clones keep the calendar DATE (delta 0 is the only
// same-weekday offset within ±3 days); variance comes from jittered clock
// time (±) and ±5% money jitter. All randomness flows through the seeded
// faker — the sole RNG.
function expandToMillion(
  orders: BuiltOrder[],
  items: BuiltItem[],
  payments: BuiltPayment[],
  reviews: BuiltReview[],
  orderById: Map<string, BuiltOrder>,
  rng: Faker,
  stats: BuildStats,
  scale: LoadScale,
): void {
  const jitterMoney = (value: number): number =>
    Math.max(
      1000,
      Math.round((value * (1 + rng.number.float({ min: -0.05, max: 0.05 }))) / 1000) * 1000,
    );
  const jitterClock = (datePart: string): string =>
    `${datePart} ${pad2(rng.number.int({ min: 0, max: 23 }))}:${pad2(rng.number.int({ min: 0, max: 59 }))}:${pad2(rng.number.int({ min: 0, max: 59 }))}`;

  const baseOrders = [...orders];
  const itemsByOrder = new Map<string, BuiltItem[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item[0]);
    if (list) list.push(item);
    else itemsByOrder.set(item[0], [item]);
  }
  const paymentsByOrder = new Map<string, BuiltPayment[]>();
  for (const payment of payments) {
    const list = paymentsByOrder.get(payment[0]);
    if (list) list.push(payment);
    else paymentsByOrder.set(payment[0], [payment]);
  }
  const reviewsByOrder = new Map<string, BuiltReview[]>();
  for (const review of reviews) {
    const list = reviewsByOrder.get(review.orderId);
    if (list) list.push(review);
    else reviewsByOrder.set(review.orderId, [review]);
  }

  const cloneWholeOrder = (
    source: BuiltOrder,
    newId: string,
    purchaseDate: string,
    status: string,
  ): void => {
    const order: BuiltOrder = {
      id: newId,
      customerId: source.customerId,
      channelId: source.channelId,
      status,
      purchaseDate,
    };
    orders.push(order);
    orderById.set(newId, order);
    for (const item of itemsByOrder.get(source.id) ?? []) {
      items.push([newId, item[1], item[2], jitterMoney(item[3]), jitterMoney(item[4])]);
    }
    for (const payment of paymentsByOrder.get(source.id) ?? []) {
      payments.push([newId, payment[1], payment[2], jitterMoney(payment[3])]);
    }
    for (const review of reviewsByOrder.get(source.id) ?? []) {
      reviews.push({
        id: `${review.id}-${newId.slice(-8)}`,
        orderId: newId,
        score: review.score,
        title: review.title,
        message: review.message,
        createdAt: purchaseDate,
      });
    }
  };

  for (let pass = 1; pass <= EXPANSION_PASSES[scale]; pass++) {
    for (const source of baseOrders) {
      const datePart = source.purchaseDate.slice(0, 10);
      cloneWholeOrder(source, `${source.id}-e${String(pass)}`, jitterClock(datePart), source.status);
    }
    stats.expansionPasses += 1;
  }
  let topUp = 0;
  while (items.length < EXPANSION_ITEM_TARGET[scale]) {
    const source = baseOrders[topUp % baseOrders.length];
    if (!source) break;
    const datePart = source.purchaseDate.slice(0, 10);
    cloneWholeOrder(
      source,
      `${source.id}-t${String(topUp)}`,
      jitterClock(datePart),
      source.status,
    );
    topUp += 1;
  }
  stats.topUpClones = topUp;
}

// Seed injection AFTER expansion per Pitfall P6, as data mutations on the
// working set (deletes/updates/inserts, never DDL). Magnitudes are engineered
// against post-expansion baselines so cloning cannot drown them; 02-04
// asserts each seeds.json reference_sql still returns its designed signal.
function injectSeeds(
  orders: BuiltOrder[],
  items: BuiltItem[],
  payments: BuiltPayment[],
  reviews: BuiltReview[],
  orderById: Map<string, BuiltOrder>,
  customerById: Map<string, { province: string; region: string }>,
  productCategory: Map<string, string>,
  viByCategoryId: Map<string, string>,
  productRows: (readonly unknown[])[],
  rng: Faker,
  stats: BuildStats,
): void {
  const note = (text: string): void => {
    stats.injectionNotes.push(text);
  };
  const deletedItems = new Set<BuiltItem>();
  const orderOf = (item: BuiltItem): BuiltOrder | undefined => orderById.get(item[0]);
  const categoryViOf = (productId: string): string | undefined =>
    viByCategoryId.get(productCategory.get(productId) ?? "");

  const monthOf = (purchaseDate: string): string => purchaseDate.slice(0, 7);
  const dayOf = (purchaseDate: string): string => purchaseDate.slice(0, 10);

  // Revenue-delete helper: delete a revenue-ordered prefix of the slice until
  // at least `removeRevenue` is gone (sorted by order_id — effectively
  // price-blind, deterministic given the build order). Returns the removed
  // revenue and the removed share of the slice total.
  const deleteRevenueAmount = (
    slice: BuiltItem[],
    removeRevenue: number,
  ): { removed: number; pct: number } => {
    const total = slice.reduce((sum, item) => sum + item[3], 0);
    const target = Math.max(0, removeRevenue);
    const sorted = [...slice].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1,
    );
    let removed = 0;
    for (const item of sorted) {
      if (removed >= target) break;
      deletedItems.add(item);
      removed += item[3];
    }
    return { removed, pct: total === 0 ? 0 : -removed / total };
  };

  // Slice revenue partitioned by month (August baseline vs September effect).
  const sliceRevenueByMonth = (
    slice: BuiltItem[],
  ): { aug: number; sept: number } => {
    let aug = 0;
    let sept = 0;
    for (const item of slice) {
      const month = monthOf(orderOf(item)?.purchaseDate ?? "");
      if (month === "2026-08") aug += item[3];
      else if (month === "2026-09") sept += item[3];
    }
    return { aug, sept };
  };

  const inSlice = (
    item: BuiltItem,
    channelId: string,
    region: string,
    categoryVi: string,
  ): boolean => {
    const order = orderOf(item);
    if (!order || order.status !== "delivered") return false;
    if (order.channelId !== channelId) return false;
    if (customerById.get(order.customerId)?.region !== region) return false;
    return categoryViOf(item[1]) === categoryVi;
  };

  // Injection order (all post-expansion, Pitfall P6): September synthesis
  // and S3 slice seeding establish the September population; the AOV cut
  // lands first so the proportional S1/S3/A2 cuts are computed on final
  // prices; spikes then flips; cascade last.

  // Child-row indexes (built once, post-expansion) so spike cloning stays
  // linear instead of scanning the million-row arrays per clone.
  const itemsByOrder = new Map<string, BuiltItem[]>();
  for (const item of items) {
    const list = itemsByOrder.get(item[0]);
    if (list) list.push(item);
    else itemsByOrder.set(item[0], [item]);
  }
  const paymentsByOrder = new Map<string, BuiltPayment[]>();
  for (const payment of payments) {
    const list = paymentsByOrder.get(payment[0]);
    if (list) list.push(payment);
    else paymentsByOrder.set(payment[0], [payment]);
  }
  const reviewsByOrder = new Map<string, BuiltReview[]>();
  for (const review of reviews) {
    const list = reviewsByOrder.get(review.orderId);
    if (list) list.push(review);
    else reviewsByOrder.set(review.orderId, [review]);
  }

  // Whole-order cloner for spike synthesis (new ids, retargeted date).
  // Cloned child rows are registered in the maps too, so later clones may
  // themselves source from synthesized rows. Returns the new order id.
  let spikeSeq = 0;
  const cloneForSpike = (
    source: BuiltOrder,
    date: string,
    status: string,
    tag: string,
  ): string => {
    spikeSeq += 1;
    const newId = `${source.id}-${tag}${String(spikeSeq)}`;
    const purchaseDate = `${date} ${pad2(rng.number.int({ min: 0, max: 23 }))}:${pad2(rng.number.int({ min: 0, max: 59 }))}:${pad2(rng.number.int({ min: 0, max: 59 }))}`;
    const order: BuiltOrder = {
      id: newId,
      customerId: source.customerId,
      channelId: source.channelId,
      status,
      purchaseDate,
    };
    orders.push(order);
    orderById.set(newId, order);
    const newItems: BuiltItem[] = [];
    for (const item of itemsByOrder.get(source.id) ?? []) {
      if (deletedItems.has(item)) continue;
      const cloned: BuiltItem = [newId, item[1], item[2], item[3], item[4]];
      items.push(cloned);
      newItems.push(cloned);
    }
    if (newItems.length > 0) itemsByOrder.set(newId, newItems);
    const newPayments: BuiltPayment[] = [];
    for (const payment of paymentsByOrder.get(source.id) ?? []) {
      const cloned: BuiltPayment = [newId, payment[1], payment[2], payment[3]];
      payments.push(cloned);
      newPayments.push(cloned);
    }
    if (newPayments.length > 0) paymentsByOrder.set(newId, newPayments);
    const newReviews: BuiltReview[] = [];
    for (const review of reviewsByOrder.get(source.id) ?? []) {
      const cloned: BuiltReview = {
        id: `${review.id}-${tag}${String(spikeSeq)}`,
        orderId: newId,
        score: review.score,
        title: review.title,
        message: review.message,
        createdAt: purchaseDate,
      };
      reviews.push(cloned);
      newReviews.push(cloned);
    }
    if (newReviews.length > 0) reviewsByOrder.set(newId, newReviews);
    return newId;
  };

  // September synthesis: the shifted publisher tail (Sept 2018) is thin and
  // canceled, so September 2026 has no delivered base rows for the
  // seeds.json scenarios to act on. Clone delivered August 2026 orders
  // round-robin across September 01..30 (whole orders, jittered clock) to
  // establish the September population first; scenario magnitudes below are
  // then engineered against this baseline. Deterministic (id-sorted pool).
  const septemberPool = orders
    .filter((order) => {
      if (order.status !== "delivered") return false;
      const day = dayOf(order.purchaseDate);
      return day >= "2026-08-01" && day <= "2026-08-31";
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  septemberPool.forEach((source, index) => {
    const day = 1 + (index % 30);
    cloneForSpike(
      source,
      `2026-09-${String(day).padStart(2, "0")}`,
      "delivered",
      "sep",
    );
  });
  note(`september-synthesis: cloned ${String(septemberPool.length)} August delivered orders across September 01..30`);

  // S3 slice seeding: the Lazada × Nam × Điện-gia-dụng September intersection
  // is naturally empty (three-way sparsity), so no proportional cut is
  // possible. Clone 60 delivered September Nam orders (Lazada channel, one
  // item retargeted to a Điện-gia-dụng product) to establish the slice; the
  // S3 cut below then engineers the -12% against it. Clones keep their
  // source day and never enter S1's slice (channel + category both differ).
  const dienGDCategoryId = [...viByCategoryId.entries()].find(
    ([, viName]) => viName === "Điện gia dụng",
  )?.[0];
  const dienGDProducts = [...productCategory.entries()]
    .filter(([, categoryId]) => categoryId === dienGDCategoryId)
    .map(([productId]) => productId)
    .sort();
  const s3SeedPool = orders
    .filter(
      (order) =>
        order.status === "delivered" &&
        monthOf(order.purchaseDate) === "2026-09" &&
        customerById.get(order.customerId)?.region === "Nam" &&
        order.channelId !== "lazada",
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, 150);
  s3SeedPool.forEach((source, index) => {
    const product = dienGDProducts[index % Math.max(1, dienGDProducts.length)];
    if (product === undefined) return;
    const newId = cloneForSpike(source, dayOf(source.purchaseDate), "delivered", "s3s");
    const seededOrder = orderById.get(newId);
    if (seededOrder) seededOrder.channelId = "lazada";
    const firstItem = itemsByOrder.get(newId)?.[0];
    if (firstItem) firstItem[1] = product;
  });
  note(`s3-seeding: cloned ${String(s3SeedPool.length)} September Nam orders into the Lazada × Điện-gia-dụng slice`);
  // August mirror of the S3 slice: the S3 reference SQL divides by the
  // August slice revenue, which is naturally zero. Clone each -s3s September
  // seed back into August (same items and prices, fixed mid-month day) so
  // the August baseline mirrors the September pre-cut revenue and the -12%
  // cut below reads exactly.
  const s3SeptIds: string[] = [];
  for (const order of orders) {
    if (order.id.includes("-s3s")) s3SeptIds.push(order.id);
  }
  s3SeptIds.sort();
  for (const septId of s3SeptIds) {
    const source = orderById.get(septId);
    if (!source) continue;
    cloneForSpike(source, "2026-08-15", "delivered", "s3a");
  }
  note(`s3-august-mirror: mirrored ${String(s3SeptIds.length)} S3 seed rows into August`);

  // UC-10 A5 FIRST (before the proportional cuts): a flat 30% price cut on
  // delivered items in 2026-09-21..27. Runs before S1/S3/A2 so those cuts
  // are engineered against final prices and land exactly.
  let aovTouched = 0;
  for (const item of items) {
    if (deletedItems.has(item)) continue;
    const order = orderOf(item);
    if (!order || order.status !== "delivered") continue;
    const day = dayOf(order.purchaseDate);
    if (day >= "2026-09-21" && day <= "2026-09-27") {
      item[3] = Math.max(1000, Math.round((item[3] * 0.7) / 1000) * 1000);
      aovTouched += 1;
    }
  }
  note(`uc10-aov-drop: 30% price cut on ${String(aovTouched)} delivered items in 2026-09-21..27`);

  // UC-10 A2 runs LAST among revenue mutations (after S1/S3/EC-02), so its
  // d14/d21 baselines are final and the cut lands exactly. See below.

  const deliveredIn = (
    province: string,
    from: string,
    to: string,
  ): BuiltOrder[] =>
    orders
      .filter((order) => {
        if (order.status !== "delivered") return false;
        const day = dayOf(order.purchaseDate);
        if (day < from || day > to) return false;
        return customerById.get(order.customerId)?.province === province;
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));

  // UC-10 A3: TP.HCM flash-sale spike on 09/09 — add ~1.5× the day baseline.
  const hcmDay = orders.filter(
    (order) =>
      order.status === "delivered" &&
      dayOf(order.purchaseDate) === "2026-09-09" &&
      customerById.get(order.customerId)?.province === "TP.HCM",
  );
  const hcmIds = new Set(hcmDay.map((order) => order.id));
  const hcmBase = items
    .filter((item) => !deletedItems.has(item) && hcmIds.has(item[0]))
    .reduce((sum, item) => sum + item[3], 0);
  const hcmPool = deliveredIn("TP.HCM", "2026-09-02", "2026-09-08");
  let hcmAdded = 0;
  for (let i = 0; hcmAdded < hcmBase * 1.5 && hcmPool.length > 0; i++) {
    const source = hcmPool[i % hcmPool.length];
    if (!source) break;
    const before = items.length;
    cloneForSpike(source, "2026-09-09", "delivered", "a3");
    hcmAdded += items
      .slice(before)
      .reduce((sum, item) => sum + item[3], 0);
  }
  note(`uc10-hcm-revenue-spike: baseline ${String(hcmBase)} VND, cloned +${String(hcmAdded)} VND`);

  // UC-10 A4: Hà Nội order-count spike on 09-16 — double the day count.
  const hanoiDay = deliveredIn("Hà Nội", "2026-09-16", "2026-09-16");
  const hanoiPool = deliveredIn("Hà Nội", "2026-09-09", "2026-09-15");
  for (let i = 0; i < hanoiDay.length && hanoiPool.length > 0; i++) {
    const source = hanoiPool[i % hanoiPool.length];
    if (!source) break;
    cloneForSpike(source, "2026-09-16", "delivered", "a4");
  }
  note(`uc10-hanoi-orders-spike: doubled ${String(hanoiDay.length)} Hà Nội orders on 2026-09-16`);

  // UC-05 EC-02: Đà Nẵng returns surge from 10/09 — flip the first 200
  // deliverable Đà Nẵng orders in the window to returned.
  const danangWindow = orders
    .filter((order) => {
      const day = dayOf(order.purchaseDate);
      if (day < "2026-09-10" || day > "2026-09-30") return false;
      if (order.status !== "delivered" && order.status !== "shipped") return false;
      return customerById.get(order.customerId)?.province === "Đà Nẵng";
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, 200);
  for (const order of danangWindow) order.status = "returned";
  note(`uc05-danang-returns-surge: flipped ${String(danangWindow.length)} Đà Nẵng orders to returned`);

  // UC-10 A1: Đà Nẵng returns ×4 on 14/09 — synthesize 4× the prior-week
  // daily baseline as new returned orders.
  const danangPrior = deliveredIn("Đà Nẵng", "2026-09-07", "2026-09-13");
  const danangDaily = danangPrior.length / 7;
  const a1Count = Math.max(10, Math.round(danangDaily * 4));
  for (let i = 0; i < a1Count && danangPrior.length > 0; i++) {
    const source = danangPrior[i % danangPrior.length];
    if (!source) break;
    cloneForSpike(source, "2026-09-14", "returned", "a1");
  }
  note(`uc10-danang-returns-x4: synthesized ${String(danangPrior.length > 0 ? a1Count : 0)} returned orders on 2026-09-14`);

  // UC-05 proportional cuts LAST (after every other revenue mutation), so the
  // logged pcts are the final ones. Both compensate dynamically against
  // their August baselines (which include the intentional September
  // interactions: the AOV week and the synthesized-September shape), so the
  // final August-to-September ratios land on the designed magnitudes.
  // Granularity note: the S3 cut overshoots by up to one row, so the S3 seed
  // below clones 150 rows to keep the final ratio within a point of -0.12.
  const s1All = items.filter(
    (item) =>
      !deletedItems.has(item) && inSlice(item, "shopee", "Trung", "Đồ gia dụng"),
  );
  const s1Rev = sliceRevenueByMonth(s1All);
  const s1 = s1All.filter(
    (item) => monthOf(orderOf(item)?.purchaseDate ?? "") === "2026-09",
  );
  const s1Result = deleteRevenueAmount(s1, s1Rev.sept - 0.82 * s1Rev.aug);
  const s1Final =
    s1Rev.aug === 0 ? 0 : (s1Rev.sept - s1Result.removed - s1Rev.aug) / s1Rev.aug;
  note(
    `uc05-shopee-trung-dogiadung: sept slice ${String(s1.length)} rows, aug ${String(s1Rev.aug)} VND, final ratio ${s1Final.toFixed(3)} (removed share ${(-s1Result.pct).toFixed(3)})`,
  );

  // UC-05 S3: Lazada × Nam × Điện gia dụng September dip (designed -0.12).
  // A2 (below) skips S1/S3-slice rows, so nothing after this cut touches the
  // slice except the revenue-neutral cascade: the final ratio lands exactly.
  const s3All = items.filter(
    (item) =>
      !deletedItems.has(item) && inSlice(item, "lazada", "Nam", "Điện gia dụng"),
  );
  const s3Rev = sliceRevenueByMonth(s3All);
  const s3 = s3All.filter(
    (item) => monthOf(orderOf(item)?.purchaseDate ?? "") === "2026-09",
  );
  const s3Result = deleteRevenueAmount(s3, s3Rev.sept - 0.88 * s3Rev.aug);
  const s3Final =
    s3Rev.aug === 0 ? 0 : (s3Rev.sept - s3Result.removed - s3Rev.aug) / s3Rev.aug;
  note(
    `uc05-lazada-nam-diengiadung: sept slice ${String(s3.length)} rows, aug ${String(s3Rev.aug)} VND, final ratio ${s3Final.toFixed(3)} (removed share ${(-s3Result.pct).toFixed(3)})`,
  );

  // UC-10 A2 LAST: sharp single-day revenue drop on 2026-09-21 to just over
  // half of 09-14 (designed "at least -0.50"). d14/d21 are final here (all
  // other mutations applied). The cut set SKIPS S1/S3-slice rows, so A2 can
  // no longer erode the S1/S3 ratios measured above; keeping 0.49*d14 lands
  // the wow ratio at ≈ -0.51 with margin, and the cascade afterwards is
  // revenue-neutral.
  const inProtectedSlice = (item: BuiltItem): boolean =>
    inSlice(item, "shopee", "Trung", "Đồ gia dụng") ||
    inSlice(item, "lazada", "Nam", "Điện gia dụng");
  const d21All = items.filter(
    (item) =>
      !deletedItems.has(item) &&
      dayOf(orderOf(item)?.purchaseDate ?? "") === "2026-09-21" &&
      orderOf(item)?.status === "delivered",
  );
  const d21Total = d21All.reduce((sum, item) => sum + item[3], 0);
  const d14Total = items
    .filter(
      (item) =>
        !deletedItems.has(item) &&
        dayOf(orderOf(item)?.purchaseDate ?? "") === "2026-09-14" &&
        orderOf(item)?.status === "delivered",
    )
    .reduce((sum, item) => sum + item[3], 0);
  const d21 = d21All.filter((item) => !inProtectedSlice(item));
  const a2Result = deleteRevenueAmount(d21, d21Total - 0.49 * d14Total);
  const a2Final = d14Total === 0 ? 0 : (d21Total - a2Result.removed - d14Total) / d14Total;
  note(
    `uc10-sharp-revenue-drop: 09-21 slice ${String(d21All.length)} rows (${String(d21Total)} VND) vs 09-14 ${String(d14Total)} VND, final wow ${a2Final.toFixed(3)} (removed share ${(-a2Result.pct).toFixed(3)} from ${String(d21.length)} unprotected rows)`,
  );

  // Prompt-injection product rows (payloads from seeds.json, categories by
  // Vietnamese name so the reference SQL LIKE clauses hit).
  const seeds = loadSeedsFile();
  const categoryIdByVi = new Map<string, string>();
  for (const [id, viName] of viByCategoryId) categoryIdByVi.set(viName, id);
  const injectionTargets: Record<string, string> = {
    "inj-product-phones": "Đồ gia dụng",
    "inj-product-emails": "Thiết bị nhà bếp",
    "inj-product-salaries": "Thời trang nam",
  };
  let injectionSeq = 0;
  for (const entry of seeds.injections) {
    const categoryVi = injectionTargets[entry.id] ?? "Khác";
    const categoryId = categoryIdByVi.get(categoryVi) ?? "fallback:other";
    injectionSeq += 1;
    const payload = entry.payload ?? entry.id;
    productRows.push([
      `inj-${entry.id}`,
      categoryId,
      payload,
      299_000,
      null,
      null,
      null,
      null,
    ]);
    productCategory.set(`inj-${entry.id}`, categoryId);
    void injectionSeq;
  }
  note(`injections: inserted ${String(seeds.injections.length)} prompt-injection products`);

  // Cascade: orders left with zero surviving items go away with their
  // payments and reviews, so the load never leaves item-less orders behind.
  const liveItems = new Set<string>();
  const keptItems: BuiltItem[] = [];
  for (const item of items) {
    if (deletedItems.has(item)) continue;
    liveItems.add(item[0]);
    keptItems.push(item);
  }
  items.length = 0;
  for (const item of keptItems) items.push(item);
  const removedOrders = new Set<string>();
  const keptOrders = orders.filter((order) => {
    if (liveItems.has(order.id)) return true;
    removedOrders.add(order.id);
    orderById.delete(order.id);
    return false;
  });
  orders.length = 0;
  for (const order of keptOrders) orders.push(order);
  const keptPayments = payments.filter((payment) => !removedOrders.has(payment[0]));
  payments.length = 0;
  for (const payment of keptPayments) payments.push(payment);
  const keptReviews = reviews.filter((review) => !removedOrders.has(review.orderId));
  reviews.length = 0;
  for (const review of keptReviews) reviews.push(review);
  note(`cascade: removed ${String(removedOrders.size)} item-less orders`);
}

async function canonicalCsvFor(
  client: PoolClient,
  def: TableDef,
): Promise<{ rows: number; sha256: string }> {
  const result = await client.query(
    `SELECT ${def.columns.join(", ")} FROM ${def.table} ORDER BY ${def.pk}`,
  );
  const lines = (result.rows as Record<string, unknown>[]).map((row) =>
    def.columns
      .map((column) => {
        const value = row[column];
        return value instanceof Date ? value.toISOString() : String(value);
      })
      .join(","),
  );
  return {
    rows: lines.length,
    sha256: hashCanonicalCsv(lines.join("\n")),
  };
}

export async function loadTables(
  pool: Pool,
  tableNames: readonly string[],
  scale: LoadScale = "full",
): Promise<SeedManifest> {
  const cacheDir = resolveCacheDir();
  const { rows, stats } = await buildDataset(tableNames, cacheDir, scale);
  console.log(
    `build: clipped ${String(stats.clippedOrders)} orders, skipped ${String(stats.skippedItems)} items / ${String(stats.skippedPayments)} payments / ${String(stats.skippedReviews)} reviews, ${String(stats.duplicateReviews)} duplicate reviews`,
  );
  if (stats.expansionPasses > 0) {
    console.log(
      `expand: ${String(stats.expansionPasses)} passes + ${String(stats.topUpClones)} top-up clones`,
    );
  }
  for (const line of stats.injectionNotes) console.log(`inject: ${line}`);

  const tables: SeedManifest["tables"] = {};
  // Reset children-first. A full twelve-table reset runs as one TRUNCATE
  // statement (instant, RESTART IDENTITY so reloads are fully deterministic;
  // same-statement truncation needs no CASCADE). Partial --tables resets keep
  // the old per-table DELETE, which stays FK-safe for leaf/static tables.
  const resetOrder = [...tableNames].reverse();
  if (tableNames.length === LOAD_ORDER.length) {
    await withOwnerTx(pool, async (client) => {
      const targets = resetOrder
        .map((name) => {
          const def = TABLE_LOADERS[name];
          if (!def) throw new Error(`Unknown table "${name}"`);
          return def.table;
        })
        .join(", ");
      await client.query(`TRUNCATE ${targets} RESTART IDENTITY`);
    });
  } else {
    await withOwnerTx(pool, async (client) => {
      for (const name of resetOrder) {
        const def = TABLE_LOADERS[name];
        if (!def) throw new Error(`Unknown table "${name}"`);
        if (!rows.has(name)) continue;
        await client.query(`DELETE FROM ${def.table}`);
      }
    });
  }
  // COPY in bounded chunks: copyTable streams one COPY per call, so a single
  // million-row call buffers the whole formatted stream in memory and GC
  // thrashes. Chunked COPYs inside one transaction keep memory flat.
  const COPY_CHUNK_SIZE = 50_000;
  for (const name of tableNames) {
    const def = TABLE_LOADERS[name];
    if (!def) throw new Error(`Unknown table "${name}"`);
    const data = rows.get(name);
    if (!data) continue;
    await withOwnerTx(pool, async (client) => {
      let written = 0;
      for (let offset = 0; offset < data.length; offset += COPY_CHUNK_SIZE) {
        written += await copyTable(
          client,
          def.table,
          def.columns,
          data.slice(offset, offset + COPY_CHUNK_SIZE),
        );
      }
      const checksum = await canonicalCsvFor(client, def);
      if (checksum.rows !== written) {
        throw new Error(
          `COPY/readback mismatch on ${def.table}: wrote ${String(written)}, read ${String(checksum.rows)}`,
        );
      }
      tables[name] = checksum;
    });
  }
  return {
    version: 1,
    seed: SEED,
    dataset_version: datasetVersionFor(scale),
    tables,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const tableNames = parseTablesFilter(argv);
  const scale = parseLoadScale(argv);
  const pool = createOwnerPool();
  try {
    const manifest = await loadTables(pool, tableNames, scale);
    // Determinism gate (full twelve-table loads only): every table loaded
    // now that also exists in the previous manifest must match it byte for
    // byte; then merge (fresh rows win). Partial --tables loads skip the
    // gate and leave the stored manifest untouched: they are explicitly
    // iteration-only (base rows without expansion), never canonical.
    if (tableNames.length !== LOAD_ORDER.length) {
      console.log(
        "partial load — manifest gate skipped, stored manifest left untouched; run a full load before verify",
      );
    } else {
      let previous: SeedManifest | null = null;
      try {
        previous = readManifest(DEFAULT_MANIFEST_PATH);
      } catch {
        previous = null; // First load: no manifest yet, write it below.
      }
      let merged: SeedManifest = manifest;
      if (previous) {
      const overlap = tableNames.filter((name) => previous?.tables[name]);
      const scopedActual: SeedManifest = {
        ...manifest,
        tables: Object.fromEntries(
          overlap.map((name) => [name, manifest.tables[name]]),
        ),
      };
      const scopedExpected: SeedManifest = {
        ...previous,
        tables: Object.fromEntries(
          overlap.map((name) => [name, (previous as SeedManifest).tables[name]]),
        ),
      };
      const mismatches = compareManifests(scopedActual, scopedExpected);
      if (mismatches.length > 0) {
        throw new Error(
          `Manifest mismatch — refusing to finish:\n${mismatches.join("\n")}`,
        );
      }
      merged = {
        version: 1,
        seed: SEED,
        dataset_version: datasetVersionFor(scale),
        tables: { ...previous.tables, ...manifest.tables },
      };
    }
    writeManifest(merged, DEFAULT_MANIFEST_PATH);
    for (const name of tableNames) {
      const entry = merged.tables[name];
      if (entry) {
        console.log(`loaded ${name}: ${String(entry.rows)} rows sha256=${entry.sha256}`);
      }
    }
    console.log(`manifest: ${DEFAULT_MANIFEST_PATH}`);
    }
  } finally {
    await pool.end();
  }
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await main();
}
