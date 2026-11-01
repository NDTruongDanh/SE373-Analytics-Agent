// Shared magic values for the data package (single source of truth).
// Each value used to live in its feature module; the original modules keep a
// compat re-export so existing importers keep working. No schemas, types,
// functions, or instances live here — only plain values.
import { fileURLToPath } from "node:url";
import type { OlistFileEntry } from "./download.js";
import type { LoadScale, TableDef } from "./load.js";

// ---- download.ts ----

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
      "8df58ef3d2d7e9944013f7beecd9b75367f5588ec6e3c91cec19ae3345ef9ecf",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_order_items_dataset.csv",
    businessTable: "order_items",
    bytes: 15007623,
    blobSha: "469094c4785f82d594796efe376fd18fdd1596b4",
    sha256:
      "4f6abdbbc94036d0df4a76fa0520c072e31a40119d70f7f370fba1e2285d5bcb",
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
      "61674868ed7b872aac3dcd95bf774448a88f642b183f21be55f75af021ffdec",
    mode: "blob-sha",
    bom: false,
  },
  {
    name: "olist_order_reviews_dataset.csv",
    businessTable: "reviews",
    bytes: 14451670,
    blobSha: "2c32975b59dfa8335963fd4e94e3bebd60bd16f6",
    sha256:
      "012b61c7593e34f51fa614efdf802b9c7056ce6aae5307ddb93236e7cf7d7f7",
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

// ---- load.ts ----

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

// ---- manifest.ts ----

// Manifest written by `pnpm data:load`, resolved from this module's location
// so it works regardless of the caller's cwd.
export const DEFAULT_MANIFEST_PATH = fileURLToPath(
  new URL("../../../data/seed_manifest.json", import.meta.url),
);

// One committed manifest per scale, so a CI small load and a local full load
// each reproduce their own pinned checksums instead of tripping the gate.
export const SMALL_MANIFEST_PATH = fileURLToPath(
  new URL("../../../data/seed_manifest.small.json", import.meta.url),
);

export const DATASET_VERSION = "olist-vi-2025-2026-v1";

// ---- seeds.ts ----

// Seeds file resolved from this module's location so the default works
// regardless of the caller's cwd (src and dist layouts both sit two levels
// below the repo root).
export const DEFAULT_SEEDS_PATH = fileURLToPath(
  new URL("./seeds.json", import.meta.url),
);

// ---- transform.ts ----

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

// Fixed VND conversion: round(BRL × 5150 / 1000) × 1000. Rate ≈ Oct-2025
// market 5,095–5,162, documented as a constant in README per DATA-07.
export const BRL_TO_VND_RATE = 5150;

// Date shift: +2905 days (415 weeks — weekday-preserving by construction,
// verified Wed→Wed in RESEARCH), applied in UTC. Orders landing before
// 2025-01-01 are clipped (return null) per Pitfall P5 so 2027 stays empty
// and Sept-2026 scenarios land in-window. Accepts "YYYY-MM-DD" or
// "YYYY-MM-DD HH:MM:SS" (space or T separator), preserving the time part.
export const SHIFT_DAYS = 2905;
export const DATASET_MIN_DATE = "2025-01-01";

// ---- index.ts ----

export const DATA_SHELL =
  "Data shell: Olist download/transform/load lands in 01-07";
