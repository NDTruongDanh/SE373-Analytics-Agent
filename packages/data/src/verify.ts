// Data verifier (Phase 1, plan 01-07, DB-08): `pnpm data:verify` asserts the
// loaded `public.*` database is complete and every seeded scenario still
// returns its designed signal. Connects as owner, runs SELECT/COUNT only
// (zero DDL — the loader owns writes, the DDL lives in docker/initdb).
//
// Exit contract: 0 on full pass, 1 naming the first failing assertion.
// Single-pass aggregation throughout: every check is one COUNT/SUM aggregate
// query (the v1 O(n-squared) loader-scan shape is not repeated here).
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { createOwnerPool, withOwnerTx } from "./copy.js";
import { TABLE_LOADERS } from "./load.js";
import { DEFAULT_MANIFEST_PATH, readManifest } from "./manifest.js";
import { loadSeedsFile, type SeedsFile } from "./seeds.js";

// Every check funnels through this row shape: one numeric cell.
interface CheckClient {
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a finite numeric cell, got ${String(value)}`);
  }
  return n;
}

// Scale-aware count floors for the two absolute-count scenarios (everything
// else is ratio-based and scale-free). Measured at authoring time: small
// EC-02 flips every available Đà Nẵng order (68) plus 10 synthesized A1
// rows; full flips the capped 200 plus the same synthesis.
function isSmallScale(datasetVersion: string): boolean {
  return datasetVersion.endsWith("-small");
}

export interface VerifyReport {
  failures: string[];
  checkedTables: number;
  checkedSeeds: number;
}

// Runs every assertion against the connected database. Pure over its inputs
// (manifest + seeds + client), so unit tests can drive it with a stub client
// and no database.
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

  // -- 1. Per-table row counts match the manifest from the load --
  let checkedTables = 0;
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
    console.log(`count ${def.table}: ${String(actual)} rows (manifest ${String(expected)})`);
    if (actual !== expected) {
      fail(
        `count ${def.table}: ${String(actual)} rows != manifest ${String(expected)}`,
      );
    }
  }

  // -- 2. FK integrity: every child row must resolve its parent --
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

  // -- 3. Every seeded scenario returns its designed magnitude signal --
  let checkedSeeds = 0;
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
    const row = await single(entry.reference_sql);
    checkedSeeds += 1;
    if (entry.id === "uc05-shopee-trung-dogiadung") {
      inBand(entry.id, num(row["pct"]), -0.3, -0.08);
    } else if (entry.id === "uc05-danang-returns-surge") {
      const count = num(row["danang_returns"]);
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
  }

  for (const entry of seeds.anomalies_uc10) {
    const row = await single(entry.reference_sql);
    checkedSeeds += 1;
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
      // The loader adds 1.5x the day's own pre-spike baseline (final ~= 2.5x
      // that baseline), but verify can only measure against the noisier
      // trailing-7-day proxy, so the gate is 1.5x — it proves the spike
      // without re-deriving the loader's private baseline.
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
  }

  for (const entry of seeds.injections) {
    const result = await client.query(entry.reference_sql);
    checkedSeeds += 1;
    console.log(`seed ${entry.id}: ${String(result.rows.length)} rows (floor 1)`);
    if (result.rows.length < 1) {
      fail(`seed ${entry.id}: injection payload missing from public.products`);
    }
  }

  return { failures, checkedTables, checkedSeeds };
}

export async function main(): Promise<void> {
  const manifest = readManifest(DEFAULT_MANIFEST_PATH);
  const seeds = loadSeedsFile();
  const pool = createOwnerPool();
  try {
    const report = await withOwnerTx(pool, async (client: PoolClient) => {
      // withOwnerTx opens a transaction; verify runs read-only inside it and
      // always rolls back via the helper (no writes issued, COMMIT of an
      // empty write set keeps the database untouched).
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
