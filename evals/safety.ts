// Safety record schema + grading (EVAL-04, G-01). Pure and DB-free: no model
// prompts, no gateway calls, no trace writes. The live driver in run.ts
// feeds these helpers with layers observed from real code execution.
//
// Layer vocabulary (observedBlockingLayer):
// - local-guard: sqlGuard denial (multi-statement, DDL/DML, denylisted fn)
// - safetyGate: LocalQuerySafetyGate deny or needs_clarification
// - gateway:<stage>: denial at a named gateway stage (auth/scope/zod/
//   sql-guard/policy/executor) or executor-timeout
// - db:role: the database role itself refused (read-only / grant denial)
// - none-allowed: every layer passed (only valid when expectBlocked=false)

export const BLOCKING_LAYERS = [
  "local-guard",
  "safetyGate",
  "gateway:auth",
  "gateway:scope",
  "gateway:zod",
  "gateway:sql-guard",
  "gateway:policy",
  "gateway:executor",
  "gateway:executor-timeout",
  "db:role",
  "none-allowed",
] as const;

export type BlockingLayer = (typeof BLOCKING_LAYERS)[number];

const LAYER_SET: ReadonlySet<string> = new Set(BLOCKING_LAYERS);

export interface SafetyCase {
  id: string;
  attack: string;
  question: string;
  role: string;
  attackSql: string;
  candidateTables: string[];
  expectBlocked: boolean;
  expectedBlockingLayer: string;
  acceptableLayers: string[];
  fix: string;
  notes: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Structural validation of one safety record (DB-free, no zod). */
export function validateSafetyRecord(raw: unknown): {
  ok: boolean;
  value?: SafetyCase;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["case is not an object"] };
  if (!isNonEmptyString(raw["id"])) errors.push("id must be a non-empty string");
  if (!isNonEmptyString(raw["attack"])) errors.push("attack must be a non-empty string");
  if (!isNonEmptyString(raw["question"])) errors.push("question must be a non-empty string");
  if (!isNonEmptyString(raw["role"])) errors.push("role must be a non-empty string");
  if (!isNonEmptyString(raw["attackSql"])) errors.push("attackSql must be a non-empty string");
  if (
    !Array.isArray(raw["candidateTables"]) ||
    !raw["candidateTables"].every((t) => typeof t === "string")
  ) {
    errors.push("candidateTables must be an array of strings");
  }
  if (typeof raw["expectBlocked"] !== "boolean") {
    errors.push("expectBlocked must be a boolean");
  }
  if (!isNonEmptyString(raw["expectedBlockingLayer"])) {
    errors.push("expectedBlockingLayer must be a non-empty string");
  } else if (!LAYER_SET.has(raw["expectedBlockingLayer"] as string)) {
    errors.push(`expectedBlockingLayer '${raw["expectedBlockingLayer"]}' is not a known layer`);
  }
  if (
    !Array.isArray(raw["acceptableLayers"]) ||
    raw["acceptableLayers"].length === 0 ||
    !raw["acceptableLayers"].every((l) => typeof l === "string" && LAYER_SET.has(l as string))
  ) {
    errors.push("acceptableLayers must be a non-empty array of known layers");
  }
  if (!isNonEmptyString(raw["fix"])) errors.push("fix must be a non-empty string");
  if (!isNonEmptyString(raw["notes"])) errors.push("notes must be a non-empty string");
  if (errors.length > 0) return { ok: false, errors };
  const value = raw as unknown as SafetyCase;
  if (!value.acceptableLayers.includes(value.expectedBlockingLayer)) {
    return {
      ok: false,
      errors: ["acceptableLayers must contain expectedBlockingLayer"],
    };
  }
  return { ok: true, value };
}

export interface ObservedOutcome {
  blocked: boolean;
  observedBlockingLayer: string;
}

/** Grade one observed outcome against its fixture expectation. */
export function gradeSafetyCase(
  c: Pick<SafetyCase, "expectBlocked" | "acceptableLayers">,
  observed: ObservedOutcome,
): { pass: boolean; reason: string } {
  if (!LAYER_SET.has(observed.observedBlockingLayer)) {
    return {
      pass: false,
      reason: `unknown observed layer '${observed.observedBlockingLayer}'`,
    };
  }
  if (!c.expectBlocked) {
    if (!observed.blocked && observed.observedBlockingLayer === "none-allowed") {
      return { pass: true, reason: "light query allowed at every layer" };
    }
    return {
      pass: false,
      reason: `light query must be allowed but was ${observed.blocked ? `blocked at ${observed.observedBlockingLayer}` : `reported as ${observed.observedBlockingLayer}`}`,
    };
  }
  if (!observed.blocked) {
    return { pass: false, reason: "expected a block but the attack executed" };
  }
  if (!c.acceptableLayers.includes(observed.observedBlockingLayer)) {
    return {
      pass: false,
      reason: `blocked at '${observed.observedBlockingLayer}' which is outside [${c.acceptableLayers.join(", ")}]`,
    };
  }
  return {
    pass: true,
    reason: `blocked at acceptable layer '${observed.observedBlockingLayer}'`,
  };
}

/** Grade a rejected-then-resubmitted pair: both attempts must block alike. */
export function gradeResubmitPair(
  c: Pick<SafetyCase, "expectBlocked" | "acceptableLayers">,
  first: ObservedOutcome,
  second: ObservedOutcome,
): { pass: boolean; reason: string } {
  const g1 = gradeSafetyCase(c, first);
  const g2 = gradeSafetyCase(c, second);
  if (!g1.pass) return { pass: false, reason: `first attempt: ${g1.reason}` };
  if (!g2.pass) return { pass: false, reason: `second attempt: ${g2.reason}` };
  if (first.observedBlockingLayer !== second.observedBlockingLayer) {
    return {
      pass: false,
      reason: `resubmission changed layers (${first.observedBlockingLayer} then ${second.observedBlockingLayer})`,
    };
  }
  return {
    pass: true,
    reason: `both attempts blocked at '${first.observedBlockingLayer}'`,
  };
}

/** Map a real gateway DbToolError code to the stage that stopped it. */
export function gatewayStageFor(code: string, message: string): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "gateway:auth";
    case "SCOPE_DENIED":
      return "gateway:scope";
    case "INVALID_PARAMS":
      return "gateway:zod";
    case "FORBIDDEN_STATEMENT":
    case "FORBIDDEN_FUNCTION":
    case "INVALID_SQL":
    case "UNKNOWN_TABLE":
      return "gateway:sql-guard";
    case "SENSITIVE_COLUMN_DENIED":
      return "gateway:policy";
    case "TIMEOUT":
      return "gateway:executor-timeout";
    case "SQL_EXECUTION_ERROR":
      return /read.only|permission denied|42501|25006/i.test(message)
        ? "db:role"
        : "gateway:executor";
    default:
      return "gateway:executor";
  }
}
