import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { createOwnerPool, withOwnerTx } from "./copy.js";
import { TABLE_LOADERS, parseLoadScale } from "./load.js";
import { manifestPathFor, readManifest } from "./manifest.js";
import { loadSeedsFile, type SeedsFile } from "./seeds.js";

interface CheckClient {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

function num(value: unknown): number {
  if (value === null || value === undefined) {
    throw new Error(`expected a numeric cell, got ${String(value)} (empty table?)`);
  }
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a finite numeric cell, got ${String(value)}`);
  }
  return n;
}

function isSmallScale(datasetVersion: string): boolean {
  return datasetVersion.endsWith("-small");
}

export interface VerifyReport {
  failures: string[];
  checkedTables: number;
  checkedSeeds: number;
}

export async function runChecks(
  client: CheckClient,
  manifest: { tables: Record<string, { rows: number }> },
  seeds: SeedsFile,
  datasetVersion: string,
): Promise<VerifyReport> {
  const failures: string[] = [];
  const fail = (message: string): void => {
    failures.push(message);
  };

  const small = isSmallScale(datasetVersion);

  let checkedTables = 0;
  const emptyTables: string[] = [];
  for (const [name, def] of Object.entries(TABLE_LOADERS)) {
    const expected = manifest.tables[name]?.rows;
    if (expected === undefined) {
      fail(`count ${def.table}: missing from seed manifest`);
      continue;
    }
    const result = await client.query(
      `SELECT COUNT(*) AS n FROM ${def.table}`,
    );
    const actual = num(result.rows[0]?.["n"]);
    checkedTables += 1;
    if (actual === 0) emptyTables.push(def.table);
    console.log(`count ${def.table}: ${String(actual)} rows (manifest ${String(expected)})`);
    if (actual !== expected) {
      fail(
        `count ${def.table}: ${String(actual)} rows != manifest ${String(expected)}`,
      );
    }
  }

  const fkChecks: Array<[string, string]> = [
    ["customers.province", "SELECT COUNT(*) AS n FROM public.customers c LEFT JOIN public.regions r ON r.province = c.province WHERE c.province IS NOT NULL AND r.province IS NULL"],
    ["sellers.province", "SELECT COUNT(*) AS n FROM public.sellers s LEFT JOIN public.regions r ON r.province = s.province WHERE s.province IS NOT NULL AND r.province IS NULL"],
    ["employees.province", "SELECT COUNT(*) AS n FROM public.employees e LEFT JOIN public.regions r ON r.province = e.province WHERE e.province IS NOT NULL AND r.province IS NULL"],
    ["products.category_id", "SELECT COUNT(*) AS n FROM public.products p LEFT JOIN public.categories c ON c.category_id = p.category_id WHERE c.category_id IS NULL"],
    ["orders.customer_id", "SELECT COUNT(*) AS n FROM public.orders o LEFT JOIN public.customers c ON c.customer_id = o.customer_id WHERE c.customer_id IS NULL"],
    ["orders.channel_id", "SELECT COUNT(*) AS n FROM public.orders o LEFT JOIN public.channels ch ON ch.channel_id = o.channel_id WHERE ch.channel_id IS NULL"],
    ["order_items.order_id", "SELECT COUNT(*) AS n FROM public.order_items i LEFT JOIN public.orders o ON o.order_id = i.order_id WHERE o.order_id IS NULL"],
    ["order_items.product_id", "SELECT COUNT(*) AS n FROM public.order_items i LEFT JOIN public.products p ON p.product_id = i.product_id WHERE p.product_id IS NULL"],
    ["order_items.seller_id", "SELECT COUNT(*) AS n FROM public.order_items i LEFT JOIN public.sellers s ON s.seller_id = i.seller_id WHERE s.seller_id IS NULL"],
    ["payments.order_id", "SELECT COUNT(*) AS n FROM public.payments p LEFT JOIN public.orders o ON o.order_id = p.order_id WHERE o.order_id IS NULL"],
    ["reviews.order_id", "SELECT COUNT(*) AS n FROM public.reviews r LEFT JOIN public.orders o ON o.order_id = r.order_id WHERE o.order_id IS NULL"],
  ];
  for (const [label, sql] of fkChecks) {
    const result = await client.query(sql);
    const orphans = num(result.rows[0]?.["n"]);
    console.log(`fk ${label}: ${String(orphans)} orphans`);
    if (orphans !== 0) {
      fail(`fk ${label}: ${String(orphans)} orphan rows`);
    }
  }

  // Record zero-row or NULL aggregates on empty/partial DBs as per-seed failures instead of aborting.
  let checkedSeeds = 0;
  const guarded = async (id: string, check: () => Promise<void>): Promise<void> => {
    try {
      await check();
    } catch (error) {
      fail(`seed ${id}: ${(error as Error).message}`);
    }
  };
  const single = async (sql: string): Promise<Record<string, unknown>> => {
    const result = await client.query(sql);
    const row = result.rows[0];
    if (!row) throw new Error(`reference query returned zero rows: ${sql}`);
    return row;
  };
  const inBand = (
    id: string,
    actual: number,
    lo: number,
    hi: number,
  ): void => {
    console.log(`seed ${id}: ${String(actual)} (band [${String(lo)}, ${String(hi)}])`);
    if (actual < lo || actual > hi) {
      fail(`seed ${id}: ${String(actual)} outside band [${String(lo)}, ${String(hi)}]`);
    }
  };

  for (const entry of seeds.scenarios_uc05) {
    checkedSeeds += 1;
    await guarded(entry.id, async () => {
      const row = await single(entry.reference_sql);
      if (entry.id === "uc05-shopee-trung-dogiadung") {
        inBand(entry.id, num(row["pct"]), -0.3, -0.08);
      } else if (entry.id === "uc05-danang-returns-surge") {
        const count = num(row["danang_returns"]);
        // Small scale flips ~68 Đà Nẵng orders (+10 A1 rows) vs 200+ at full scale.
        const floor = small ? 40 : 100;
        console.log(`seed ${entry.id}: ${String(count)} (floor ${String(floor)})`);
        if (count < floor) {
          fail(`seed ${entry.id}: ${String(count)} below floor ${String(floor)}`);
        }
      } else if (entry.id === "uc05-lazada-nam-diengiadung") {
        inBand(entry.id, num(row["pct"]), -0.2, -0.05);
      } else {
        fail(`seed ${entry.id}: no assertion rule registered`);
      }
    });
  }

  for (const entry of seeds.anomalies_uc10) {
    checkedSeeds += 1;
    await guarded(entry.id, async () => {
      const row = await single(entry.reference_sql);
      if (entry.id === "uc10-danang-returns-x4") {
        const count = num(row["danang_returns"]);
        const prev = await single(
          "SELECT COUNT(*) AS n FROM public.orders o JOIN public.customers c USING (customer_id) WHERE c.province = 'Đà Nẵng' AND o.status = 'returned' AND o.purchase_date >= '2026-09-13' AND o.purchase_date < '2026-09-14'",
        );
        const prevCount = num(prev["n"]);
        console.log(`seed ${entry.id}: ${String(count)} (prev-day ${String(prevCount)}, floor 10)`);
        if (count < 10 || count < 2 * prevCount) {
          fail(`seed ${entry.id}: ${String(count)} below floor 10 or 2x prev-day ${String(prevCount)}`);
        }
      } else if (entry.id === "uc10-sharp-revenue-drop") {
        inBand(entry.id, num(row["wow"]), -1, -0.45);
      } else if (entry.id === "uc10-hcm-revenue-spike") {
        // Loader adds 1.5x of the day's own baseline (~2.5x total), but verify compares against
        // the noisier trailing-7-day average, so 1.5x proves the spike without duplicating private state.
        const day = num(row["hcm_revenue"]);
        const base = await single(
          "SELECT SUM(CASE WHEN o.purchase_date >= '2026-09-02' AND o.purchase_date < '2026-09-09' THEN i.price_vnd ELSE 0 END)::float / 7 AS avg_rev FROM public.order_items i JOIN public.orders o USING (order_id) JOIN public.customers c USING (customer_id) WHERE c.province = 'TP.HCM' AND o.status = 'delivered'",
        );
        const avg = num(base["avg_rev"]);
        const ratio = avg === 0 ? Number.POSITIVE_INFINITY : day / avg;
        console.log(`seed ${entry.id}: day ${String(day)} vs week-avg ${String(avg)} (ratio ${String(ratio)}, floor 1.5)`);
        if (ratio < 1.5) {
          fail(`seed ${entry.id}: spike ratio ${String(ratio)} below 1.5`);
        }
      } else if (entry.id === "uc10-hanoi-orders-spike") {
        const count = num(row["hanoi_orders"]);
        const prev = await single(
          "SELECT COUNT(*) AS n FROM public.orders o JOIN public.customers c USING (customer_id) WHERE c.province = 'Hà Nội' AND o.purchase_date >= '2026-09-15' AND o.purchase_date < '2026-09-16'",
        );
        const prevCount = num(prev["n"]);
        const ratio = prevCount === 0 ? Number.POSITIVE_INFINITY : count / prevCount;
        console.log(`seed ${entry.id}: ${String(count)} vs prev-day ${String(prevCount)} (ratio ${String(ratio)}, floor 1.5)`);
        if (ratio < 1.5) {
          fail(`seed ${entry.id}: spike ratio ${String(ratio)} below 1.5`);
        }
      } else if (entry.id === "uc10-aov-drop") {
        inBand(entry.id, num(row["aov_change"]), -1, -0.17);
      } else {
        fail(`seed ${entry.id}: no assertion rule registered`);
      }
    });
  }

  for (const entry of seeds.injections) {
    const result = await client.query(entry.reference_sql);
    checkedSeeds += 1;
    console.log(`seed ${entry.id}: ${String(result.rows.length)} rows (floor 1)`);
    if (result.rows.length < 1) {
      fail(`seed ${entry.id}: injection payload missing from public.products`);
    }
  }

  if (emptyTables.length === checkedTables && checkedTables > 0) {
    failures.unshift(
      "database has no business rows (every table is empty) — load the seed data first (pnpm docker:data or pnpm data:load)",
    );
  }

  return { failures, checkedTables, checkedSeeds };
}

export async function main(): Promise<void> {
  const manifest = readManifest(manifestPathFor(parseLoadScale(process.argv)));
  const seeds = loadSeedsFile();
  const pool = createOwnerPool();
  try {
    const report = await withOwnerTx(pool, async (client: PoolClient) => {
      // Runs read-only inside withOwnerTx; committing an empty write set leaves the DB untouched.
      return runChecks(
        { query: (sql: string) => client.query(sql) },
        manifest,
        seeds,
        manifest.dataset_version,
      );
    });
    console.log(
      `verify: ${String(report.checkedTables)} tables, ${String(report.checkedSeeds)} seed signals checked`,
    );
    if (report.failures.length > 0) {
      console.error(`verify FAIL: ${report.failures[0]}`);
      for (const extra of report.failures.slice(1)) {
        console.error(`verify FAIL: ${extra}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log("verify: PASS");
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
