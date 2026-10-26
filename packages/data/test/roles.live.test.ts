// Role-proof matrix (Phase 2, DB-03/DB-04, D-06): proves at the DB layer that
// agent_ro cannot write after the read-only override. Follows the
// db.live.test.ts gate plus Pool plus finally-end shape; DATABASE_URL points
// at agent_ro. Pitfall P1: the SET override and the write are SEPARATE driver
// calls — combining them in one string stays in one implicit transaction and
// yields a misleading 25006 instead of the grant-level 42501 this suite
// asserts. Credentials never appear in assertions or names.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const OWNER_URL = process.env["OWNER_DATABASE_URL"];
const RO_URL = process.env["DATABASE_URL"];
const INDEXER_URL = process.env["INDEXER_DATABASE_URL"];

// All three roles required: owner sets up/tears down probe tables, agent_ro
// and indexer run the matrix legs.
const hasAll = !!OWNER_URL && !!RO_URL && !!INDEXER_URL;

function newClient(url: string | undefined): Client {
  return new Client({ connectionString: url });
}

// Runs one write attempt as agent_ro with the read-only override switched off
// in a PRIOR call, and returns the pg error code.
async function attemptRoWrite(sql: string): Promise<string | undefined> {
  const client = newClient(RO_URL);
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = off");
    await client.query(sql);
    return undefined; // Written — the grant layer failed open.
  } catch (err) {
    return (err as { code?: string }).code;
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasAll)(
  "roles live (requires OWNER_DATABASE_URL, DATABASE_URL, INDEXER_DATABASE_URL)",
  () => {
    let owner: Client;
    let indexer: Client;

    beforeAll(async () => {
      owner = newClient(OWNER_URL);
      indexer = newClient(INDEXER_URL);
      await owner.connect();
      await indexer.connect();
      // Probe tables for the indexer RW legs (no tables exist yet in these
      // schemas). Default privileges grant indexer ALL on owner-created
      // tables here, so these INSERTs must succeed.
      await owner.query(
        "CREATE TABLE IF NOT EXISTS semantic.roleproof_probe (id integer)",
      );
      await owner.query(
        "CREATE TABLE IF NOT EXISTS app_state.roleproof_probe (id integer)",
      );
    });

    afterAll(async () => {
      try {
        await owner.query("DROP TABLE IF EXISTS semantic.roleproof_probe");
        await owner.query("DROP TABLE IF EXISTS app_state.roleproof_probe");
      } finally {
        await owner.end();
        await indexer.end();
      }
    });

    it("agent_ro SELECT on business works (tracer-loaded regions)", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const result = await client.query(
          "SELECT count(*)::int AS n FROM business.regions",
        );
        expect(result.rows[0] as { n: number }).toEqual({ n: 34 });
      } finally {
        await client.end();
      }
    });

    it("agent_ro INSERT fails 42501 after SET default_transaction_read_only=off", async () => {
      const code = await attemptRoWrite(
        "INSERT INTO business.regions (province, region_group) VALUES ('__probe__', 'Bắc')",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro UPDATE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "UPDATE business.regions SET region_group = 'Bắc' WHERE province = '__probe__'",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro DELETE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "DELETE FROM business.regions WHERE province = '__probe__'",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro CREATE TABLE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "CREATE TABLE business.roleproof_tmp (id integer)",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro CREATE TEMP TABLE fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "CREATE TEMP TABLE roleproof_tmp (id integer)",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro SELECT INTO fails 42501 after the override", async () => {
      const code = await attemptRoWrite(
        "SELECT * INTO business.roleproof_tmp2 FROM business.regions",
      );
      expect(code).toBe("42501");
    });

    it("agent_ro write fails 42501 inside BEGIN then READ WRITE", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        await client.query("BEGIN");
        await client.query("SET TRANSACTION READ WRITE");
        const code = await client
          .query(
            "INSERT INTO business.regions (province, region_group) VALUES ('__probe__', 'Bắc')",
          )
          .then(
            () => undefined,
            (err: unknown) => (err as { code?: string }).code,
          );
        expect(code).toBe("42501");
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    });

    it("agent_ro nextval without sequence USAGE fails 42501", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const code = await client
          .query("SELECT nextval('business.order_items_order_item_id_seq')")
          .then(
            () => undefined,
            (err: unknown) => (err as { code?: string }).code,
          );
        expect(code).toBe("42501");
      } finally {
        await client.end();
      }
    });

    it("agent_ro SET ROLE owner fails 42501 (no memberships)", async () => {
      const client = newClient(RO_URL);
      try {
        await client.connect();
        const code = await client.query("SET ROLE owner").then(
          () => undefined,
          (err: unknown) => (err as { code?: string }).code,
        );
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
          await client.query("SET LOCAL statement_timeout = '2s'");
          const code = await client.query("SELECT pg_sleep(5)").then(
            () => undefined,
            (err: unknown) => (err as { code?: string }).code,
          );
          expect(code).toBe("57014");
          await client.query("ROLLBACK");
        } finally {
          await client.end();
        }
      },
      15000,
    );

    it("indexer SELECTs business", async () => {
      const result = await indexer.query(
        "SELECT count(*)::int AS n FROM business.regions",
      );
      expect((result.rows[0] as { n: number }).n).toBeGreaterThan(0);
    });

    it("indexer INSERTs into semantic and app_state", async () => {
      await indexer.query("INSERT INTO semantic.roleproof_probe (id) VALUES (1)");
      await indexer.query(
        "INSERT INTO app_state.roleproof_probe (id) VALUES (1)",
      );
      const semantic = await indexer.query(
        "SELECT count(*)::int AS n FROM semantic.roleproof_probe",
      );
      const appState = await indexer.query(
        "SELECT count(*)::int AS n FROM app_state.roleproof_probe",
      );
      expect((semantic.rows[0] as { n: number }).n).toBeGreaterThan(0);
      expect((appState.rows[0] as { n: number }).n).toBeGreaterThan(0);
    });

    it("indexer is denied INSERT into business", async () => {
      const code = await indexer
        .query(
          "INSERT INTO business.regions (province, region_group) VALUES ('__probe__', 'Bắc')",
        )
        .then(
          () => undefined,
          (err: unknown) => (err as { code?: string }).code,
        );
      expect(code).toBe("42501");
    });
  },
);
