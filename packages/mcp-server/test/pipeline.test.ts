// Seven-stage pipeline matrix (MCP-01, MCP-03 through MCP-08): stage order,
// auth, scopes, zod bounds, guard, policy (masking, row-scope, denials),
// bounded reads, PII scan and exactly-once audit — all DB-free via an
// injected stub session factory and a stub catalog.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { warmupSqlGuard, ColumnScopePolicy } from "@shared/access-policy";
import type { SearchSemanticLayerChunk } from "@shared/contracts";
import { setAuditDestinationForTests } from "../src/audit.js";
import type { SessionFactory } from "../src/executor.js";
import {
  executeResourceRead,
  executeToolCall,
  type GatewayDeps,
} from "../src/pipeline.js";
import type { BuiltCatalog } from "../src/catalog.js";
import type { ResolvedClient } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CLIENTS: ResolvedClient[] = [
  {
    clientId: "sales_south",
    role: "sales_south",
    scopes: ["schema:read", "data:read"],
    rowScope: { column: "region_group", value: "Nam" },
    token: "sales-token",
  },
  {
    clientId: "hr",
    role: "hr",
    scopes: ["schema:read", "data:read", "data:sensitive"],
    rowScope: null,
    token: "hr-token",
  },
  {
    clientId: "meta",
    role: "meta",
    scopes: ["schema:read"],
    rowScope: null,
    token: "meta-token",
  },
];

function stubCatalog(): BuiltCatalog {
  const columns = (
    table: string,
    entries: [name: string, sensitive: boolean][],
  ) =>
    entries.map(([name, sensitive]) => ({
      name,
      type: "text",
      nullable: true,
      sensitive,
      large: false,
    }));
  return {
    catalog: {
      tables: [
        { name: "orders", schema: "public", columns: columns("orders", [["id", false], ["status", false], ["total", false]]) },
        { name: "sellers", schema: "public", columns: columns("sellers", [["id", false], ["name", false], ["region_group", false]]) },
        {
          name: "customers",
          schema: "public",
          columns: columns("customers", [["id", false], ["phone", true], ["email", true], ["address", true], ["name", false]]),
        },
        {
          name: "employees",
          schema: "public",
          columns: columns("employees", [["id", false], ["salary", true]]),
        },
      ],
    },
    primaryKeys: new Map([["orders", ["id"]]]),
    foreignKeys: new Map(),
  };
}

const SENSITIVE_ENTRIES = [
  { table: "customers", column: "phone" },
  { table: "customers", column: "email" },
  { table: "customers", column: "address" },
  { table: "employees", column: "salary" },
];

interface StubBehavior {
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  columns?: string[];
  throwDriver?: Record<string, unknown>;
}

interface StubCall {
  began: boolean;
  bodies: string[];
  rolledBack: boolean;
  released: boolean;
}

function stubFactory(behavior: StubBehavior, calls: StubCall[]): SessionFactory {
  return async () => ({
    async beginReadOnly(): Promise<void> {
      calls.push({ began: true, bodies: [], rolledBack: false, released: false });
    },
    async readBounded(body: string, maxRows: number) {
      void maxRows;
      calls[calls.length - 1]?.bodies.push(body);
      if (behavior.throwDriver !== undefined) throw behavior.throwDriver;
      const rows = behavior.rows ?? [];
      return {
        rows,
        truncated: behavior.truncated ?? false,
        columns: behavior.columns ?? Object.keys(rows[0] ?? {}),
      };
    },
    async rollback(): Promise<void> {
      const call = calls[calls.length - 1];
      if (call !== undefined) call.rolledBack = true;
    },
    release(): void {
      const call = calls[calls.length - 1];
      if (call !== undefined) call.released = true;
    },
  });
}

function stubSearch(chunks: SearchSemanticLayerChunk[]): GatewayDeps["search"] {
  return async () => chunks;
}

function chunk(content: string): SearchSemanticLayerChunk {
  return {
    chunkId: "metrics:revenue_vnd",
    docType: "metric",
    table: null,
    tables: ["orders"],
    metricName: "revenue_vnd",
    content,
    score: 0.9,
  };
}

let auditLines: string[];

function makeDeps(
  behavior: StubBehavior = { rows: [], truncated: false, columns: [] },
  calls: StubCall[] = [],
): { deps: GatewayDeps; calls: StubCall[] } {
  const deps: GatewayDeps = {
    clients: CLIENTS,
    catalog: stubCatalog(),
    policy: new ColumnScopePolicy(SENSITIVE_ENTRIES.map((entry) => ({ ...entry }))),
    sessionFactory: stubFactory(behavior, calls),
    search: stubSearch([]),
  };
  return { deps, calls };
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-run-id": "test-run-1",
    "x-user-id": "probe-user",
    ...extra,
  };
}

beforeAll(async () => {
  await warmupSqlGuard();
});

beforeEach(() => {
  auditLines = [];
  setAuditDestinationForTests({
    write: (line: string) => {
      auditLines.push(line);
    },
  });
});

function lastAudit(): Record<string, unknown> {
  expect(auditLines).toHaveLength(1);
  return JSON.parse(auditLines[0] as string) as Record<string, unknown>;
}

describe("pipeline stage order and auth", () => {
  it("a DELETE reaches FORBIDDEN_STATEMENT from the guard and never touches the pool", async () => {
    const { deps, calls } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "DELETE FROM orders", maxRows: 10 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN_STATEMENT");
    expect(calls).toHaveLength(0);
    expect(lastAudit()["decision"]).toBe("deny");
  });

  it("rejects a missing Bearer token with 401 UNAUTHORIZED", async () => {
    const { deps, calls } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: {},
      tool: "run_query",
      args: { sql: "SELECT 1", maxRows: 10 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHORIZED");
      expect(result.error.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects a wrong Bearer token with 401 UNAUTHORIZED", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("nope"),
      tool: "list_tables",
      args: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED");
  });

  it("denies run_query for a schema:read-only principal with SCOPE_DENIED", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("meta-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM orders", maxRows: 10 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCOPE_DENIED");
  });

  it("denies explain_query for a schema:read-only principal", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("meta-token"),
      tool: "explain_query",
      args: { sql: "SELECT id FROM orders" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SCOPE_DENIED");
  });

  it("rejects an unknown tool without echoing its name", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "drop_database",
      args: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
      expect(result.error.message).not.toContain("drop_database");
    }
  });
});

describe("pipeline zod bounds", () => {
  it("rejects maxRows 1001 with a value-free field-path message", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM orders", maxRows: 1001 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PARAMS");
      expect(result.error.message).toContain("maxRows");
      expect(result.error.message).not.toContain("1001");
    }
  });

  it("rejects sample_rows n 6", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "sample_rows",
      args: { table: "orders", n: 6 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PARAMS");
  });
});

describe("pipeline policy stage", () => {
  it("masks a sensitive projection, preserving output column names", async () => {
    const { deps } = makeDeps({
      rows: [{ phone: "0901234567", name: "x" }],
      columns: ["phone", "name"],
    });
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT phone, name FROM customers", maxRows: 10 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        rows: Record<string, unknown>[];
        maskedColumns: string[];
        columns: string[];
      };
      expect(data.columns).toContain("phone");
      expect(data.rows[0]?.["phone"]).toBe("[MASKED_PHONE]");
      expect(data.maskedColumns).toContain("customers.phone");
    }
    const audit = lastAudit();
    expect(audit["decision"]).toBe("allow");
    expect(audit["piiHits"]).toBe(1);
  });

  it("denies a sensitive column in a WHERE clause without data:sensitive", async () => {
    const { deps, calls } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM employees WHERE salary > 100", maxRows: 10 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SENSITIVE_COLUMN_DENIED");
    expect(calls).toHaveLength(0);
  });

  it("injects the sales_south row-scope predicate on a scoped table", async () => {
    const { deps, calls } = makeDeps({ rows: [{ id: "1" }], columns: ["id"] });
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM sellers", maxRows: 10 },
    });
    expect(result.ok).toBe(true);
    const body = calls[0]?.bodies[0] ?? "";
    expect(body).toContain("region_group");
    expect(body).toContain("Nam");
  });

  it("leaves SQL untouched when the principal carries no row-scope", async () => {
    const { deps, calls } = makeDeps({ rows: [{ id: "1" }], columns: ["id"] });
    const result = await executeToolCall(deps, {
      headers: headers("hr-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM sellers", maxRows: 10 },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.bodies[0]).toBe("SELECT id FROM sellers");
  });
});

describe("pipeline executor and audit stages", () => {
  it("reports truncated when the stub overflows maxRows and releases the session", async () => {
    const behavior = {
      rows: [{ id: "1" }, { id: "2" }, { id: "3" }],
      truncated: true,
      columns: ["id"],
    };
    const { deps, calls } = makeDeps(behavior);
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM orders", maxRows: 2 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { truncated: boolean; rowCount: number };
      expect(data.truncated).toBe(true);
      expect(data.rowCount).toBe(3);
    }
    expect(calls[0]?.rolledBack).toBe(true);
    expect(calls[0]?.released).toBe(true);
  });

  it("maps a driver catalog error through sanitizeError to UNKNOWN_TABLE", async () => {
    const { deps } = makeDeps({
      throwDriver: { code: "42P01", message: 'relation "nope" does not exist' },
    });
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM orders", maxRows: 10 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNKNOWN_TABLE");
      expect(result.error.repairable).toBe(true);
    }
  });

  it("writes exactly one audit line with masked SQL literals", async () => {
    const { deps } = makeDeps({ rows: [{ id: "1" }], columns: ["id"] });
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "run_query",
      args: { sql: "SELECT id FROM orders WHERE status = 'delivered'", maxRows: 10 },
    });
    expect(result.ok).toBe(true);
    const audit = lastAudit();
    expect(audit["tool"]).toBe("run_query");
    expect(audit["runId"]).toBe("test-run-1");
    expect(audit["decision"]).toBe("allow");
    const params = audit["params"] as { sql: string };
    expect(params.sql).toContain("'?'");
    expect(params.sql).not.toContain("delivered");
  });

  it("parses EXPLAIN output into cost and row estimates", async () => {
    const { deps } = makeDeps({
      rows: [
        {
          "QUERY PLAN": [
            { Plan: { "Total Cost": 10.5, "Plan Rows": 42, "Node Type": "Seq Scan" } },
          ],
        },
      ],
      columns: ["QUERY PLAN"],
    });
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "explain_query",
      args: { sql: "SELECT id FROM orders" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        estimatedCost: number;
        estimatedRows: number;
      };
      expect(data.estimatedCost).toBe(10.5);
      expect(data.estimatedRows).toBe(42);
    }
  });

  it("rejects EXPLAIN input containing ANALYZE", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "explain_query",
      args: { sql: "EXPLAIN ANALYZE SELECT id FROM orders" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("serves describe_table from the boot catalog with keys", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("meta-token"),
      tool: "describe_table",
      args: { table: "orders" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        table: string;
        primaryKey: string[];
        foreignKeys: unknown[];
      };
      expect(data.table).toBe("orders");
      expect(data.primaryKey).toEqual(["id"]);
      expect(data.foreignKeys).toEqual([]);
    }
  });

  it("denies describe_table for an unknown table without pool use", async () => {
    const { deps, calls } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("meta-token"),
      tool: "describe_table",
      args: { table: "nope" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TABLE");
    expect(calls).toHaveLength(0);
  });

  it("denies sample_rows for an unknown table", async () => {
    const { deps } = makeDeps();
    const result = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "sample_rows",
      args: { table: "nope", n: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_TABLE");
  });
});

describe("pipeline search and resources", () => {
  it("redacts PII in search chunks and reports the restricted split", async () => {
    const seen: boolean[] = [];
    const { deps } = makeDeps();
    deps.search = async (_query, _topK, allowRestricted) => {
      seen.push(allowRestricted);
      return [chunk("call 0901234567 for revenue help")];
    };
    const sales = await executeToolCall(deps, {
      headers: headers("sales-token"),
      tool: "search_semantic_layer",
      args: { query: "revenue", topK: 5 },
    });
    expect(sales.ok).toBe(true);
    if (sales.ok) {
      const data = sales.data as { chunks: SearchSemanticLayerChunk[] };
      expect(data.chunks[0]?.content).toContain("[MASKED_PHONE]");
      expect(data.chunks[0]?.chunkId).toBe("metrics:revenue_vnd");
    }
    const hr = await executeToolCall(deps, {
      headers: headers("hr-token"),
      tool: "search_semantic_layer",
      args: { query: "revenue", topK: 5 },
    });
    expect(hr.ok).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it("withholds restricted resource sections without data:sensitive", async () => {
    const { deps } = makeDeps();
    const documents = [
      {
        uri: "semantic://metrics",
        text: "## Public metric\n\nRevenue.\n\n## Salary bands [restricted_pii]\n\nSecret.\n",
      },
    ];
    const sales = await executeResourceRead(
      deps,
      headers("sales-token"),
      "semantic://metrics",
      documents,
    );
    expect(sales.ok).toBe(true);
    if (sales.ok) {
      const data = sales.data as { text: string };
      expect(data.text).toContain("Revenue.");
      expect(data.text).not.toContain("Secret.");
    }
    const hr = await executeResourceRead(
      deps,
      headers("hr-token"),
      "semantic://metrics",
      documents,
    );
    expect(hr.ok).toBe(true);
    if (hr.ok) {
      expect((hr.data as { text: string }).text).toContain("Secret.");
    }
    expect(auditLines).toHaveLength(2);
  });

  it("denies an unknown resource and an unauthenticated read", async () => {
    const { deps } = makeDeps();
    const unknown = await executeResourceRead(deps, headers("sales-token"), "semantic://nope", []);
    expect(unknown.ok).toBe(false);
    const unauth = await executeResourceRead(deps, {}, "semantic://metrics", []);
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) expect(unauth.error.code).toBe("UNAUTHORIZED");
  });
});

describe("deployment guardrails", () => {
  it("binds loopback only, never 0.0.0.0", () => {
    const compose = readFileSync(
      path.resolve(HERE, "../../../docker/docker-compose.yml"),
      "utf8",
    );
    const stripped = compose
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(stripped).toContain("127.0.0.1");
    expect(stripped).not.toContain("0.0.0.0");
  });
});
