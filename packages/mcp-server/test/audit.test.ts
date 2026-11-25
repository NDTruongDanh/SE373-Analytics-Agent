import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ColumnScopePolicy,
  loadRowScopeLineage,
  warmupSqlGuard,
} from "@shared/access-policy";
import {
  GENESIS_AUDIT_HASH,
  auditCall,
  canonicalJsonStringify,
  computeAuditChainHash,
  ensureAuditSchema,
  setAuditDestinationForTests,
  setPgAuditPoolForTests,
  sha256Utf8,
  type AuditClientLike,
  type AuditPoolLike,
  type AuditRecord,
} from "../src/audit.js";
import type { BuiltCatalog } from "../src/catalog.js";
import type { ResolvedClient } from "../src/config.js";
import type { SessionFactory } from "../src/executor.js";
import { executeToolCall, type GatewayDeps } from "../src/pipeline.js";
import { migrateSemanticCorpusVersion } from "../../../scripts/migrate-state.js";

function makeMockAuditPool(options?: { failOnInsert?: boolean }) {
  const queries: { text: string; params?: unknown[] }[] = [];
  const head = { id: 1, seq: 0, currentHash: GENESIS_AUDIT_HASH };
  const logRows: Array<{
    seq: number;
    runId: string;
    tool: string;
    caller: string;
    ts: string;
    inputHash: string;
    outputHash: string;
    prevHash: string;
    currentHash: string;
    record: string;
  }> = [];
  let pendingHead = { ...head };
  const pendingRows: typeof logRows = [];

  const client: AuditClientLike = {
    async query(text: string, params?: unknown[]) {
      queries.push({ text, params });
      if (text === "BEGIN") {
        pendingHead = { ...head };
        pendingRows.length = 0;
        return { rows: [] };
      }
      if (text === "COMMIT") {
        head.seq = pendingHead.seq;
        head.currentHash = pendingHead.currentHash;
        logRows.push(...pendingRows);
        pendingRows.length = 0;
        return { rows: [] };
      }
      if (text === "ROLLBACK") {
        pendingRows.length = 0;
        pendingHead = { ...head };
        return { rows: [] };
      }
      if (text.includes("SELECT current_hash, seq FROM app_state.mcp_audit_head")) {
        return {
          rows: [{ current_hash: pendingHead.currentHash, seq: pendingHead.seq }],
        };
      }
      if (text.startsWith("INSERT INTO app_state.mcp_audit_log")) {
        if (options?.failOnInsert) {
          throw new Error("audit sink disk full");
        }
        pendingRows.push({
          seq: Number(params?.[0]),
          runId: String(params?.[1]),
          tool: String(params?.[2]),
          caller: String(params?.[3]),
          ts: String(params?.[4]),
          inputHash: String(params?.[5]),
          outputHash: String(params?.[6]),
          prevHash: String(params?.[7]),
          currentHash: String(params?.[8]),
          record: String(params?.[9]),
        });
        return { rows: [] };
      }
      if (text.startsWith("UPDATE app_state.mcp_audit_head")) {
        pendingHead.currentHash = String(params?.[0]);
        pendingHead.seq = Number(params?.[1]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const pool: AuditPoolLike = {
    async connect() {
      return client;
    },
    async end() {},
  };

  return { pool, queries, head, logRows };
}

function sampleRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: "2026-04-01T10:00:00.000Z",
    runId: "run-135-01",
    userId: "analyst-1",
    role: "sales_south",
    clientId: "sales_south",
    scopes: ["schema:read", "data:read"],
    tool: "run_query",
    params: { sql: "SELECT COUNT(*) FROM orders WHERE note = '0901234567'", maxRows: 50 },
    outputSummary: { decision: "allow", rowCount: 1, errorCode: null, piiHits: 0 },
    rowCount: 1,
    durationMs: 12,
    decision: "allow",
    piiHits: 0,
    maskedColumns: [],
    rowScopeApplied: [{ table: "orders", column: "region_group" }],
    ...overrides,
  };
}

describe("audit canonicalization & hash chain", () => {
  beforeAll(async () => {
    await warmupSqlGuard();
  });

  beforeEach(() => {
    setAuditDestinationForTests(null);
    setPgAuditPoolForTests(null);
  });

  afterEach(() => {
    setAuditDestinationForTests(null);
    setPgAuditPoolForTests(null);
  });

  it("canonicalizes nested ASCII keys, IEEE 754 floats, Dates, and undefined consistently", () => {
    const a = {
      z: 1.5,
      a: [1, undefined, { y: true, b: -0 }],
      m: 1e21,
      skip: undefined,
      d: new Date("2026-04-01T00:00:00.000Z"),
    };
    const b = {
      d: new Date("2026-04-01T00:00:00.000Z"),
      m: 1e21,
      a: [1, null, { b: 0, y: true }],
      z: 1.5,
    };
    const s1 = canonicalJsonStringify(a);
    const s2 = canonicalJsonStringify(b);
    expect(s1).toBe(s2);
    expect(s1).toBe(
      '{"a":[1,null,{"b":0,"y":true}],"d":"2026-04-01T00:00:00.000Z","m":1e+21,"z":1.5}',
    );
    expect(sha256Utf8("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("chains seq, prev_hash, and current_hash in a single locked transaction", async () => {
    const mock = makeMockAuditPool();
    setPgAuditPoolForTests(mock.pool);

    await auditCall(sampleRecord({ ts: "2026-04-01T10:00:00.000Z" }));
    await auditCall(
      sampleRecord({
        ts: "2026-04-01T10:01:00.000Z",
        params: { maxRows: 10, sql: "SELECT status FROM orders" },
        rowCount: 3,
        outputSummary: { decision: "allow", rowCount: 3, errorCode: null, piiHits: 0 },
      }),
    );

    expect(mock.logRows).toHaveLength(2);
    const [first, second] = mock.logRows;
    expect(first?.seq).toBe(1);
    expect(first?.prevHash).toBe(GENESIS_AUDIT_HASH);
    expect(first?.currentHash).toBe(
      computeAuditChainHash({
        seq: 1,
        runId: first!.runId,
        tool: first!.tool,
        caller: first!.caller,
        ts: first!.ts,
        inputHash: first!.inputHash,
        outputHash: first!.outputHash,
        prevHash: GENESIS_AUDIT_HASH,
      }),
    );
    expect(first?.record).not.toContain("0901234567");

    expect(second?.seq).toBe(2);
    expect(second?.prevHash).toBe(first?.currentHash);
    expect(mock.head.seq).toBe(2);
    expect(mock.head.currentHash).toBe(second?.currentHash);
    expect(
      mock.queries.some((q) =>
        q.text.includes("SELECT current_hash, seq FROM app_state.mcp_audit_head WHERE id = 1 FOR UPDATE"),
      ),
    ).toBe(true);
  });

  it("rolls back and fails closed inside executeToolCall when PG audit write fails", async () => {
    const mock = makeMockAuditPool({ failOnInsert: true });
    setPgAuditPoolForTests(mock.pool);

    const clients: ResolvedClient[] = [
      {
        clientId: "sales_south",
        role: "sales_south",
        scopes: ["schema:read", "data:read"],
        rowScope: { column: "region_group", value: "Nam" },
        token: "sales-token",
      },
    ];
    const catalog: BuiltCatalog = {
      catalog: {
        tables: [
          {
            name: "orders",
            schema: "public",
            columns: [
              { name: "id", type: "text", nullable: false, sensitive: false, large: false },
              { name: "region_group", type: "text", nullable: false, sensitive: false, large: false },
            ],
          },
        ],
      },
      primaryKeys: new Map([["orders", ["id"]]]),
      foreignKeys: new Map(),
    };
    const policy = new ColumnScopePolicy(
      [{ table: "customers", column: "phone" }],
      loadRowScopeLineage(
        "version: 1\nscopes:\n  region_group:\n    tables:\n      orders: direct\n",
      ),
    );
    let sessionExecuted = false;
    const sessionFactory: SessionFactory = async () => ({
      async beginReadOnly() {},
      async readBounded() {
        sessionExecuted = true;
        return {
          rows: [{ id: "ord-1", region_group: "Nam" }],
          truncated: false,
          columns: ["id", "region_group"],
        };
      },
      async rollback() {},
      release() {},
    });
    const deps: GatewayDeps = {
      clients,
      catalog,
      policy,
      sessionFactory,
      search: async () => [],
    };

    const result = await executeToolCall(deps, {
      headers: {
        authorization: "Bearer sales-token",
        "x-run-id": "run-fail-closed",
      },
      tool: "run_query",
      args: { sql: "SELECT id FROM orders", maxRows: 10 },
    });

    expect(sessionExecuted).toBe(true);
    expect(result.ok).toBe(false);
    expect("data" in result).toBe(false);
    expect(mock.queries.some((q) => q.text.startsWith("INSERT INTO app_state.mcp_audit_log"))).toBe(true);
    expect(mock.queries.some((q) => q.text === "ROLLBACK")).toBe(true);
    expect(mock.logRows).toHaveLength(0);
    expect(mock.head.seq).toBe(0);
  });

  it("ensureAuditSchema serializes DDL via advisory xact lock and seeds genesis head", async () => {
    const mock = makeMockAuditPool();
    await ensureAuditSchema(mock.pool);

    expect(mock.queries[0]?.text).toBe("BEGIN");
    expect(
      mock.queries.some((q) =>
        q.text.includes("pg_advisory_xact_lock(hashtextextended('ddl:mcp_audit', 0))"),
      ),
    ).toBe(true);
    expect(
      mock.queries.some((q) => q.text.includes("CREATE TABLE IF NOT EXISTS app_state.mcp_audit_head")),
    ).toBe(true);
    expect(
      mock.queries.some((q) => q.text.includes("CREATE TABLE IF NOT EXISTS app_state.mcp_audit_log")),
    ).toBe(true);
    expect(
      mock.queries.some(
        (q) =>
          q.text.includes("INSERT INTO app_state.mcp_audit_head") &&
          q.params?.[0] === GENESIS_AUDIT_HASH,
      ),
    ).toBe(true);
    expect(mock.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("migrateSemanticCorpusVersion creates semantic.corpus_version idempotently on one client transaction", async () => {
    const seen: string[] = [];
    let releasedCount = 0;
    let connectCalls = 0;
    const pool = {
      async connect() {
        connectCalls += 1;
        return {
          async query(text: string) {
            seen.push(text.trim());
            return { rows: [] };
          },
          release() {
            releasedCount += 1;
          },
        };
      },
    };
    await migrateSemanticCorpusVersion(pool);

    expect(connectCalls).toBe(1);
    expect(releasedCount).toBe(1);
    expect(seen[0]).toBe("BEGIN");
    expect(seen.some((q) => q.includes("pg_advisory_xact_lock(hashtextextended('ddl:corpus_version', 0))"))).toBe(true);
    expect(seen.some((q) => q.includes("CREATE TABLE IF NOT EXISTS semantic.corpus_version"))).toBe(true);
    expect(seen.some((q) => q.includes("GRANT SELECT ON TABLE semantic.corpus_version TO agent_ro"))).toBe(true);
    expect(
      seen.some((q) => q.includes("GRANT SELECT, INSERT, UPDATE ON TABLE semantic.corpus_version TO indexer")),
    ).toBe(true);
    expect(seen.at(-1)).toBe("COMMIT");

    const rollSeen: string[] = [];
    let rollReleased = 0;
    await expect(
      migrateSemanticCorpusVersion({
        async connect() {
          return {
            async query(text: string) {
              rollSeen.push(text.trim());
              if (text.includes("GRANT SELECT ON TABLE")) {
                throw new Error("grant failed");
              }
              return { rows: [] };
            },
            release() {
              rollReleased += 1;
            },
          };
        },
      }),
    ).rejects.toThrow("grant failed");
    expect(rollSeen[0]).toBe("BEGIN");
    expect(rollSeen.at(-1)).toBe("ROLLBACK");
    expect(rollReleased).toBe(1);
  });
});
