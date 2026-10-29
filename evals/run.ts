// Eval CLI (EVAL-01, D-15, G-01): small tsx runner behind `pnpm eval`.
// Discovers evals/uc-*/ fixtures plus evals/safety fixtures, validates each
// case, runs data cases through the live harness adapter (buildRootGraph
// with the deterministic fake model over the running MCP gateway + loaded
// DB, per the 01-14 live-harness recipe), grades data cases with
// exGrader.ts, drives every safety case through the REAL
// ValidatedQueryExecutor plus LocalQuerySafetyGate plus the real MCP gateway
// with a scripted per-case model (the fixture attack SQL, deterministic —
// the only prompt consumer, and it ignores its input), and writes versioned
// JSON results. The injectable stub adapter stays exported for unit tests;
// main() always runs live — never a fake pass. Exit contract: 0 all EX
// pass AND all safety pass, 1 graded failure (data or safety), 2
// infrastructure failure (DB/gateway/env — clear message, never a hang).
//
// NOTE: case validation here is a small structural checker, not zod: zod
// does not resolve from the repo root under pnpm isolation (only workspace
// packages declare it). The checker enforces the same required fields the
// finalized case schema mandates.
//
// Safety secrecy: fixture attack text reaches only the scripted model (which
// ignores its prompt input), the pure guard/gate functions, and the gateway
// under test. The driver uses a noop span sink, writes no trace files, and
// evals/** stays under .openwikiignore.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRootGraph } from "@shared/agent";
import { createCheckpointer } from "@shared/agent/ports";
// Relative source import, not the frozen root barrel: graph.test.ts pins the
// barrel to the root surface only, so the eval-only HTTP caller resolves from
// the agent source file (same module graph the agent tests use).
import { callMcpTool } from "../packages/agent/src/mcpClient.js";
import {
  ValidatedQueryExecutor,
  localQuerySafetyGate,
  type ChatModelLike,
  type McpToolCaller,
} from "@shared/agent/queryExecutor";
import { sqlGuard, warmupSqlGuard } from "@shared/access-policy";
import type { SchemaCatalog } from "@shared/contracts";
import { LARGE_TABLES } from "../packages/mcp-server/src/catalog.js";
import { gradeExecution } from "./exGrader.js";
import { compareRuns, type EvalResultsFile } from "./regression.js";
import {
  gatewayStageFor,
  gradeResubmitPair,
  gradeSafetyCase,
  validateSafetyRecord,
  type SafetyCase,
} from "./safety.js";
import {
  gradeGatewayCase,
  validateGatewayRecord,
  type GatewayCase,
  type GatewayObserved,
} from "./gateway.js";

export { gradeExecution } from "./exGrader.js";
export { compareRuns } from "./regression.js";

/** Exit code when the harness adapter is still the unwired default. */
export const STUB_EXIT_CODE = 2;

/** Exit code when DB/gateway/env infrastructure is unreachable. */
export const INFRA_EXIT_CODE = 2;

export interface EvalCase {
  id: string;
  question: string;
  difficulty?: string;
  role?: string;
  goldSql?: string;
  goldRows?: Record<string, unknown>[];
  goldResultPath?: string;
  ordered?: boolean;
  datasetVersion: string;
  tags?: string[];
}

export interface HarnessOutcome {
  status: string;
  rows?: Record<string, unknown>[];
  reason?: string;
  ms: number;
  tokens: number;
  wired?: boolean;
}

export type HarnessAdapter = (c: EvalCase) => Promise<HarnessOutcome>;

/** Safety fixture record (EVAL-04, G-01): validated by safety.ts. */
export type { SafetyCase } from "./safety.js";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation of one discovered case (see module NOTE on zod). */
export function validateCase(raw: unknown): {
  ok: boolean;
  value?: EvalCase;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["case is not an object"] };
  if (typeof raw["id"] !== "string" || raw["id"].trim() === "") {
    errors.push("id must be a non-empty string");
  }
  if (typeof raw["question"] !== "string" || raw["question"].trim() === "") {
    errors.push("question must be a non-empty string");
  }
  if (typeof raw["datasetVersion"] !== "string" || raw["datasetVersion"].trim() === "") {
    errors.push("datasetVersion must be a non-empty string");
  }
  if (raw["difficulty"] !== undefined && !DIFFICULTIES.has(raw["difficulty"] as string)) {
    errors.push("difficulty must be easy, medium, or hard");
  }
  const hasRows = Array.isArray(raw["goldRows"]);
  const hasPath = typeof raw["goldResultPath"] === "string" && raw["goldResultPath"] !== "";
  if (!hasRows && !hasPath) {
    errors.push("one of goldRows or goldResultPath is required");
  }
  if (raw["ordered"] !== undefined && typeof raw["ordered"] !== "boolean") {
    errors.push("ordered must be a boolean");
  }
  if (raw["tags"] !== undefined && !Array.isArray(raw["tags"])) {
    errors.push("tags must be an array");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      id: raw["id"] as string,
      question: raw["question"] as string,
      difficulty: raw["difficulty"] as string | undefined,
      role: raw["role"] as string | undefined,
      goldSql: raw["goldSql"] as string | undefined,
      goldRows: (raw["goldRows"] as Record<string, unknown>[] | undefined) ?? undefined,
      goldResultPath: (raw["goldResultPath"] as string | undefined) ?? undefined,
      ordered: (raw["ordered"] as boolean | undefined) ?? false,
      datasetVersion: raw["datasetVersion"] as string,
      tags: (raw["tags"] as string[] | undefined) ?? [],
    },
  };
}

function loadGoldRows(c: EvalCase, repoRoot: string): Record<string, unknown>[] {
  if (c.goldRows) return c.goldRows;
  // UC-01 benchmark scale: rows live behind a goldResultPath pointer.
  const raw = readFileSync(path.join(repoRoot, c.goldResultPath as string), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`gold rows at ${c.goldResultPath} are not an array`);
  return parsed as Record<string, unknown>[];
}

/** Default stub adapter: explicit not-wired marker, never a fake pass. */
export function stubAdapter(c: EvalCase): Promise<HarnessOutcome> {
  return Promise.resolve({
    status: "not_wired",
    rows: [],
    reason: `no live harness yet (01-14 wires this adapter); case ${c.id} not executed`,
    ms: 0,
    tokens: 0,
    wired: false,
  });
}

// Live harness adapter (01-15, wave 6): the 01-14 invoke recipe against the
// running gateway + loaded DB. No mcp-server/src imports here — the agent
// root builder plus its ./ports checkpointer only (ESLint §5.2 graph).

/** Role → bearer-token env var (D-11 registry; tokens stay in env only). */
const ROLE_TOKEN_ENV: Record<string, string> = {
  sales_south: "MCP_TOKEN_SALES_SOUTH",
  marketing: "MCP_TOKEN_MARKETING",
  hr: "MCP_TOKEN_HR",
  admin: "MCP_TOKEN_ADMIN",
  data_admin: "MCP_TOKEN_ADMIN",
};

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function tcpReady(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
  });
}

function dbHostPort(connString: string): { host: string; port: number } | null {
  try {
    const url = new URL(connString);
    return { host: url.hostname || "127.0.0.1", port: Number(url.port) || 5432 };
  } catch {
    return null;
  }
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

export interface LiveHandle {
  adapter: HarnessAdapter;
  close: () => Promise<void>;
  /** Base URL of the booted gateway child (safety driver reuses it). */
  mcpUrl: string;
}

/**
 * Build the live adapter: DB TCP preflight, gateway child boot with
 * bounded healthz wait, PostgresSaver checkpointer (fail-fast setup),
 * then per-case buildRootGraph invoke with the 01-12 identity shape.
 * Deterministic fake model by default (no API key): AGENT_MODEL_API_KEY
 * is dropped unless EVAL_USE_LIVE_MODEL=1 explicitly opts into keyed runs.
 * Every wait is bounded — a missing DB/gateway throws a clear message,
 * never hangs.
 */
export async function buildLiveAdapter(repoRoot: string): Promise<LiveHandle> {
  process.loadEnvFile?.();
  if (process.env.EVAL_USE_LIVE_MODEL !== "1") {
    delete process.env.AGENT_MODEL_API_KEY;
  }

  const agentRoUrl = process.env.AGENT_RO_DATABASE_URL ?? "";
  if (!agentRoUrl) {
    throw new Error(
      "eval: AGENT_RO_DATABASE_URL is not set — copy .env.example to .env and fill the role URLs; refusing to guess a database.",
    );
  }
  const harnessStateUrl = process.env.HARNESS_STATE_DATABASE_URL ?? "";
  if (!harnessStateUrl) {
    throw new Error(
      "eval: HARNESS_STATE_DATABASE_URL is not set — the live checkpointer needs the harness_state identity.",
    );
  }

  const db = dbHostPort(agentRoUrl);
  if (db && !(await tcpReady(db.host, db.port, 5000))) {
    throw new Error(
      `eval: database unreachable at ${db.host}:${db.port} — start it first (pnpm db:up), then re-run pnpm eval.`,
    );
  }

  const mcpPort = Number(process.env.MCP_PORT ?? 8081);
  const mcpUrl = process.env.MCP_URL ?? `http://127.0.0.1:${mcpPort}/mcp`;
  const gateway: ChildProcess = spawn("node", ["--import", "tsx", "packages/mcp-server/src/server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, MCP_PORT: String(mcpPort), AGENT_RO_DATABASE_URL: agentRoUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gatewayStderr = "";
  gateway.stderr?.on("data", (chunk) => {
    gatewayStderr += String(chunk);
  });
  const healthz = `http://127.0.0.1:${mcpPort}/healthz`;
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 30_000) {
    if (await httpOk(healthz)) {
      ready = true;
      break;
    }
    if (gateway.exitCode !== null && gateway.exitCode !== undefined) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    gateway.kill();
    throw new Error(
      `eval: MCP gateway did not become ready at ${healthz} within 30s — is the DB loaded (pnpm data:verify)?` +
        (gatewayStderr ? ` gateway stderr tail: ${gatewayStderr.slice(-500)}` : ""),
    );
  }

  const checkpointer = await withTimeout(
    createCheckpointer(harnessStateUrl),
    30_000,
    "eval: harness_state checkpointer setup timed out after 30s — check HARNESS_STATE_DATABASE_URL and the langgraph grant.",
  );
  const tracesDir = mkdtempSync(path.join(tmpdir(), "se373-eval-"));

  const adapter: HarnessAdapter = async (c) => {
    const role = c.role ?? "sales_south";
    const tokenEnv = ROLE_TOKEN_ENV[role];
    if (!tokenEnv) {
      return { status: "error", rows: [], reason: `unknown eval role '${role}'`, ms: 0, tokens: 0, wired: true };
    }
    const token = process.env[tokenEnv] ?? "";
    if (!token) {
      return { status: "error", rows: [], reason: `eval: ${tokenEnv} is not set for role '${role}'`, ms: 0, tokens: 0, wired: true };
    }
    const runId = randomUUID();
    const userId = role;
    const threadId = `chat:${userId}:${runId}`;
    const t0 = Date.now();
    try {
      const graph = buildRootGraph({ checkpointer });
      const out = (await withTimeout(
        graph.invoke(
          { question: c.question, ucId: "tracer", runId, threadId },
          {
            configurable: {
              thread_id: threadId,
              mcpUrl,
              token,
              runId,
              userId,
              roleScope: role,
              threadId,
              tracesDir,
            },
          },
        ),
        150_000,
        `eval: case ${c.id} timed out after 150s`,
      )) as { status?: string; resultPreview?: Record<string, unknown>[] };
      return {
        status: out.status ?? "error",
        rows: out.resultPreview ?? [],
        reason: out.status === "ok" || out.status === "no_data" ? undefined : `harness status '${out.status}'`,
        ms: Date.now() - t0,
        tokens: 0,
        wired: true,
      };
    } catch (error) {
      return {
        status: "error",
        rows: [],
        reason: error instanceof Error ? error.message : String(error),
        ms: Date.now() - t0,
        tokens: 0,
        wired: true,
      };
    }
  };

  return {
    adapter,
    mcpUrl,
    close: async () => {
      gateway.kill();
      await (checkpointer as unknown as { end?: () => Promise<void> }).end?.();
    },
  };
}

export interface GradedCase {
  id: string;
  status: string;
  exPass: boolean;
  ms: number;
  tokens: number;
  note?: string;
}

/** Grade a batch of cases through any harness adapter. */
export async function runEval(
  cases: EvalCase[],
  adapter: HarnessAdapter,
): Promise<EvalResultsFile> {
  const graded: GradedCase[] = [];
  for (const c of cases) {
    const outcome = await adapter(c);
    if (outcome.wired === false) {
      graded.push({
        id: c.id,
        status: outcome.status,
        exPass: false,
        ms: outcome.ms,
        tokens: outcome.tokens,
        note: "harness not wired",
      });
      continue;
    }
    const { pass, mismatches } = gradeExecution(
      { status: outcome.status, rows: outcome.rows ?? [], reason: outcome.reason },
      { rows: c.goldRows ?? [], ordered: c.ordered ?? false },
    );
    graded.push({
      id: c.id,
      status: outcome.status,
      exPass: pass,
      ms: outcome.ms,
      tokens: outcome.tokens,
      ...(pass ? {} : { note: mismatches.join("; ") }),
    });
  }
  const passed = graded.filter((g) => g.exPass).length;
  return {
    datasetVersion: cases[0]?.datasetVersion ?? "unknown",
    cases: graded,
    summary: {
      total: graded.length,
      passed,
      exRate: graded.length === 0 ? 0 : passed / graded.length,
      avgMs: 0,
      avgTokens: 0,
    },
  };
}

function discoverUcDirs(repoRoot: string): string[] {
  return readdirSync(path.join(repoRoot, "evals"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "safety")
    .map((entry) => entry.name)
    .sort();
}

function loadUcCases(repoRoot: string, uc: string): EvalCase[] {
  const dir = path.join(repoRoot, "evals", uc);
  const out: EvalCase[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const checked = validateCase(raw);
    if (!checked.ok || !checked.value) {
      throw new Error(`invalid case ${uc}/${file}: ${checked.errors?.join("; ")}`);
    }
    const c = checked.value;
    if (!c.goldRows && c.goldResultPath) {
      c.goldRows = loadGoldRows(c, repoRoot);
    }
    out.push(c);
  }
  return out;
}

function loadSafety(repoRoot: string): SafetyCase[] {
  const file = path.join(repoRoot, "evals", "safety", "cases.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const checked = validateSafetyRecord(JSON.parse(line) as unknown);
      if (!checked.ok || !checked.value) {
        throw new Error(
          `invalid safety case line ${index + 1}: ${checked.errors?.join("; ")}`,
        );
      }
      return checked.value;
    });
}

interface SafetyDrive {
  blocked: boolean;
  observedBlockingLayer: string;
  status: string;
  code: string;
}

/** Scripted model: proposes the fixture attack SQL, ignoring its input. */
function scriptedModel(sql: string, tablesUsed: string[]): ChatModelLike {
  return {
    withStructuredOutput: () => ({
      invoke: () => Promise.resolve({ sql, tablesUsed }),
    }),
  };
}

/**
 * HTTP caller over the real gateway as the case role. Gateway denials arrive
 * as error-shaped JSON text; they are rethrown as code-carrying Errors so the
 * executor routes them faithfully (statusForError + repairable logic).
 */
function httpCaller(
  mcpUrl: string,
  token: string,
  runId: string,
  userId: string,
  roleScope: string,
  calls: string[],
): McpToolCaller {
  return {
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push(tool);
      const result = await callMcpTool(
        { mcpUrl, token, runId, userId, roleScope },
        tool,
        args,
      );
      const parsed: unknown = JSON.parse(result.text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "code" in parsed &&
        typeof (parsed as { code: unknown }).code === "string"
      ) {
        const denied = parsed as {
          code: string;
          message?: unknown;
          cursorPosition?: unknown;
        };
        const failure = new Error(
          typeof denied.message === "string" && denied.message.length > 0
            ? denied.message
            : `MCP tool ${tool} failed with ${denied.code}`,
        ) as Error & { code?: unknown; cursorPosition?: unknown };
        failure.code = denied.code;
        if (typeof denied.cursorPosition === "number") {
          failure.cursorPosition = denied.cursorPosition;
        }
        throw failure;
      }
      return parsed;
    },
  };
}

interface DescribeColumns {
  table: string;
  columns: { name: string; type: string; nullable: boolean; sensitive: boolean }[];
}

/** Catalog from real gateway describe calls, overlaid with large flags. */
async function safetyCatalog(
  caller: McpToolCaller,
  tables: string[],
): Promise<SchemaCatalog> {
  const large = new Set(LARGE_TABLES.map((name) => name.toLowerCase()));
  const out: SchemaCatalog["tables"] = [];
  for (const table of tables) {
    const raw = (await caller.call("describe_table", {
      table,
    })) as unknown as DescribeColumns;
    out.push({
      name: raw.table,
      schema: "public",
      columns: raw.columns.map((column) => ({
        ...column,
        large: large.has(raw.table.toLowerCase()),
      })),
    });
  }
  return { tables: out };
}

/**
 * Drive one attack through the real ValidatedQueryExecutor +
 * LocalQuerySafetyGate + real MCP gateway, attributing the stopping layer
 * from actual behavior: zero explain/run calls means a local stop
 * (disambiguated by re-running the exact pure guard/gate inputs);
 * gateway-reached denials map by their real error code.
 */
async function driveSafetyCase(
  mcpUrl: string,
  c: SafetyCase,
): Promise<SafetyDrive> {
  const tokenEnv = ROLE_TOKEN_ENV[c.role];
  if (!tokenEnv) {
    throw new Error(`unknown safety role '${c.role}' for case ${c.id}`);
  }
  const token = process.env[tokenEnv] ?? "";
  if (!token) {
    throw new Error(`eval: ${tokenEnv} is not set for safety case ${c.id}`);
  }
  const runId = randomUUID();
  const calls: string[] = [];
  const caller = httpCaller(mcpUrl, token, runId, c.role, c.role, calls);
  const catalog = await safetyCatalog(caller, c.candidateTables);
  const executor = new ValidatedQueryExecutor({
    model: scriptedModel(c.attackSql, c.candidateTables),
    mcp: caller,
    emitSpan: () => "",
  });
  const result = await executor.run({
    question: c.question,
    candidateTables: c.candidateTables,
    principal: { runId, userId: c.role, roleScope: c.role },
    catalog,
  });
  const reachedGateway =
    calls.includes("explain_query") || calls.includes("run_query");
  if (!reachedGateway) {
    if (result.status !== "restricted" && result.status !== "needs_clarification") {
      throw new Error(
        `safety case ${c.id}: local stop but executor status is '${result.status}' — attribution impossible`,
      );
    }
    const guard = await sqlGuard(c.attackSql, catalog);
    if (!guard.ok) {
      return {
        blocked: true,
        observedBlockingLayer: "local-guard",
        status: result.status,
        code: guard.error.code,
      };
    }
    const gate = localQuerySafetyGate(c.attackSql, guard, catalog);
    if (gate.verdict === "deny") {
      return {
        blocked: true,
        observedBlockingLayer: "safetyGate",
        status: result.status,
        code: gate.error.code,
      };
    }
    if (gate.verdict === "needs_clarification") {
      return {
        blocked: true,
        observedBlockingLayer: "safetyGate",
        status: result.status,
        code: "needs_clarification",
      };
    }
    throw new Error(
      `safety case ${c.id}: executor stopped locally but guard and gate both pass — attribution impossible`,
    );
  }
  if (result.status === "ok" || result.status === "no_data") {
    return {
      blocked: false,
      observedBlockingLayer: "none-allowed",
      status: result.status,
      code: result.status,
    };
  }
  if (result.status === "restricted" || result.status === "error") {
    return {
      blocked: true,
      observedBlockingLayer: gatewayStageFor(result.error.code, result.error.message),
      status: result.status,
      code: result.error.code,
    };
  }
  return {
    blocked: false,
    observedBlockingLayer: "gateway:executor",
    status: result.status,
    code: result.status,
  };
}

// Direct-MCP gateway driver (UC-09 D-02, issue #39): one tool call per case
// over the live gateway child booted by buildLiveAdapter, graded by the
// pure helpers in gateway.ts. Results merge with the untouched EX path into
// the same EvalResultsFile envelope under a constant datasetVersion so
// `pnpm eval --compare` keeps working across Run 1 vs Run 2.

/** Gateway-suite dataset version: constant across runs (compare-compatible). */
export const GATEWAY_DATASET_VERSION = "uc09-gateway-1";

/** Per-case ceiling: gateway calls are milliseconds except the slow probe. */
const GATEWAY_CASE_TIMEOUT_MS = 60_000;

/** Strict load of the direct-MCP records for one UC dir. */
export function loadGatewayCases(repoRoot: string, uc: string): GatewayCase[] {
  const file = path.join(repoRoot, "evals", uc, "cases.jsonl");
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const checked = validateGatewayRecord(JSON.parse(line) as unknown);
      if (!checked.ok || !checked.value) {
        throw new Error(
          `invalid gateway case ${uc} line ${index + 1}: ${checked.errors?.join("; ")}`,
        );
      }
      return checked.value;
    });
}

function observedFromPayload(
  parsed: unknown,
  isError: boolean | undefined,
  httpStatus: number,
): GatewayObserved {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "code" in parsed &&
    typeof (parsed as { code: unknown }).code === "string"
  ) {
    const denied = parsed as { code: string; message?: unknown };
    return {
      ok: false,
      httpStatus,
      code: denied.code,
      message:
        typeof denied.message === "string" ? denied.message : "denied",
      isError,
    };
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    httpStatus,
    data: parsed,
    rows: Array.isArray(record["rows"])
      ? (record["rows"] as Record<string, unknown>[])
      : undefined,
    truncated:
      typeof record["truncated"] === "boolean"
        ? (record["truncated"] as boolean)
        : undefined,
    maskedColumns: Array.isArray(record["maskedColumns"])
      ? (record["maskedColumns"] as string[])
      : undefined,
    message: "",
  };
}

/** Drive one gateway case through callMcpTool (authed legs only). */
async function driveGatewayCase(
  mcpUrl: string,
  c: GatewayCase,
): Promise<GatewayObserved> {
  if (!("role" in c.auth) || typeof c.auth.role !== "string") {
    throw new Error(
      `gateway case ${c.id}: no-or-bad-token legs land in Task 3 — refusing to guess a token`,
    );
  }
  const role = c.auth.role;
  const tokenEnv = ROLE_TOKEN_ENV[role];
  if (!tokenEnv) {
    throw new Error(`unknown gateway role '${role}' for case ${c.id}`);
  }
  const token = process.env[tokenEnv] ?? "";
  if (!token) {
    throw new Error(`eval: ${tokenEnv} is not set for gateway case ${c.id}`);
  }
  const runId = randomUUID();
  const result = await withTimeout(
    callMcpTool(
      { mcpUrl, token, runId, userId: role, roleScope: role },
      c.tool,
      c.params,
    ),
    GATEWAY_CASE_TIMEOUT_MS,
    `eval: gateway case ${c.id} timed out after ${GATEWAY_CASE_TIMEOUT_MS}ms`,
  );
  return observedFromPayload(
    JSON.parse(result.text) as unknown,
    result.isError,
    200,
  );
}

/** Drive every gateway case, grading each into the shared GradedCase shape. */
export async function driveGatewaySuite(
  mcpUrl: string,
  cases: GatewayCase[],
): Promise<GradedCase[]> {
  const graded: GradedCase[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const observed = await driveGatewayCase(mcpUrl, c);
      const grade = gradeGatewayCase(c, observed);
      graded.push({
        id: c.id,
        status: observed.ok ? "ok" : "error",
        exPass: grade.pass,
        ms: Date.now() - t0,
        tokens: 0,
        ...(grade.pass ? {} : { note: grade.reason }),
      });
    } catch (error) {
      graded.push({
        id: c.id,
        status: "error",
        exPass: false,
        ms: Date.now() - t0,
        tokens: 0,
        note: `driver error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return graded;
}

/** Merge EX results with gateway results under the constant version. */
export function mergeGatewayResults(
  exResults: EvalResultsFile,
  gatewayGraded: GradedCase[],
): EvalResultsFile {
  const merged = [...exResults.cases, ...gatewayGraded];
  const passed = merged.filter((g) => g.exPass).length;
  return {
    datasetVersion: GATEWAY_DATASET_VERSION,
    cases: merged,
    summary: {
      total: merged.length,
      passed,
      exRate: merged.length === 0 ? 0 : passed / merged.length,
      avgMs: 0,
      avgTokens: 0,
    },
  };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const args = process.argv.slice(2);

  if (args[0] === "--compare" && args.length === 3) {
    const before = JSON.parse(readFileSync(args[1], "utf8")) as EvalResultsFile;
    const after = JSON.parse(readFileSync(args[2], "utf8")) as EvalResultsFile;
    try {
      const delta = compareRuns(before, after);
      console.log(JSON.stringify(delta, null, 2));
      process.exit(0);
    } catch (error) {
      console.error(`compare failed: ${(error as Error).message}`);
      process.exit(1);
    }
    return;
  }

  let ucs: string[];
  if (args[0] === "--all") {
    ucs = discoverUcDirs(repoRoot);
  } else if (args[0] === "--uc" && typeof args[1] === "string") {
    ucs = [args[1]];
  } else {
    console.error("usage: pnpm eval --all | pnpm eval --uc <id>");
    process.exit(1);
    return;
  }

  mkdirSync(path.join(repoRoot, "results"), { recursive: true });

  let live: LiveHandle;
  try {
    live = await buildLiveAdapter(repoRoot);
  } catch (error) {
    console.error(`eval infrastructure failure: ${(error as Error).message}`);
    process.exit(INFRA_EXIT_CODE);
    return;
  }

  let failed = false;
  try {
    for (const uc of ucs) {
      const cases = loadUcCases(repoRoot, uc);
      const gatewayFile = path.join(repoRoot, "evals", uc, "cases.jsonl");
      if (existsSync(gatewayFile)) {
        // UC-09 dispatch (D-02): gateway records drive direct-MCP; the EX
        // path for *.json cases (tracer-01) keeps working in the same run
        // and both merge into one compare-compatible envelope.
        const gatewayCases = loadGatewayCases(repoRoot, uc);
        const exResults = await runEval(cases, live.adapter);
        const gatewayGraded = await driveGatewaySuite(
          live.mcpUrl,
          gatewayCases,
        );
        const results = mergeGatewayResults(exResults, gatewayGraded);
        writeFileSync(
          path.join(repoRoot, "results", `${uc}.json`),
          `${JSON.stringify({ uc, ...results }, null, 2)}\n`,
          "utf8",
        );
        if (results.summary.passed !== results.summary.total) failed = true;
        console.log(
          `eval ${uc}: ${results.summary.passed}/${results.summary.total} EX pass (dataset ${results.datasetVersion}, live harness + gateway driver)`,
        );
        continue;
      }
      const results = await runEval(cases, live.adapter);
      if (cases.length > 0 && results.datasetVersion !== cases[0].datasetVersion) {
        throw new Error(`datasetVersion drift inside ${uc}`);
      }
      writeFileSync(
        path.join(repoRoot, "results", `${uc}.json`),
        `${JSON.stringify({ uc, ...results }, null, 2)}\n`,
        "utf8",
      );
      if (results.summary.passed !== results.summary.total) failed = true;
      console.log(
        `eval ${uc}: ${results.summary.passed}/${results.summary.total} EX pass (dataset ${results.datasetVersion}, live harness)`,
      );
    }

    await warmupSqlGuard();
    const safety = loadSafety(repoRoot);
    const safetyOut: Record<string, unknown>[] = [];
    for (const s of safety) {
      const resubmit = s.id === "safety-05-resubmit";
      const first = await driveSafetyCase(live.mcpUrl, s);
      let observed = first.observedBlockingLayer;
      let pass: boolean;
      let reason: string;
      if (resubmit) {
        const second = await driveSafetyCase(live.mcpUrl, s);
        const graded = gradeResubmitPair(s, first, second);
        pass = graded.pass;
        reason = graded.reason;
        observed = first.observedBlockingLayer;
      } else {
        const graded = gradeSafetyCase(s, first);
        pass = graded.pass;
        reason = graded.reason;
      }
      safetyOut.push({
        id: s.id,
        attack: s.attack,
        expectedBlockingLayer: s.expectedBlockingLayer,
        observedBlockingLayer: observed,
        expectBlocked: s.expectBlocked,
        blocked: first.blocked,
        pass,
        reason,
        status: first.status,
        code: first.code,
        fix: s.fix,
        notes: s.notes,
      });
      console.log(
        `  safety ${s.id}: ${pass ? "PASS" : "FAIL"} — ${reason} (expected ${s.expectedBlockingLayer})`,
      );
    }
    writeFileSync(
      path.join(repoRoot, "results", "safety.json"),
      `${JSON.stringify({ datasetVersion: "safety-1", cases: safetyOut }, null, 2)}\n`,
      "utf8",
    );
    const passedCount = safetyOut.filter((s) => s["pass"] === true).length;
    if (passedCount !== safetyOut.length) failed = true;
    console.log(
      `eval safety: ${passedCount}/${safetyOut.length} cases pass (scripted attacks through the real executor plus gateway; any miss fails the run)`,
    );
  } finally {
    await live.close();
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("evals/run.ts") || process.argv[1].endsWith("run.ts"));
if (invokedDirectly) {
  await main();
}
