// PORT-02 store tests (01-13): DB-free unit legs with a stub pool injected
// at the DAO boundary, plus skip-if-no-DB live legs against the real 01-04
// schema per D-21 (same file keeps the real pg driver unmocked).
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  AppStateStore,
  sha256Fingerprint,
  type AlertRecord,
  type PoolLike,
} from "../src/store/alertStore.js";
import { createHostPorts } from "../src/ports.js";

// ---------------------------------------------------------------------------
// Stub pool (unit legs only): records queries, serves scripted rows.
// ---------------------------------------------------------------------------
interface Call {
  text: string;
  params: unknown[];
}

function makeStub(rows: Array<Record<string, unknown>> = []) {
  const state = { calls: [] as Call[], ended: 0 };
  const pool: PoolLike = {
    async query(text: string, params: unknown[]) {
      state.calls.push({ text, params });
      return { rows };
    },
    async end() {
      state.ended += 1;
    },
  };
  return { pool, state };
}

const ROW: AlertRecord = {
  recipientId: "sales_south",
  metric: "revenue_drop",
  dimensionKey: "category:electronics",
  date: "2026-09-01",
  direction: "down",
};

describe("sha256Fingerprint", () => {
  it("is deterministic and matches the canonical pipe-joined order", () => {
    const expected = createHash("sha256")
      .update(
        "sales_south|revenue_drop|category:electronics|2026-09-01|down",
        "utf8",
      )
      .digest("hex");
    expect(sha256Fingerprint(ROW)).toBe(expected);
    expect(sha256Fingerprint(ROW)).toHaveLength(64);
  });

  it.each([
    [{ ...ROW, recipientId: "marketing" }],
    [{ ...ROW, metric: "order_spike" }],
    [{ ...ROW, dimensionKey: "category:books" }],
    [{ ...ROW, date: "2026-09-02" }],
    [{ ...ROW, direction: "up" }],
  ])("flips on any single field change (%o)", (changed) => {
    expect(sha256Fingerprint(changed)).not.toBe(sha256Fingerprint(ROW));
  });
});

describe("AppStateStore (stub pool)", () => {
  it("throws fail-fast on an empty connection string", () => {
    const { pool, state } = makeStub();
    expect(() => new AppStateStore("", pool)).toThrow(/non-empty/);
    expect(state.calls).toHaveLength(0);
  });

  it("hasFingerprint routes false/true without writing", async () => {
    const empty = makeStub([]);
    const store = new AppStateStore(
      "postgresql://harness_state:x@/chosen",
      empty.pool,
    );
    await expect(store.hasFingerprint("abc")).resolves.toBe(false);
    expect(empty.state.calls).toHaveLength(1);
    const select = empty.state.calls[0] as Call;
    expect(select.text).toBe(
      "SELECT 1 FROM app_state.alert_history WHERE fingerprint = $1",
    );
    expect(select.params).toEqual(["abc"]);
    expect(select.text).not.toContain("abc");
    await store.close();

    const full = makeStub([{ "?column?": 1 }]);
    const store2 = new AppStateStore(
      "postgresql://harness_state:x@/chosen",
      full.pool,
    );
    await expect(store2.hasFingerprint("abc")).resolves.toBe(true);
    expect(
      full.state.calls.every((c) => !/^insert/i.test(c.text.trim())),
    ).toBe(true);
    await store2.close();
  });

  it("recordSent issues exactly one parameterized INSERT on the sent path", async () => {
    const { pool, state } = makeStub();
    const store = new AppStateStore("postgresql://harness_state:x@/chosen", pool);
    await store.recordSent(ROW);
    expect(state.calls).toHaveLength(1);
    const insert = state.calls[0] as Call;
    expect(insert.text).toContain("INSERT INTO app_state.alert_history");
    expect(insert.text).toContain("VALUES ($1, $2, $3, $4, $5, $6)");
    expect(insert.params).toEqual([
      sha256Fingerprint(ROW),
      ROW.recipientId,
      ROW.metric,
      ROW.dimensionKey,
      ROW.date,
      ROW.direction,
    ]);
    // No fingerprint literal is interpolated into the SQL text.
    expect(insert.text).not.toContain(insert.params[0] as string);
    await store.close();
    expect(state.ended).toBe(1);
  });

  it("recordSent honors a caller-provided fingerprint", async () => {
    const { pool, state } = makeStub();
    const store = new AppStateStore("postgresql://harness_state:x@/chosen", pool);
    await store.recordSent({ ...ROW, fingerprint: "precomputed" });
    expect(state.calls).toHaveLength(1);
    expect((state.calls[0] as Call).params[0]).toBe("precomputed");
    await store.close();
  });
});

describe("createHostPorts", () => {
  it("throws fail-fast when HARNESS_STATE_DATABASE_URL is absent (DB-free)", async () => {
    await expect(createHostPorts({})).rejects.toThrow(
      /HARNESS_STATE_DATABASE_URL/,
    );
  });
});

// ---------------------------------------------------------------------------
// Live legs: run only with HARNESS_STATE_DATABASE_URL (D-21).
// ---------------------------------------------------------------------------
const LIVE_URL = process.env["HARNESS_STATE_DATABASE_URL"];
const describeLive = describe.skipIf(!LIVE_URL);
const LIVE_FP = `__0113_ports_live__${sha256Fingerprint(ROW).slice(0, 12)}`;

describeLive("AppStateStore live (requires HARNESS_STATE_DATABASE_URL)", () => {
  const opened: AppStateStore[] = [];

  afterAll(async () => {
    for (const s of opened) {
      await s.close().catch(() => undefined);
    }
    // Best-effort probe cleanup: leave alert_history exactly as found.
    if (LIVE_URL) {
      const pool = new Pool({ connectionString: LIVE_URL, max: 1 });
      await pool
        .query("DELETE FROM app_state.alert_history WHERE fingerprint = $1", [
          LIVE_FP,
        ])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  });

  it("reports false, records after send, then reports true", async () => {
    const store = new AppStateStore(LIVE_URL as string);
    opened.push(store);
    await expect(store.hasFingerprint(LIVE_FP)).resolves.toBe(false);
    await store.recordSent({ ...ROW, fingerprint: LIVE_FP });
    await expect(store.hasFingerprint(LIVE_FP)).resolves.toBe(true);
  });

  it("rejects a duplicate fingerprint with a PRIMARY KEY conflict", async () => {
    const dup = new AppStateStore(LIVE_URL as string);
    opened.push(dup);
    const err = await dup
      .recordSent({ ...ROW, fingerprint: LIVE_FP })
      .then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    expect(err?.code).toBe("23505");
  });

  it("createHostPorts builds both ports from env", async () => {
    const ports = await createHostPorts({
      HARNESS_STATE_DATABASE_URL: LIVE_URL,
    });
    expect(ports.checkpointer).toBeDefined();
    expect(ports.store).toBeInstanceOf(AppStateStore);
    await ports.store.close();
  });
});
