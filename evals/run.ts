// Eval CLI (EVAL-01, D-15): small tsx runner behind `pnpm eval`.
// Discovers evals/uc-*/ fixtures plus evals/safety fixtures, validates each
// case, runs every case through an injectable harness adapter, grades data
// cases with exGrader.ts, records safety cases by refusal outcome, and
// writes versioned JSON results. The default adapter is an explicit
// unwired-harness stub (exit code 2) — never a fake pass. The live harness
// behind the runner arrives in 01-14; until then CI tells not-wired (2)
// apart from graded failure (1).
//
// NOTE: validation here is a small structural checker, not zod: zod does
// not resolve from the repo root under pnpm isolation (only workspace
// packages declare it), and adding a root devDep would break this plan's
// zero-new-dependencies rule. The checker enforces the same required
// fields the finalized case schema mandates.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gradeExecution } from "./exGrader.js";
import { compareRuns, type EvalResultsFile } from "./regression.js";

export { gradeExecution } from "./exGrader.js";
export { compareRuns } from "./regression.js";

/** Exit code when the harness adapter is still the unwired default. */
export const STUB_EXIT_CODE = 2;

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

export interface SafetyRecord {
  id: string;
  attack: string;
  question: string;
  role: string;
  expectedBlockingLayer: string;
  notes: string;
}

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
    const { pass } = gradeExecution(
      { status: outcome.status, rows: outcome.rows ?? [], reason: outcome.reason },
      { rows: c.goldRows ?? [], ordered: c.ordered ?? false },
    );
    graded.push({
      id: c.id,
      status: outcome.status,
      exPass: pass,
      ms: outcome.ms,
      tokens: outcome.tokens,
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

function loadSafety(repoRoot: string): SafetyRecord[] {
  const file = path.join(repoRoot, "evals", "safety", "cases.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SafetyRecord);
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
  let unwired = false;
  let failed = false;

  for (const uc of ucs) {
    const cases = loadUcCases(repoRoot, uc);
    const results = await runEval(cases, stubAdapter);
    if (cases.length > 0 && results.datasetVersion !== cases[0].datasetVersion) {
      throw new Error(`datasetVersion drift inside ${uc}`);
    }
    writeFileSync(
      path.join(repoRoot, "results", `${uc}.json`),
      `${JSON.stringify({ uc, ...results }, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `eval ${uc}: ${results.summary.passed}/${results.summary.total} EX pass (dataset ${results.datasetVersion}, harness not wired)`,
    );
    unwired = true;
  }

  const safety = loadSafety(repoRoot);
  writeFileSync(
    path.join(repoRoot, "results", "safety.json"),
    `${JSON.stringify(
      {
        datasetVersion: "safety-1",
        cases: safety.map((s) => ({
          id: s.id,
          attack: s.attack,
          expectedBlockingLayer: s.expectedBlockingLayer,
          result: "not-executed",
          blockingLayer: null,
          notes: s.notes,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`eval safety: ${safety.length} attack cases recorded (not executed — live run belongs to 01-14)`);

  if (unwired) {
    console.log("eval harness not wired (stub adapter) — exiting 2");
    process.exit(STUB_EXIT_CODE);
  }
  process.exit(failed ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("evals/run.ts") || process.argv[1].endsWith("run.ts"));
if (invokedDirectly) {
  await main();
}
