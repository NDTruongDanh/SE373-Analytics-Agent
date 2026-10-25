import { describe, expect, it } from "vitest";
import {
  DbToolErrorSchema,
  RunQueryOutputSchema,
  type SchemaCatalog,
} from "@se373/contracts";
import {
  runQuery,
  type ClientLike,
  type CursorLike,
  type PoolLike,
} from "../src/db.js";

// Hand-written fakes: no pg import in tests. A shared event log proves the
// exact command order across pool, client, and cursor.
function makeFakes(opts: {
  rows?: Record<string, unknown>[];
  readError?: unknown;
  closeError?: unknown;
  queryError?: (sql: string) => unknown;
  connectError?: unknown;
}) {
  const events: string[] = [];
  const cursor: CursorLike = {
    async read(n: number) {
      events.push(`read:${n}`);
      if (opts.readError !== undefined) throw opts.readError;
      return opts.rows ?? [];
    },
    async close() {
      events.push("close");
      if (opts.closeError !== undefined) throw opts.closeError;
    },
  };
  let released = 0;
  const client: ClientLike = {
    async query(sql: string) {
      events.push(`query:${sql}`);
      const failure = opts.queryError?.(sql);
      if (failure !== undefined) throw failure;
      return {};
    },
    queryCursor(c: CursorLike) {
      events.push("queryCursor");
      return c;
    },
    release() {
      released += 1;
      events.push("release");
    },
  };
  let connects = 0;
  const pool: PoolLike = {
    async connect() {
      connects += 1;
      events.push("connect");
      if (opts.connectError !== undefined) throw opts.connectError;
      return client;
    },
  };
  return {
    events,
    cursor,
    pool,
    releaseCount: () => released,
    connectCount: () => connects,
  };
}

const CATALOG: SchemaCatalog = {
  tables: { orders: ["id", "total"] },
};

const ROWS = [
  { id: 1, total: 10 },
  { id: 2, total: 20 },
];

// Every executing call injects the fake cursor, so the production default
// factory (real pg-cursor) never runs in tests.
function exec(
  f: ReturnType<typeof makeFakes>,
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number },
) {
  return runQuery(f.pool, sql, CATALOG, {
    ...options,
    cursorFactory: () => f.cursor,
  });
}

describe("runQuery happy path", () => {
  it("emits the exact command order and a conforming output shape", async () => {
    const f = makeFakes({ rows: ROWS });
    const result = await exec(f, "SELECT id, total FROM orders", {
      timeoutMs: 5000,
    });
    expect(f.events).toEqual([
      "connect",
      "query:BEGIN READ ONLY",
      "query:SET LOCAL statement_timeout = '5000'",
      "queryCursor",
      "read:201",
      "close",
      "query:ROLLBACK",
      "release",
    ]);
    expect(f.releaseCount()).toBe(1);
    expect(() => RunQueryOutputSchema.parse(result)).not.toThrow();
    if ("code" in result) throw new Error("expected output, got error");
    expect(result.columns).toEqual(["id", "total"]);
    expect(result.rows).toEqual(ROWS);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.maskedColumns).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns empty columns for zero rows", async () => {
    const f = makeFakes({ rows: [] });
    const result = await exec(f, "SELECT id FROM orders");
    if ("code" in result) throw new Error("expected output, got error");
    expect(result.columns).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(() => RunQueryOutputSchema.parse(result)).not.toThrow();
  });
});

describe("runQuery truncation boundary", () => {
  it("reads maxRows+1 and slices with truncated true", async () => {
    const f = makeFakes({ rows: [...ROWS, { id: 3, total: 30 }] });
    const result = await exec(f, "SELECT id, total FROM orders", {
      maxRows: 2,
    });
    expect(f.events).toContain("read:3");
    if ("code" in result) throw new Error("expected output, got error");
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
  });

  it("stays untruncated at exactly maxRows", async () => {
    const f = makeFakes({ rows: ROWS });
    const result = await exec(f, "SELECT id, total FROM orders", {
      maxRows: 2,
    });
    if ("code" in result) throw new Error("expected output, got error");
    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(2);
  });
});

describe("runQuery guard-first ordering", () => {
  it("returns the guard DbToolError without checking out a connection", async () => {
    const f = makeFakes({ rows: ROWS });
    const result = await exec(f, "DELETE FROM orders");
    if (!("code" in result)) throw new Error("expected error, got output");
    expect(result.code).toBe("FORBIDDEN_STATEMENT");
    expect(() => DbToolErrorSchema.parse(result)).not.toThrow();
    expect(f.connectCount()).toBe(0);
    expect(f.events).toEqual([]);
  });

  it("rejects unknown tables before checkout too", async () => {
    const f = makeFakes({ rows: ROWS });
    const result = await exec(f, "SELECT * FROM nope");
    if (!("code" in result)) throw new Error("expected error, got output");
    expect(result.code).toBe("UNKNOWN_TABLE");
    expect(f.connectCount()).toBe(0);
  });
});

describe("runQuery option validation", () => {
  it.each([{ maxRows: 0 }, { maxRows: 1001 }, { maxRows: 1.5 }])(
    "rejects maxRows $maxRows without checkout",
    async ({ maxRows }) => {
      const f = makeFakes({ rows: ROWS });
      const result = await exec(f, "SELECT id FROM orders", { maxRows });
      if (!("code" in result)) throw new Error("expected error, got output");
      expect(result.code).toBe("INVALID_PARAMS");
      expect(f.connectCount()).toBe(0);
    },
  );

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: -5 },
    { timeoutMs: 1.5 },
    { timeoutMs: 300001 },
  ])(
    "rejects timeoutMs $timeoutMs without checkout",
    async ({ timeoutMs }) => {
      const f = makeFakes({ rows: ROWS });
      const result = await exec(f, "SELECT id FROM orders", { timeoutMs });
      if (!("code" in result)) throw new Error("expected error, got output");
      expect(result.code).toBe("INVALID_PARAMS");
      expect(f.connectCount()).toBe(0);
    },
  );
});

describe("runQuery always-release paths", () => {
  it("maps statement timeout (57014) to retryable TIMEOUT and still releases", async () => {
    const f = makeFakes({
      rows: ROWS,
      readError: Object.assign(
        new Error("canceling statement due to statement timeout"),
        { code: "57014" },
      ),
    });
    const result = await exec(f, "SELECT id FROM orders");
    if (!("code" in result)) throw new Error("expected error, got output");
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
    expect(() => DbToolErrorSchema.parse(result)).not.toThrow();
    expect(f.releaseCount()).toBe(1);
    expect(f.events).toContain("query:ROLLBACK");
    expect(f.events[f.events.length - 1]).toBe("release");
  });

  it("releases on cursor errors with sanitized INTERNAL_ERROR", async () => {
    const f = makeFakes({ readError: new Error("cursor boom") });
    const result = await exec(f, "SELECT id FROM orders");
    if (!("code" in result)) throw new Error("expected error, got output");
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(f.releaseCount()).toBe(1);
  });

  it("releases on close errors", async () => {
    const f = makeFakes({ rows: ROWS, closeError: new Error("close boom") });
    const result = await exec(f, "SELECT id FROM orders");
    if (!("code" in result)) throw new Error("expected error, got output");
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(f.releaseCount()).toBe(1);
  });

  it("sanitizes connect failures without leaking host fragments", async () => {
    const f = makeFakes({
      connectError: Object.assign(
        new Error("connection failed: host=secret.internal port 5432"),
        { code: "08006" },
      ),
    });
    const result = await exec(f, "SELECT id FROM orders");
    if (!("code" in result)) throw new Error("expected error, got output");
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toContain("secret.internal");
    expect(() => DbToolErrorSchema.parse(result)).not.toThrow();
    expect(f.connectCount()).toBe(1);
  });
});
