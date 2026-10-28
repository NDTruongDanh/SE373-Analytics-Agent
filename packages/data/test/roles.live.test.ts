// Live role-proof suite (Phase 1, plan 01-07, DB-02): proves the 01-04
// grant layer with committed vitest legs instead of throwaway psql probes.
// The whole suite gates on all four role URLs: without them it skips green
// (CI has no DB per D-10/D-21). Credentials never appear in assertions or
// test names — only SQLSTATE codes are asserted. G-02 hygiene: a
// current_user preflight asserts every URL maps to its expected role before
// any write attempt, and every public.* probe write runs inside a
// transaction that always ROLLBACKs, so a mis-mapped DATABASE_URL can never
// leave __probe__ residue behind.
//
// Probe tables: owner creates the semantic probe (ALTER DEFAULT PRIVILEGES
// already grants indexer DML on owner-created semantic tables); harness_state
// creates and drops its own langgraph probe because owner holds zero rights
// in harness_state-owned schemas; indexer creates and drops its own semantic
// probe. The suite asserts denials and never grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const OWNER_URL = process.env["OWNER_DATABASE_URL"];
const RO_URL = process.env["DATABASE_URL"];
const INDEXER_URL = process.env["INDEXER_DATABASE_URL"];
const HARNESS_URL = process.env["HARNESS_STATE_DATABASE_URL"];

// G-02: every configured URL must resolve to its expected role BEFORE any
// probe write runs. A mis-mapped DATABASE_URL (e.g. owner) would turn the
// denial legs into real writes and leave __probe__ residue in public.*.
const EXPECTED_ROLES: Record<string, { url: string | undefined; role: string }> = {
  OWNER_DATABASE_URL: { url: OWNER_URL, role: "owner" },
  DATABASE_URL: { url: RO_URL, role: "agent_ro" },
  INDEXER_DATABASE_URL: { url: INDEXER_URL, role: "indexer" },
  HARNESS_STATE_DATABASE_URL: { url: HARNESS_URL, role: "harness_state" },
};

async function preflightRoleIdentity(): Promise<void> {
  for (const [envVar, expected] of Object.entries(EXPECTED_ROLES)) {
    const client = newClient(expected.url);
    try {
      await client.connect();
      const seen = await client.query("SELECT current_user AS role");
      const actual = (seen.rows[0] as { role: string }).role;
      if (actual !== expected.role) {
        throw new Error(
          `role preflight failed: ${envVar} is connected as '${actual}', expected '${expected.role}' — refusing probe writes (a mis-mapped DATABASE_URL would leave __probe__ residue in public.*)`,
        );
      }
    } finally {
      await client.end();
    }
  }
}

// DATABASE_URL is the agent_ro URL in this suite's invocation (the plan's
// <verify> passes the agent_ro URL explicitly); owner/indexer/harness_state
// arrive on their own variables.
const hasAll = !!OWNER_URL && !!RO_URL && !!INDEXER_URL && !!HARNESS_URL;

function newClient(url: string | undefined): Client {
  return new Client({ connectionString: url });
}

async function codeOf(
  client: Client,
  sql: string,
): Promise<string | undefined> {
  return client.query(sql).then(
    () => undefined,
    (err: unknown) => (err as { code?: string }).code,
  );
}

// One write attempt as agent_ro with the read-only default switched off via
// a session SET in a PRIOR call (same reason as the old comment: folding SET
// into the write transaction keeps the read-only snapshot and yields a
// misleading 25006 instead of the grant-level 42501 this suite asserts), then
// the probe statement inside an explicit transaction that always ROLLBACKs,
// so even a mis-mapped connection (which the preflight above already
// rejects) can never persist a __probe__ row.
async function attemptRoWrite(sql: string): Promise<string | undefined> {
  const client = newClient(RO_URL);
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = off");
    await client.query("BEGIN");
    try {
      return await codeOf(client, sql);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasAll)(
  "roles live (requires OWNER/DATABASE(agent_ro)/INDEXER/HARNESS_STATE URLs)",
  () => {
    let owner: Client;
    let indexer: Client;
    let harness: Client;

    beforeAll(async () => {
      await preflightRoleIdentity();
      owner = newClient(OWNER_URL);
      indexer = newClient(INDEXER_URL);
      harness = newClient(HARNESS_URL);
      await owner.connect();
      await indexer.connect();
      await harness.connect();
      // Owner-created semantic probe: default privileges already let the
      // indexer write it, so the indexer RW leg below must succeed.
      await owner.query(
        "CREATE TABLE IF NOT EXISTS semantic.roleproof_probe (id integer)",
      );
      // harness_state owns langgraph — it creates its own probe (owner has
      // zero rights there by D-08, so owner-created setup is impossible).
      await harness.query(
        "CREATE TABLE IF NOT EXISTS langgraph.roleproof_probe (id integer)",
      );
      await indexer.query(
        "CREATE TABLE IF NOT EXISTS semantic.idx_probe (id integer)",
      );
    });

    afterAll(async () => {
      try {
        await owner.query("DROP TABLE IF EXISTS semantic.roleproof_probe");
        await harness.query("DROP TABLE IF EXISTS langgraph.roleproof_probe");
        await indexer.query("DROP TABLE IF EXISTS semantic.idx_probe");
      } finally {
        await owner.end();
        await indexer.end();
        await harness.end();
      }
    });

    it("agent_ro reads public.orders unqualified and semantic chunks", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const orders = await client.query(
          "SELECT count(*)::int AS n FROM orders",
        );
        expect((orders.rows[0] as { n: number }).n).toBeGreaterThan(0);
        const chunks = await client.query(
          "SELECT count(*)::int AS n FROM semantic.semantic_chunks",
        );
        expect((chunks.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(0);
      } finally {
        await client.end();
      }
    });

    it("agent_ro INSERT fails 42501 after the read-only override", async () => {
      const code = await attemptRoWrite(
        "INSERT INTO public.customers (customer_id, name, phone, email, address, province, region_group) VALUES ('__probe__', 'x', 'x', 'x', 'x', 'Hà Nội', 'Bắc')",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro UPDATE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "UPDATE public.customers SET name = 'x' WHERE customer_id = '__probe__'",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro DELETE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "DELETE FROM public.customers WHERE customer_id = '__probe__'",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro default-path write fails 25006", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        await client.query("BEGIN");
        try {
          const code = await codeOf(
            client,
            "INSERT INTO public.customers (customer_id, name, phone, email, address, province, region_group) VALUES ('__probe__', 'x', 'x', 'x', 'x', 'Hà Nội', 'Bắc')",
          );
          expect(code).toBe("25006");
        } finally {
          await client.query("ROLLBACK");
        }
      } finally {
        await client.end();
      }
    });

    it("agent_ro CREATE TEMP TABLE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "CREATE TEMP TABLE roleproof_tmp (id integer)",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro nextval without sequence USAGE fails 42501", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const code = await codeOf(
          client,
          "SELECT nextval('public.order_items_order_item_id_seq')",
        );
        expect(code).toBe("42501");
      } finally {
        await client.end();
      }
    });

    it("agent_ro SET ROLE fails 42501 (no memberships)", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const code = await codeOf(client, "SET ROLE owner");
        expect(code).toBe("42501");
      } finally {
        await client.end();
      }
    });

    it(
      "agent_ro statement timeout fires 57014 on pg_sleep",
      async () => {
        const client = newClient(RO_URL);
        try {
          await client.connect();
          await client.query("BEGIN");
          await client.query("SET LOCAL statement_timeout = '1s'");
          const code = await codeOf(client, "SELECT pg_sleep(2)");
          expect(code).toBe("57014");
          await client.query("ROLLBACK");
        } finally {
          await client.end();
        }
      },
      15000,
    );

    it("harness_state SELECT on public.orders fails 42501", async () => {
      const code = await codeOf(harness, "SELECT count(*) FROM public.orders");
      expect(code).toBe("42501");
    });

    it("harness_state writes langgraph and app_state", async () => {
      await harness.query(
        "INSERT INTO langgraph.roleproof_probe (id) VALUES (1)",
      );
      const seen = await harness.query(
        "SELECT count(*)::int AS n FROM langgraph.roleproof_probe",
      );
      expect((seen.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
      await harness.query(
        "INSERT INTO app_state.alert_history (fingerprint, recipient_id, metric, dimension_key, alert_date, direction) VALUES ('__roleproof__', '__roleproof__', '__roleproof__', '__roleproof__', '2026-09-01', 'up')",
      );
      const alerts = await harness.query(
        "SELECT count(*)::int AS n FROM app_state.alert_history WHERE fingerprint = '__roleproof__'",
      );
      expect((alerts.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
      await harness.query(
        "DELETE FROM app_state.alert_history WHERE fingerprint = '__roleproof__'",
      );
      await harness.query("DELETE FROM langgraph.roleproof_probe WHERE id = 1");
    });

    it("indexer INSERT on public.orders fails 42501", async () => {
      const code = await codeOf(
        indexer,
        "INSERT INTO public.orders (order_id, customer_id, channel_id, status, purchase_date) VALUES ('__probe__', '__probe__', 'shopee', 'delivered', '2026-09-01 00:00:00')",
      );
      expect(code).toBe("42501");
    });

    it("indexer writes semantic tables", async () => {
      await indexer.query("INSERT INTO semantic.idx_probe (id) VALUES (1)");
      const seen = await indexer.query(
        "SELECT count(*)::int AS n FROM semantic.idx_probe",
      );
      expect((seen.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
      await indexer.query(
        "INSERT INTO semantic.roleproof_probe (id) VALUES (1)",
      );
      const ownerMade = await indexer.query(
        "SELECT count(*)::int AS n FROM semantic.roleproof_probe",
      );
      expect((ownerMade.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1);
      await indexer.query("DELETE FROM semantic.idx_probe WHERE id = 1");
      await indexer.query(
        "DELETE FROM semantic.roleproof_probe WHERE id = 1",
      );
    });

    it("agent_ro cannot read app_state tables", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const code = await codeOf(
          client,
          "SELECT count(*) FROM app_state.alert_history",
        );
        expect(code).toBe("42501");
      } finally {
        await client.end();
      }
    });
  },
);
