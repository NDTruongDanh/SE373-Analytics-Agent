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
// under test. The driver traces through a real per-run JSONL emitter into
// the eval traces directory (local only, redacted before write, never
// LangSmith) and evals/** stays under .openwikiignore.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildRootGraph } from "@shared/agent";
import { createCheckpointer } from "@shared/agent/ports";
import { scrubLangSmithEnv } from "../packages/agent/src/telemetry/langsmith.js";
import { createSpanEmitter } from "../packages/agent/src/telemetry/spans.js";
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
import { sqlGuard, warmupSqlGuard, redactPII } from "@shared/access-policy";
import type { SchemaCatalog } from "@shared/contracts";
import { LARGE_TABLES } from "../packages/mcp-server/src/catalog.js";
import { EVAL_CLIENTS_ENV } from "../packages/mcp-server/src/config.js";
import { gradeExecution } from "./exGrader.js";
import { compareRuns, summarizeCases, type EvalResultsFile } from "./regression.js";
import {
  gatewayStageFor,
  gradeAnswerCase,
  gradeResubmitPair,
  gradeSafetyCase,
  isAnswerLiveReady,
  scrapeDeniedCode,
  validateSafetyRecord,
  type AnswerObserved,
  type SafetyCase,
} from "./safety.js";
import {
  auditTailLines,
  gradeGatewayCase,
  gradeAuditLines,
  observedFromPayload,
  validateGatewayRecord,
  type GatewayCase,
  type GatewayObserved,
} from "./gateway.js";
import {
  parseCountValue,
  probeAgentRoWriteRefused,
} from "../packages/data/src/guardOffProbe.js";

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
  /**
   * Root-graph route for the live adapter. The root router does not infer a
   * UC from the question, so the caller picks it: EX tracer cases keep the
   * legacy "tracer" default; answer-mode safety cases use text-to-sql so the
   * question runs through the real ValidatedQueryExecutor path.
   */
  ucId?: string;
}

/** UC-01 route id (packages/agent/src/constants.ts TEXT_TO_SQL_UC_ID; not on the frozen barrel). */
export const ANSWER_ROUTE_UC_ID = "text-to-sql";

export interface HarnessOutcome {
  status: string;
  rows?: Record<string, unknown>[];
  /** Agent answer text (tracer synthesis). Graded in memory only — never persisted raw. */
  answerText?: string;
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
  if (typeof raw["goldSql"] !== "string" || raw["goldSql"].trim() === "") {
    errors.push("goldSql must be a non-empty string");
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
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  // A benchmark may keep its snapshots in one immutable catalogue.  The
  // row's id selects its array, so every case still has an explicit path.
  if (isRecord(parsed) && Array.isArray(parsed[c.id])) {
    return parsed[c.id] as Record<string, unknown>[];
  }
  throw new Error(`gold rows for ${c.id} at ${c.goldResultPath} are not an array`);
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

/**
 * Eval environment guard (Phase 3, D-04): `pnpm eval` must NEVER export to
 * LangSmith, even with the env set (gold questions and injection rows stay
 * private). Deletes every tracing flag in-process before any graph is built
 * and drops the live model key unless explicitly opted in. Called first in
 * `buildLiveAdapter`, before any DB/gateway work.
 */
export function prepareEvalEnv(env: NodeJS.ProcessEnv = process.env): void {
  scrubLangSmithEnv(env);
  if (env["EVAL_USE_LIVE_MODEL"] !== "1") {
    delete env["AGENT_MODEL_API_KEY"];
  }
}

/** Role → bearer-token env var (D-11 registry; tokens stay in env only). */
const ROLE_TOKEN_ENV: Record<string, string> = {
  sales_south: "MCP_TOKEN_SALES_SOUTH",
  marketing: "MCP_TOKEN_MARKETING",
  hr: "MCP_TOKEN_HR",
  admin: "MCP_TOKEN_ADMIN",
  data_admin: "MCP_TOKEN_ADMIN",
  // Eval-only scope probe (issue #39, 02-01 Task 2 APPROVED): schema:read only.
  eval_schema_only: "MCP_TOKEN_EVAL_SCOPE",
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
  /** Directory the live adapter and safety driver trace into (JSONL only). */
  tracesDir: string;
}

/** Eval run identity for the per-case JSONL emitter (Phase 3 B6). */
export interface EvalRunIdentity {
  runId: string;
  threadId: string;
  userId: string;
  role: string;
}

/**
 * Per-case JSONL span emitter for eval runs (Phase 3 B6, D-01/D-04): the
 * same redacted writer the product path uses, bound to the case run
 * identity. JSONL-only by construction — this helper knows nothing about
 * LangSmith, and the adapter never passes callbacks, so eval traces stay
 * local even with the env set.
 */
export function createEvalEmitter(
  tracesDir: string,
  identity: EvalRunIdentity,
) {
  return createSpanEmitter({ ...identity, tracesDir });
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
export async function buildLiveAdapter(
  repoRoot: string,
  opts: { loadEnv?: boolean } = {},
): Promise<LiveHandle> {
  // Unit tests pass loadEnv: false so a developer's real .env (keys, DB
  // URLs) never leaks into the test process or spawns a live gateway.
  if (opts.loadEnv !== false) {
    try {
      process.loadEnvFile?.();
    } catch {
      // No .env in cwd (CI runners) — fall through to the explicit env
      // checks below, which fail with clear messages.
    }
  }
  // D-04 first: scrub every tracing flag before any graph exists, so eval
  // can never export even with the env set. Never pass callbacks here —
  // the adapter below invokes bare on purpose (JSONL traces only).
  prepareEvalEnv();

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
    // Eval's own gateway child opts the eval-only scope client in (issue #39);
    // no other boot path sets this flag.
    env: {
      ...process.env,
      MCP_PORT: String(mcpPort),
      AGENT_RO_DATABASE_URL: agentRoUrl,
      [EVAL_CLIENTS_ENV]: "1",
    },
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
    // B6: a real per-run emitter into the run traces directory (JSONL
    // only — invoke below stays callback-free per D-04).
    const emit = createEvalEmitter(tracesDir, { runId, threadId, userId, role });
    const t0 = Date.now();
    try {
      const graph = buildRootGraph({ checkpointer, emitSpan: emit });
      const out = (await withTimeout(
        graph.invoke(
          { question: c.question, ucId: c.ucId ?? "tracer", runId, threadId },
          {
            // D-04: never pass LangSmith callbacks here — eval traces stay
            // JSONL-local even if the flags were somehow re-set at runtime.
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
      )) as {
        status?: string;
        resultPreview?: Record<string, unknown>[];
        answerText?: unknown;
      };
      const status = out.status ?? "error";
      emit.emitRunDone(status);
      return {
        status,
        rows: out.resultPreview ?? [],
        answerText:
          typeof out.answerText === "string" ? out.answerText : undefined,
        reason: status === "ok" || status === "no_data" ? undefined : `harness status '${status}'`,
        ms: Date.now() - t0,
        tokens: 0,
        wired: true,
      };
    } catch (error) {
      // Redact before storing: the raw model/gateway message never lands
      // in results (B6) — only the scrubbed text survives.
      const reason = redactPII(
        error instanceof Error ? error.message : String(error),
      ).redacted;
      emit.emitRunDone("error");
      return {
        status: "error",
        rows: [],
        reason,
        ms: Date.now() - t0,
        tokens: 0,
        wired: true,
      };
    }
  };

  return {
    adapter,
    mcpUrl,
    tracesDir,
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
      {
        status: c.tags?.includes("unanswerable") ? "cannot_answer" : undefined,
        rows: c.goldRows ?? [],
        ordered: c.ordered ?? false,
      },
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
  return {
    datasetVersion: cases[0]?.datasetVersion ?? "unknown",
    cases: graded,
    summary: summarizeCases(graded),
  };
}

function discoverUcDirs(repoRoot: string): string[] {
  return readdirSync(path.join(repoRoot, "evals"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "safety")
    .map((entry) => entry.name)
    .sort();
}

export function loadUcCases(repoRoot: string, uc: string): EvalCase[] {
  const dir = path.join(repoRoot, "evals", uc);
  const out: EvalCase[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json") && !file.endsWith(".jsonl")) continue;
    const contents = readFileSync(path.join(dir, file), "utf8");
    const records: unknown[] = file.endsWith(".jsonl")
      ? contents
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line, index) => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              throw new Error(`invalid JSON in ${uc}/${file} line ${index + 1}`);
            }
          })
      : [JSON.parse(contents) as unknown];
    for (const raw of records) {
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
 * gateway-reached denials map by their real error code. The executor
 * writes through a real per-run JSONL emitter (B6) into the caller's
 * traces directory — local traces only, never LangSmith (D-04: this file
 * scrubs the flags up front and passes no callbacks anywhere).
 */
async function driveSafetyCase(
  mcpUrl: string,
  c: SafetyCase,
  tracesDir: string,
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
  // B6: the safety drive traces like every other eval run (local JSONL
  // only); the shared writer redacts before anything reaches disk.
  const emit = createEvalEmitter(tracesDir, {
    runId,
    threadId: `safety:${c.id}:${runId}`,
    userId: c.role,
    role: c.role,
  });
  const executor = new ValidatedQueryExecutor({
    model: scriptedModel(c.attackSql, c.candidateTables),
    mcp: caller,
    emitSpan: (event) =>
      emit({
        node: event.node,
        type: event.type,
        durationMs: event.durationMs ?? 0,
        payload: event.payload,
        attempt: event.attempt,
      }),
  });
  const result = await executor.run({
    question: c.question,
    candidateTables: c.candidateTables,
    principal: { runId, userId: c.role, roleScope: c.role },
    catalog,
  });
  emit.emitRunDone(result.status);
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

// Agent-answer safety leg (D-04, issue #39): the case question runs through
// the real agent graph under the case role token (same buildRootGraph path
// as the EX adapter), then rows plus answerText are graded in memory. Rows
// plus answerText may carry PII when masking regresses, so they are graded
// and dropped — never written to results, traces, or the console. Without
// EVAL_USE_LIVE_MODEL=1 plus a model key the case reports not_wired
// infra-skip: never a pass, never counted in pass-rate math.
async function driveAnswerCase(
  adapter: HarnessAdapter,
  c: SafetyCase,
): Promise<{
  grade: { pass: boolean; reason: string; notWired: boolean };
  observedBlockingLayer: string;
  status: string;
  blocked: boolean;
  skipped: boolean;
}> {
  if (!isAnswerLiveReady(process.env)) {
    const observed: AnswerObserved = {
      status: "not_wired",
      rows: [],
      answerText: "",
      wired: false,
    };
    return {
      grade: gradeAnswerCase(c, observed),
      observedBlockingLayer: "not_wired",
      status: "not_wired",
      blocked: false,
      skipped: true,
    };
  }
  const outcome = await adapter({
    id: c.id,
    question: c.question,
    role: c.role,
    datasetVersion: "safety-1",
    ucId: ANSWER_ROUTE_UC_ID,
  });
  const observed: AnswerObserved = {
    status: outcome.status,
    rows: outcome.rows ?? [],
    answerText: outcome.answerText ?? "",
    wired: outcome.wired !== false,
  };
  const grade = gradeAnswerCase(c, observed);
  let observedBlockingLayer: string;
  if (!grade.pass) {
    observedBlockingLayer = "none-allowed";
  } else if (observed.status === "error" || observed.status === "restricted") {
    const text = `${outcome.reason ?? ""} ${observed.status}`;
    const code = scrapeDeniedCode(text);
    observedBlockingLayer =
      code === undefined ? "gateway:executor" : gatewayStageFor(code, text);
  } else {
    observedBlockingLayer = "agent:answer";
  }
  return {
    grade,
    observedBlockingLayer,
    status: observed.status,
    blocked: grade.pass,
    skipped: false,
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

/** Drive one gateway case through callMcpTool (authed legs only). */
async function driveGatewayCaseMcp(
  mcpUrl: string,
  c: GatewayCase,
  runId: string,
  token: string,
  role: string,
  timeoutMs: number,
): Promise<GatewayObserved> {
  const result = await withTimeout(
    callMcpTool(
      { mcpUrl, token, runId, userId: role, roleScope: role },
      c.tool,
      c.params,
    ),
    timeoutMs,
    `eval: gateway case ${c.id} timed out after ${timeoutMs}ms`,
  );
  // Every authed call must come back as gateway JSON (data or DbToolError).
  // A non-JSON payload — e.g. the SDK's own "MCP error -32602" text when it
  // validates params ahead of the pipeline — means the call skipped the
  // harness chain and its audit line, so it is a driver error, never a pass.
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text) as unknown;
  } catch {
    throw new Error(
      `gateway case ${c.id} returned a non-JSON payload (bypassed the pipeline?): ${result.text.slice(0, 200)}`,
    );
  }
  return observedFromPayload(parsed, result.isError, 200);
}

/** Raw JSON-RPC probe asserting the HTTP 401 layer (no/bogus token). */
async function driveGatewayCaseHttp401(
  mcpUrl: string,
  c: GatewayCase,
  runId: string,
): Promise<GatewayObserved> {
  const tokenKind =
    "token" in c.auth && c.auth.token === "invalid"
      ? "bogus-eval-token"
      : undefined;
  const res = await withTimeout(
    fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-run-id": runId,
        ...(tokenKind === undefined
          ? {}
          : { authorization: `Bearer ${tokenKind}` }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: runId,
        method: "tools/call",
        params: { name: c.tool, arguments: c.params },
      }),
    }),
    GATEWAY_CASE_TIMEOUT_MS,
    `eval: gateway case ${c.id} timed out after ${GATEWAY_CASE_TIMEOUT_MS}ms`,
  );
  const bodyText = await res.text();
  let code: string | undefined;
  let message = bodyText.slice(0, 500);
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed["code"] === "string") {
      code = parsed["code"] as string;
      if (typeof parsed["message"] === "string") {
        message = (parsed["message"] as string).slice(0, 500);
      }
    }
  } catch {
    // Non-JSON 401 body: grade the raw text for secrets, fail on status.
  }
  return { ok: false, httpStatus: res.status, code, message };
}

const COUNT_TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function mcpCountRows(
  mcpUrl: string,
  token: string,
  role: string,
  runId: string,
  table: string,
): Promise<number> {
  const result = await callMcpTool(
    { mcpUrl, token, runId, userId: role, roleScope: role },
    "run_query",
    { sql: `SELECT COUNT(*) AS n FROM ${table}`, maxRows: 1 },
  );
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  const rows = parsed["rows"] as Array<Record<string, unknown>> | undefined;
  const n = parseCountValue(rows?.[0]?.["n"]);
  if (n === undefined) {
    throw new Error(`count probe on ${table} returned no numeric n`);
  }
  return n;
}

/**
 * Guard-off proof (D-03): NO server switch — the direct agent_ro probe lives
 * in packages/data (the pg exemption precedent) because bare "pg" does not
 * resolve from unscoped eval code under pnpm isolation. The role preflight
 * plus ROLLBACK-in-finally plus unchanged counts prove defense-in-depth.
 * Never run against owner/indexer URLs: role must read back agent_ro.
 */
async function driveGatewayCaseDirectPg(
  c: GatewayCase,
): Promise<GatewayObserved> {
  const url = process.env.AGENT_RO_DATABASE_URL ?? "";
  if (!url) {
    throw new Error(
      `eval: AGENT_RO_DATABASE_URL is not set for gateway case ${c.id}`,
    );
  }
  const table =
    typeof c.expect.rowCountUnchanged === "string"
      ? c.expect.rowCountUnchanged
      : "orders";
  const sql =
    typeof c.params["sql"] === "string" && c.params["sql"].length > 0
      ? (c.params["sql"] as string)
      : `DELETE FROM ${table} WHERE true`;
  const probe = await probeAgentRoWriteRefused(url, table, sql);
  return {
    ok: probe.code !== undefined && probe.rowCountBefore === probe.rowCountAfter,
    httpStatus: 0,
    code: probe.code,
    message: probe.message,
    rowCountBefore: probe.rowCountBefore,
    rowCountAfter: probe.rowCountAfter,
  };
}

const BAD_DSN_PORT = 18081;

/**
 * Error-leak probe (D-05): boot a SECOND gateway whose role URL carries a
 * wrong password, assert it exits non-zero without ever becoming healthy,
 * and return its output for the noSecretsInMessage grade. Fail-closed: a
 * busy probe port, a healthy boot, a child that neither exits nor serves,
 * a zero exit, or empty output is an infra error, never a pass.
 */
async function driveGatewayCaseBadDsn(
  repoRoot: string,
): Promise<GatewayObserved> {
  const url = process.env.AGENT_RO_DATABASE_URL ?? "";
  if (!url) {
    throw new Error("eval: AGENT_RO_DATABASE_URL is not set for bad-DSN probe");
  }
  // A listener already on the probe port would answer healthz and make the
  // probe misreport "healthy with a wrong password": refuse up front.
  if (await tcpReady("127.0.0.1", BAD_DSN_PORT, 500)) {
    throw new Error(
      `eval: bad-DSN probe port ${BAD_DSN_PORT} is already in use — free it, then re-run`,
    );
  }
  const bad = new URL(url);
  bad.password = "wrong-password";
  let child: ChildProcess | undefined;
  try {
    child = spawn("node", ["--import", "tsx", "packages/mcp-server/src/server.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MCP_PORT: String(BAD_DSN_PORT),
        AGENT_RO_DATABASE_URL: bad.toString(),
        // Same client set as the main eval gateway, so the boot fails on the
        // wrong password, not on token resolution.
        [EVAL_CLIENTS_ENV]: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      out += String(chunk);
    });
    const healthz = `http://127.0.0.1:${BAD_DSN_PORT}/healthz`;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      if (await httpOk(healthz)) {
        throw new Error(
          "eval: bad-DSN gateway became healthy with a wrong password — refusing to pass",
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(500);
    }
    const exitCode = child.exitCode;
    if (exitCode === null && child.signalCode === null) {
      throw new Error(
        "eval: bad-DSN gateway neither exited nor became healthy within 10s — probe inconclusive",
      );
    }
    if (exitCode === 0) {
      throw new Error(
        "eval: bad-DSN gateway exited 0 with a wrong password — refusing to pass",
      );
    }
    // Give the exited child's pipes a moment to flush their output.
    await sleep(500);
    const message = out.slice(-2000);
    if (message.trim() === "") {
      throw new Error(
        "eval: bad-DSN gateway produced no output — probe inconclusive",
      );
    }
    // The wrong password and the role name must never surface: the grader
    // checks these literals plus stack frames and absolute paths.
    const forbiddenLiterals = [bad.password, decodeURIComponent(bad.username)]
      .filter((literal) => literal !== "");
    return { ok: true, httpStatus: 0, message, forbiddenLiterals };
  } finally {
    child?.kill();
  }
}

/** Drive one gateway case on its declared leg (default mcp). */
async function driveGatewayCase(
  mcpUrl: string,
  c: GatewayCase,
  repoRoot: string,
): Promise<{ observed: GatewayObserved; runId: string; expectedAuditLines: number }> {
  const driver = c.driver ?? "mcp";
  const timeoutMs =
    typeof c.timeoutMs === "number" ? c.timeoutMs : GATEWAY_CASE_TIMEOUT_MS;
  const runId = randomUUID();
  const work = async (): Promise<{
    observed: GatewayObserved;
    runId: string;
    expectedAuditLines: number;
  }> => {
    if (driver === "http401") {
      return {
        observed: await driveGatewayCaseHttp401(mcpUrl, c, runId),
        runId,
        expectedAuditLines: 0,
      };
    }
    if (driver === "direct-pg") {
      return {
        observed: await driveGatewayCaseDirectPg(c),
        runId,
        expectedAuditLines: 0,
      };
    }
    if (driver === "bad-dsn-boot") {
      return {
        observed: await driveGatewayCaseBadDsn(repoRoot),
        runId,
        expectedAuditLines: 0,
      };
    }
    if (!("role" in c.auth) || typeof c.auth.role !== "string") {
      throw new Error(
        `gateway case ${c.id}: the mcp leg needs auth.role (token legs use driver http401)`,
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
    const countTable =
      typeof c.expect.rowCountUnchanged === "string"
        ? c.expect.rowCountUnchanged
        : undefined;
    if (countTable !== undefined && !COUNT_TABLE_PATTERN.test(countTable)) {
      throw new Error(`refusing to count untrusted table name '${countTable}'`);
    }
    let rowCountBefore: number | undefined;
    if (countTable !== undefined) {
      rowCountBefore = await withTimeout(
        mcpCountRows(mcpUrl, token, role, runId, countTable),
        timeoutMs,
        `eval: gateway case ${c.id} count-before timed out`,
      );
    }
    const observed = await driveGatewayCaseMcp(
      mcpUrl,
      c,
      runId,
      token,
      role,
      timeoutMs,
    );
    if (countTable !== undefined) {
      const rowCountAfter = await withTimeout(
        mcpCountRows(mcpUrl, token, role, runId, countTable),
        timeoutMs,
        `eval: gateway case ${c.id} count-after timed out`,
      );
      return {
        observed: { ...observed, rowCountBefore, rowCountAfter },
        runId,
        expectedAuditLines: 3,
      };
    }
    // One audit line per gateway request, denials included (UC09.md B.1).
    return { observed, runId, expectedAuditLines: 1 };
  };
  return withTimeout(
    work(),
    timeoutMs,
    `eval: gateway case ${c.id} timed out after ${timeoutMs}ms`,
  );
}

/** Drive every gateway case, grading each into the shared GradedCase shape. */
export async function driveGatewaySuite(
  mcpUrl: string,
  cases: GatewayCase[],
  repoRoot: string,
): Promise<GradedCase[]> {
  if (cases.some((c) => c.id === "uc09-audit")) {
    throw new Error("gateway fixture id 'uc09-audit' is reserved for the suite audit entry");
  }
  const auditPath = path.join(repoRoot, "logs", "mcp_audit.jsonl");
  const auditBefore = existsSync(auditPath)
    ? readFileSync(auditPath, "utf8")
    : "";
  const graded: GradedCase[] = [];
  const auditWanted: Array<{ runId: string; expectedLines: number }> = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const leg = await driveGatewayCase(mcpUrl, c, repoRoot);
      auditWanted.push({
        runId: leg.runId,
        expectedLines: leg.expectedAuditLines,
      });
      const grade = gradeGatewayCase(c, leg.observed);
      graded.push({
        id: c.id,
        status: leg.observed.ok ? "ok" : "error",
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
  // Suite-wide audit leg (B.1 Audit row): exactly one full redacted line
  // per gateway request, correlated by the per-case runIds.
  const newLines = auditTailLines(
    auditBefore,
    existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "",
  );
  const auditGrade = gradeAuditLines(
    newLines.filter((line) => line.trim() !== ""),
    auditWanted,
  );
  graded.push({
    id: "uc09-audit",
    status: auditGrade.pass ? "ok" : "error",
    exPass: auditGrade.pass,
    ms: 0,
    tokens: 0,
    note: auditGrade.reason,
  });
  return graded;
}

/** Merge EX results with gateway results under the constant version. */
export function mergeGatewayResults(
  exResults: EvalResultsFile,
  gatewayGraded: GradedCase[],
): EvalResultsFile {
  const merged = [...exResults.cases, ...gatewayGraded];
  return {
    datasetVersion: GATEWAY_DATASET_VERSION,
    cases: merged,
    summary: summarizeCases(merged),
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
        // Same drift guard as the EX-only path: the merged envelope swaps in
        // GATEWAY_DATASET_VERSION, so check the EX cases before that.
        if (cases.length > 0 && exResults.datasetVersion !== cases[0].datasetVersion) {
          throw new Error(`datasetVersion drift inside ${uc}`);
        }
        const gatewayGraded = await driveGatewaySuite(
          live.mcpUrl,
          gatewayCases,
          repoRoot,
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
      if ((s.mode ?? "scripted") === "answer") {
        const leg = await driveAnswerCase(live.adapter, s);
        safetyOut.push({
          id: s.id,
          attack: s.attack,
          mode: "answer",
          expectedBlockingLayer: s.expectedBlockingLayer,
          observedBlockingLayer: leg.observedBlockingLayer,
          expectBlocked: s.expectBlocked,
          blocked: leg.blocked,
          pass: leg.grade.pass,
          reason: leg.grade.reason,
          status: leg.status,
          skipped: leg.skipped,
          fix: s.fix,
          notes: s.notes,
        });
        console.log(
          `  safety ${s.id}: ${leg.skipped ? "SKIP (not_wired)" : leg.grade.pass ? "PASS" : "FAIL"} — ${leg.grade.reason} (expected ${s.expectedBlockingLayer})`,
        );
        continue;
      }
      const resubmit = s.id === "safety-05-resubmit";
      const first = await driveSafetyCase(live.mcpUrl, s, live.tracesDir);
      let observed = first.observedBlockingLayer;
      let pass: boolean;
      let reason: string;
      if (resubmit) {
        const second = await driveSafetyCase(live.mcpUrl, s, live.tracesDir);
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
    const failedSafety = safetyOut.filter(
      (s) => s["pass"] !== true && s["skipped"] !== true,
    );
    if (failedSafety.length > 0) failed = true;
    const passedCount = safetyOut.filter((s) => s["pass"] === true).length;
    const skippedCount = safetyOut.filter((s) => s["skipped"] === true).length;
    console.log(
      `eval safety: ${passedCount}/${safetyOut.length - skippedCount} cases pass` +
        (skippedCount > 0
          ? ` (${skippedCount} not_wired infra-skip, never a pass)`
          : "") +
        ` (scripted attacks through the real executor plus gateway, answers through the live graph; any miss fails the run)`,
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
