// Fixed 7-stage pipeline (MCP-03, T-01-08-02): the single entry point
// every tool and resource handler calls. Stage order is load-bearing and
// not skippable — auth, then scope, then zod, then sqlGuard, then
// AccessPolicy (reusing GuardSuccess.ast with no double parse), then the
// read-only executor, then PII scan plus exactly one audit line. Non-SQL
// tools skip stages 4-6 vacuously (there is no statement to guard); the
// audit stage always runs, including on denials.
import {
  dbToolError,
  type DbToolError,
  type SearchSemanticLayerChunk,
} from "@se373/contracts";
import {
  redactPII,
  redactRow,
  sqlGuard,
  type AccessPolicy,
  type Principal,
} from "@se373/access-policy";
import {
  authenticateRequest,
  requireScope,
  type ScopeName,
} from "./auth.js";
import type { ResolvedClient } from "./config.js";
import { executeReadOnly, type SessionFactory } from "./executor.js";
import { sanitizeError } from "./errors.js";
import { auditCall } from "./audit.js";
import { findTable, type BuiltCatalog } from "./catalog.js";
import { TOOL_SCOPES, TOOL_SPECS, type ToolName } from "./tools.js";

export type SearchFn = (
  query: string,
  topK: number,
  allowRestricted: boolean,
) => Promise<SearchSemanticLayerChunk[]>;

export interface GatewayDeps {
  clients: ResolvedClient[];
  catalog: BuiltCatalog;
  policy: AccessPolicy;
  sessionFactory: SessionFactory;
  search: SearchFn;
}

export interface PipelineRequest {
  headers: Record<string, string | string[] | undefined>;
  tool: string;
  args: unknown;
}

export type PipelineResult =
  | { ok: true; data: unknown }
  | { ok: false; error: DbToolError };

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const ANALYZE_PATTERN = /\banalyze\b/i;

// A `## ` section whose header ends with [restricted_pii] is withheld from
// principals lacking data:sensitive. Convention shared by the semantic
// corpus files and the resource readers.
export function filterResourceSections(
  text: string,
  allowRestricted: boolean,
): string {
  if (allowRestricted) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    const header = /^##\s+(.*)$/.exec(line);
    if (header !== null) {
      dropping = /\[restricted_pii\]\s*$/.test(header[1] as string);
      if (!dropping) kept.push(line);
      continue;
    }
    if (!dropping) kept.push(line);
  }
  return kept.join("\n");
}

export interface ResourceDocument {
  uri: string;
  text: string;
}

export async function executeToolCall(
  deps: GatewayDeps,
  req: PipelineRequest,
): Promise<PipelineResult> {
  const started = Date.now();
  let runId = "unknown";
  let userId = "";
  let role = "";
  let clientId = "";
  let scopes: string[] = [];
  let params: unknown = req.args ?? {};
  let rowCount = 0;
  let piiHits = 0;
  let explainCost: number | null = null;

  const finish = (result: PipelineResult): PipelineResult => {
    if (result.ok) {
      auditCall({
        ts: new Date().toISOString(),
        runId,
        userId,
        role,
        clientId,
        scopes,
        tool: req.tool,
        params,
        rowCount,
        durationMs: Date.now() - started,
        decision: "allow",
        explainCost,
        piiHits,
      });
    } else {
      auditCall({
        ts: new Date().toISOString(),
        runId,
        userId,
        role,
        clientId,
        scopes,
        tool: req.tool,
        params,
        rowCount: 0,
        durationMs: Date.now() - started,
        decision: "deny",
        errorCode: result.error.code,
        piiHits,
      });
    }
    return result;
  };
  const deny = (error: DbToolError): PipelineResult => ({
    ok: false,
    error,
  });

  try {
    const spec = TOOL_SPECS.find((candidate) => candidate.name === req.tool);
    if (spec === undefined) {
      return finish(
        deny(dbToolError("INVALID_PARAMS", "unknown tool")),
      );
    }
    const tool = spec.name as ToolName;

    const auth = authenticateRequest(req.headers, deps.clients);
    if ("error" in auth) return finish(deny(auth.error));
    const principal: Principal = auth.auth.principal;
    runId = auth.auth.runId;
    userId = auth.auth.userId;
    role = principal.role;
    clientId =
      deps.clients.find((candidate) => candidate.role === principal.role)
        ?.clientId ?? principal.role;
    scopes = [...principal.scopes];

    const finishCounts = (counts: {
      rowCount: number;
      piiHits: number;
    }): void => {
      rowCount = counts.rowCount;
      piiHits = counts.piiHits;
    };

    const scopeError = requireScope(principal, TOOL_SCOPES[tool] as ScopeName);
    if (scopeError !== null) return finish(deny(scopeError));

    const parsed = spec.inputSchema.safeParse(req.args ?? {});
    if (!parsed.success) {
      // Field paths only — never echoed values (T-01-08-04).
      const paths = parsed.error.issues
        .map((issue) => issue.path.join("."))
        .filter((path) => path.length > 0);
      const detail = paths.length > 0 ? `: ${paths.join(", ")}` : "";
      return finish(deny(dbToolError("INVALID_PARAMS", `invalid params${detail}`)));
    }
    params = parsed.data;
    const args = parsed.data as Record<string, unknown>;

    switch (tool) {
      case "list_tables": {
        const tables = deps.catalog.catalog.tables.map((table) => ({
          name: table.name,
          schema: table.schema,
        }));
        rowCount = tables.length;
        return finish({ ok: true, data: { tables } });
      }
      case "describe_table": {
        const table = findTable(deps.catalog, String(args["table"]));
        if (table === undefined) {
          return finish(
            deny(
              dbToolError(
                "UNKNOWN_TABLE",
                "unknown table (see list_tables for the catalog)",
              ),
            ),
          );
        }
        rowCount = table.columns.length;
        return finish({
          ok: true,
          data: {
            table: table.name,
            columns: table.columns,
            primaryKey: deps.catalog.primaryKeys.get(table.name) ?? [],
            foreignKeys: deps.catalog.foreignKeys.get(table.name) ?? [],
          },
        });
      }
      case "sample_rows": {
        const table = findTable(deps.catalog, String(args["table"]));
        if (table === undefined) {
          return finish(
            deny(
              dbToolError(
                "UNKNOWN_TABLE",
                "unknown table (see list_tables for the catalog)",
              ),
            ),
          );
        }
        const n = args["n"] as number;
        const sql = `SELECT * FROM ${quoteIdentifier(table.name)} LIMIT ${n}`;
        return finish(await runSqlStages(deps, principal, sql, n, finishCounts));
      }
      case "run_query": {
        const sql = args["sql"] as string;
        const maxRows = args["maxRows"] as number;
        return finish(await runSqlStages(deps, principal, sql, maxRows, finishCounts));
      }
      case "explain_query": {
        const sql = args["sql"] as string;
        if (ANALYZE_PATTERN.test(sql)) {
          return finish(
            deny(
              dbToolError(
                "INVALID_PARAMS",
                "explain_query must not run ANALYZE",
              ),
            ),
          );
        }
        const guard = await sqlGuard(sql, deps.catalog.catalog);
        if (!guard.ok) return finish(deny(guard.error));
        const policy = await deps.policy.check({
          ast: guard.ast,
          sql,
          catalog: deps.catalog.catalog,
          principal,
        });
        if (!policy.allowed) return finish(deny(policy.error));
        const explained = await executeReadOnly(
          `EXPLAIN (FORMAT JSON) ${policy.sql}`,
          50,
          deps.sessionFactory,
        );
        if ("error" in explained) return finish(deny(explained.error));
        const plan = parseExplainPlan(explained.rows);
        if (plan === null) {
          return finish(
            deny(dbToolError("INTERNAL_ERROR", "could not parse EXPLAIN output")),
          );
        }
        explainCost = plan.estimatedCost;
        rowCount = 1;
        return finish({
          ok: true,
          data: {
            estimatedCost: plan.estimatedCost,
            estimatedRows: plan.estimatedRows,
            planJson: plan.planJson,
          },
        });
      }
      case "search_semantic_layer": {
        const query = args["query"] as string;
        const topK = args["topK"] as number;
        const allowRestricted = principal.scopes.includes("data:sensitive");
        let chunks: SearchSemanticLayerChunk[];
        try {
          chunks = await deps.search(query, topK, allowRestricted);
        } catch (error) {
          return finish(deny(sanitizeError(error)));
        }
        const redacted = chunks.map((chunk) => {
          const content = redactPII(chunk.content);
          if (content.hit) piiHits += 1;
          return { ...chunk, content: content.redacted };
        });
        rowCount = redacted.length;
        return finish({ ok: true, data: { chunks: redacted } });
      }
    }
  } catch (error) {
    return finish(deny(sanitizeError(error)));
  }
}

async function runSqlStages(
  deps: GatewayDeps,
  principal: Principal,
  sql: string,
  maxRows: number,
  counts: (info: { rowCount: number; piiHits: number }) => void,
): Promise<PipelineResult> {
  const guard = await sqlGuard(sql, deps.catalog.catalog);
  if (!guard.ok) return { ok: false, error: guard.error };
  const policy = await deps.policy.check({
    ast: guard.ast,
    sql,
    catalog: deps.catalog.catalog,
    principal,
  });
  if (!policy.allowed) return { ok: false, error: policy.error };
  const executed = await executeReadOnly(
    policy.sql,
    maxRows,
    deps.sessionFactory,
  );
  if ("error" in executed) return { ok: false, error: executed.error };
  let hits = 0;
  const rows = executed.rows.map((row) => {
    const redacted = redactRow({ ...row });
    if (redacted.hit) hits += 1;
    return redacted.row;
  });
  counts({ rowCount: executed.rowCount, piiHits: hits });
  return {
    ok: true,
    data: {
      columns: executed.columns,
      rows,
      rowCount: executed.rowCount,
      truncated: executed.truncated,
      maskedColumns: policy.maskedColumns,
      durationMs: executed.durationMs,
    },
  };
}

function parseExplainPlan(
  rows: Record<string, unknown>[],
): { estimatedCost: number; estimatedRows: number; planJson: unknown } | null {
  const first = rows[0];
  if (first === undefined) return null;
  const planValue = first["QUERY PLAN"] ?? first["query plan"];
  if (!Array.isArray(planValue) || planValue.length === 0) return null;
  const plan = (planValue[0] as { Plan?: Record<string, unknown> })?.Plan;
  if (typeof plan !== "object" || plan === null) return null;
  const estimatedCost = (plan as Record<string, unknown>)["Total Cost"];
  const estimatedRows = (plan as Record<string, unknown>)["Plan Rows"];
  if (typeof estimatedCost !== "number" || typeof estimatedRows !== "number") {
    return null;
  }
  return { estimatedCost, estimatedRows, planJson: planValue };
}

export async function executeResourceRead(
  deps: GatewayDeps,
  headers: Record<string, string | string[] | undefined>,
  uri: string,
  documents: ResourceDocument[],
): Promise<PipelineResult> {
  const started = Date.now();
  const auth = authenticateRequest(headers, deps.clients);
  if ("error" in auth) {
    auditCall({
      ts: new Date().toISOString(),
      runId: "unknown",
      userId: "",
      role: "",
      clientId: "",
      scopes: [],
      tool: `resource:${uri}`,
      params: {},
      rowCount: 0,
      durationMs: Date.now() - started,
      decision: "deny",
      errorCode: auth.error.code,
      piiHits: 0,
    });
    return { ok: false, error: auth.error };
  }
  const principal = auth.auth.principal;
  const scopeError = requireScope(principal, "schema:read");
  const record = {
    ts: new Date().toISOString(),
    runId: auth.auth.runId,
    userId: auth.auth.userId,
    role: principal.role,
    clientId:
      deps.clients.find((candidate) => candidate.role === principal.role)
        ?.clientId ?? principal.role,
    scopes: [...principal.scopes],
    tool: `resource:${uri}`,
    params: {},
    rowCount: 0,
    durationMs: Date.now() - started,
    piiHits: 0,
  };
  if (scopeError !== null) {
    auditCall({ ...record, decision: "deny", errorCode: scopeError.code });
    return { ok: false, error: scopeError };
  }
  const document = documents.find((candidate) => candidate.uri === uri);
  if (document === undefined) {
    const error = dbToolError("INVALID_PARAMS", "unknown resource");
    auditCall({ ...record, decision: "deny", errorCode: error.code });
    return { ok: false, error };
  }
  const allowRestricted = principal.scopes.includes("data:sensitive");
  const filtered = filterResourceSections(document.text, allowRestricted);
  const redacted = redactPII(filtered);
  auditCall({
    ...record,
    rowCount: 1,
    durationMs: Date.now() - started,
    decision: "allow",
    piiHits: redacted.hit ? 1 : 0,
  });
  return {
    ok: true,
    data: { uri, mimeType: "text/markdown", text: redacted.redacted },
  };
}
