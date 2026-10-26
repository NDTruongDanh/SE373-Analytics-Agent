// Tracer load pipeline (Phase 2, plan 02-01): COPY-loads the registered
// tables through the owner role and writes data/seed_manifest.json. Later
// plans register the remaining tables here; the `--tables` filter selects a
// subset (default: every registered table). Single seeded faker instance —
// the only RNG in the pipeline (SEED_DATA, default 42).
import { pathToFileURL } from "node:url";
import { Faker, base, en, vi } from "@faker-js/faker";
import type { Pool, PoolClient } from "pg";
import { copyTable, createOwnerPool, withOwnerTx } from "./copy.js";
import {
  compareManifests,
  DATASET_VERSION,
  DEFAULT_MANIFEST_PATH,
  hashCanonicalCsv,
  readManifest,
  type SeedManifest,
  writeManifest,
} from "./manifest.js";

const SEED = Number(process.env["SEED_DATA"] ?? 42);

// The single RNG for the whole pipeline. Regions are static rows, but every
// later synthetic table draws from this instance so one seed reproduces the DB.
export const faker = new Faker({ locale: [vi, en, base] });
faker.seed(SEED);

export interface TableLoader {
  table: string;
  columns: readonly string[];
  pk: string;
  rows(): (readonly unknown[])[];
}

// 34 post-merger provinces (Res. 202/2025/QH15, effective 2025-07-01) grouped
// into the three Bắc/Trung/Nam regions per D-01.
const REGION_ROWS: (readonly [string, string])[] = [
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

export const TABLE_LOADERS: Record<string, TableLoader> = {
  regions: {
    table: "business.regions",
    columns: ["province", "region_group"] as const,
    pk: "province",
    rows: () => REGION_ROWS,
  },
};

function parseTablesFilter(argv: readonly string[]): string[] {
  const flag = argv.find((arg) => arg.startsWith("--tables="));
  if (!flag) return Object.keys(TABLE_LOADERS);
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
  return wanted;
}

async function canonicalCsvFor(
  client: PoolClient,
  loader: TableLoader,
): Promise<{ rows: number; sha256: string }> {
  const result = await client.query(
    `SELECT ${loader.columns.join(", ")} FROM ${loader.table} ORDER BY ${loader.pk}`,
  );
  const lines = (result.rows as Record<string, unknown>[]).map((row) =>
    loader.columns.map((column) => String(row[column])).join(","),
  );
  return {
    rows: lines.length,
    sha256: hashCanonicalCsv(lines.join("\n")),
  };
}

export async function loadTables(
  pool: Pool,
  tableNames: readonly string[],
): Promise<SeedManifest> {
  const tables: SeedManifest["tables"] = {};
  for (const name of tableNames) {
    const loader = TABLE_LOADERS[name];
    if (!loader) throw new Error(`Unknown table "${name}"`);
    await withOwnerTx(pool, async (client) => {
      // DELETE (not TRUNCATE): regions is FK-referenced by customers, sellers,
      // and employees, so TRUNCATE needs CASCADE — a footgun once later plans
      // load dependents first. DELETE is FK-safe at any scale the dev loader
      // needs; 02-03 may switch to an ordered whole-registry TRUNCATE.
      await client.query(`DELETE FROM ${loader.table}`);
      const count = await copyTable(client, loader.table, loader.columns, loader.rows());
      const checksum = await canonicalCsvFor(client, loader);
      if (checksum.rows !== count) {
        throw new Error(
          `COPY/readback mismatch on ${loader.table}: wrote ${String(count)}, read ${String(checksum.rows)}`,
        );
      }
      tables[name] = checksum;
    });
  }
  return { version: 1, seed: SEED, dataset_version: DATASET_VERSION, tables };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const tableNames = parseTablesFilter(argv);
  const pool = createOwnerPool();
  try {
    const manifest = await loadTables(pool, tableNames);
    let previous: SeedManifest | null = null;
    try {
      previous = readManifest(DEFAULT_MANIFEST_PATH);
    } catch {
      previous = null; // First load: no manifest yet, write it below.
    }
    if (previous) {
      const mismatches = compareManifests(manifest, previous);
      if (mismatches.length > 0) {
        throw new Error(
          `Manifest mismatch — refusing to finish:\n${mismatches.join("\n")}`,
        );
      }
    }
    writeManifest(manifest, DEFAULT_MANIFEST_PATH);
    for (const name of tableNames) {
      const entry = manifest.tables[name];
      if (entry) {
        console.log(`loaded ${name}: ${String(entry.rows)} rows sha256=${entry.sha256}`);
      }
    }
    console.log(`manifest: ${DEFAULT_MANIFEST_PATH}`);
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
