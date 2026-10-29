// Gateway case schema + grading (issue #39, D-01/D-02). Pure and DB-free:
// no gateway calls, no model, no disk. The direct-MCP driver in run.ts
// feeds these helpers with observed gateway payloads. Validation is strict:
// unknown expect keys are rejected, and every expect key is graded
// independently so one typo can never silently pass.
// NOTE: runtime imports below are relative, not bare workspace
// specifiers. evals/ sits outside every package, and the repo root does
// not resolve @shared/contracts under pnpm isolation (only workspace
// packages declare it) — the same reason evals/run.ts imports
// ../packages/agent/src/mcpClient.js relatively. Type-only workspace
// imports are fine (erased at compile time); value imports must be
// relative so both vitest and tsx resolve them.
import {
  DescribeTableOutputSchema,
  ExplainQueryOutputSchema,
  ListTablesOutputSchema,
  RunQueryOutputSchema,
  SampleRowsOutputSchema,
} from "../packages/contracts/src/tools.js";
import {
  ErrorCodes,
  type ErrorCode,
} from "../packages/contracts/src/errors.js";
import { redactPII } from "../packages/access-policy/src/redactor.js";

export const GATEWAY_TOOLS = [
  "list_tables",
  "describe_table",
  "explain_query",
  "run_query",
  "sample_rows",
] as const;

export type GatewayTool = (typeof GATEWAY_TOOLS)[number];

const TOOL_SET: ReadonlySet<string> = new Set(GATEWAY_TOOLS);

export const GATEWAY_EXPECT_KEYS = [
  "errorCode",
  "errorCodeAnyOf",
  "httpStatus",
  "ok",
  "truncated",
  "maskedColumns",
  "maskedColumnsExact",
  "rawValuesVisible",
  "valuesMasked",
  "noSecretsInMessage",
  "rowCountUnchanged",
  "outputSchemaValid",
  "denyOrMask",
  "pgDenyCodes",
] as const;

const EXPECT_KEY_SET: ReadonlySet<string> = new Set(GATEWAY_EXPECT_KEYS);

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ErrorCodes);

/** Drivers: mcp (callMcpTool) plus the Task-3 special legs. */
export const GATEWAY_DRIVERS = ["mcp", "http401", "direct-pg", "bad-dsn-boot"] as const;

export type GatewayDriver = (typeof GATEWAY_DRIVERS)[number];

const DRIVER_SET: ReadonlySet<string> = new Set(GATEWAY_DRIVERS);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "group",
  "tool",
  "params",
  "auth",
  "expect",
  "notes",
  "driver",
  "timeoutMs",
  "tags",
]);

export interface GatewayAuth {
  role?: string;
  token?: string;
}

/**
 * denyOrMask: the CTE-rename accept-set (research open question 1). The
 * static derivation says re-guard fails closed but the exact code is not
 * live-proven, so EITHER a denial with a code in `codes` OR an ok result
 * with `maskedColumn` in maskedColumns passes. The live plan pins the exact
 * code after the first probe; until then no single unproven code is locked.
 */
export interface DenyOrMask {
  codes: ErrorCode[];
  maskedColumn: string;
}

export interface GatewayExpect {
  errorCode?: ErrorCode;
  errorCodeAnyOf?: ErrorCode[];
  httpStatus?: number;
  ok?: boolean;
  truncated?: boolean;
  maskedColumns?: string[];
  maskedColumnsExact?: string[];
  rawValuesVisible?: string[];
  valuesMasked?: string[];
  noSecretsInMessage?: boolean;
  /**
   * true: driver fills before/after counts and the grader asserts equality.
   * "table": same, counting that table (DELETE probes, direct-pg guard-off).
   */
  rowCountUnchanged?: boolean | string;
  outputSchemaValid?: boolean;
  denyOrMask?: DenyOrMask;
  /** Direct-pg SQLSTATE accept-set (guard-off proof: 25006 or 42501). */
  pgDenyCodes?: string[];
}

export interface GatewayCase {
  id: string;
  group: string;
  tool: GatewayTool;
  params: Record<string, unknown>;
  auth: GatewayAuth;
  expect: GatewayExpect;
  notes: string;
  driver?: GatewayDriver;
  timeoutMs?: number;
  tags?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

/** Structural validation of one gateway record (DB-free, no zod). */
export function validateGatewayRecord(raw: unknown): {
  ok: boolean;
  value?: GatewayCase;
  errors?: string[];
} {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["case is not an object"] };
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`unknown top-level key '${key}'`);
    }
  }
  if (!isNonEmptyString(raw["id"])) errors.push("id must be a non-empty string");
  if (!isNonEmptyString(raw["group"])) {
    errors.push("group must be a non-empty string");
  }
  if (typeof raw["tool"] !== "string" || !TOOL_SET.has(raw["tool"])) {
    errors.push(`tool must be one of [${GATEWAY_TOOLS.join(", ")}]`);
  }
  if (!isRecord(raw["params"])) errors.push("params must be a record");
  const auth = raw["auth"];
  if (!isRecord(auth)) {
    errors.push("auth must be a record");
  } else {
    const keys = Object.keys(auth);
    if (keys.length === 1 && keys[0] === "role") {
      if (!isNonEmptyString(auth["role"])) {
        errors.push("auth.role must be a non-empty string");
      }
    } else if (keys.length === 1 && keys[0] === "token") {
      if (auth["token"] !== "missing" && auth["token"] !== "invalid") {
        errors.push('auth.token must be "missing" or "invalid"');
      }
    } else {
      errors.push("auth must be exactly one of { role } or { token }");
    }
  }
  const expect = raw["expect"];
  if (!isRecord(expect)) {
    errors.push("expect must be a record");
  } else {
    for (const key of Object.keys(expect)) {
      if (!EXPECT_KEY_SET.has(key)) {
        errors.push(`unknown expect key '${key}'`);
      }
    }
    if (Object.keys(expect).length === 0) {
      errors.push("expect must assert at least one key");
    }
    if (expect["errorCode"] !== undefined) {
      if (
        typeof expect["errorCode"] !== "string" ||
        !ERROR_CODE_SET.has(expect["errorCode"])
      ) {
        errors.push(
          `expect.errorCode must be one of [${ErrorCodes.join(", ")}]`,
        );
      }
    }
    if (expect["httpStatus"] !== undefined) {
      if (
        typeof expect["httpStatus"] !== "number" ||
        !Number.isInteger(expect["httpStatus"]) ||
        expect["httpStatus"] < 100 ||
        expect["httpStatus"] >= 600
      ) {
        errors.push("expect.httpStatus must be an integer HTTP status");
      }
    }
    for (const key of [
      "ok",
      "truncated",
      "noSecretsInMessage",
      "outputSchemaValid",
    ] as const) {
      if (expect[key] !== undefined && typeof expect[key] !== "boolean") {
        errors.push(`expect.${key} must be a boolean`);
      }
    }
    if (
      expect["rowCountUnchanged"] !== undefined &&
      typeof expect["rowCountUnchanged"] !== "boolean" &&
      !isNonEmptyString(expect["rowCountUnchanged"])
    ) {
      errors.push(
        "expect.rowCountUnchanged must be a boolean or a table name",
      );
    }
    for (const key of [
      "maskedColumns",
      "maskedColumnsExact",
      "rawValuesVisible",
      "valuesMasked",
      "pgDenyCodes",
    ] as const) {
      if (expect[key] !== undefined && !isStringArray(expect[key])) {
        errors.push(`expect.${key} must be an array of non-empty strings`);
      }
    }
    if (
      expect["pgDenyCodes"] !== undefined &&
      (expect["pgDenyCodes"] as string[]).length === 0
    ) {
      errors.push("expect.pgDenyCodes must not be empty");
    }
    if (expect["errorCodeAnyOf"] !== undefined) {
      if (
        !isStringArray(expect["errorCodeAnyOf"]) ||
        (expect["errorCodeAnyOf"] as string[]).length === 0 ||
        !(expect["errorCodeAnyOf"] as string[]).every((code) =>
          ERROR_CODE_SET.has(code),
        )
      ) {
        errors.push(
          `expect.errorCodeAnyOf must be a non-empty array of [${ErrorCodes.join(", ")}]`,
        );
      }
    }
    if (expect["denyOrMask"] !== undefined) {
      const denyOrMask = expect["denyOrMask"];
      if (
        !isRecord(denyOrMask) ||
        !isStringArray(denyOrMask["codes"]) ||
        !(denyOrMask["codes"] as string[]).every((code) =>
          ERROR_CODE_SET.has(code),
        ) ||
        !isNonEmptyString(denyOrMask["maskedColumn"])
      ) {
        errors.push(
          "expect.denyOrMask must be { codes: ErrorCode[], maskedColumn: string }",
        );
      }
    }
  }
  if (raw["driver"] !== undefined) {
    if (typeof raw["driver"] !== "string" || !DRIVER_SET.has(raw["driver"])) {
      errors.push(`driver must be one of [${GATEWAY_DRIVERS.join(", ")}]`);
    }
  }
  if (raw["timeoutMs"] !== undefined) {
    if (
      typeof raw["timeoutMs"] !== "number" ||
      !Number.isInteger(raw["timeoutMs"]) ||
      (raw["timeoutMs"] as number) <= 0
    ) {
      errors.push("timeoutMs must be a positive integer");
    }
  }
  if (raw["tags"] !== undefined) {
    if (!isStringArray(raw["tags"])) {
      errors.push("tags must be an array of non-empty strings");
    }
  }
  if (!isNonEmptyString(raw["notes"])) {
    errors.push("notes must be a non-empty string citing the UC09.md B.1 row");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as GatewayCase };
}

export interface GatewayObserved {
  ok: boolean;
  httpStatus: number;
  code?: string;
  message?: string;
  isError?: boolean;
  truncated?: boolean;
  maskedColumns?: string[];
  rows?: Record<string, unknown>[];
  data?: unknown;
  rowCountBefore?: number;
  rowCountAfter?: number;
}

// postgres://user:pass@host:port/db — kills credentials, host, port, dbname.
// The (?!<redacted>) lookaheads exempt the sanitizer's own placeholders:
// `postgres://<redacted>` and `user "<redacted>"` are the PROOF of
// redaction, not a leak, and the grader must agree with the server's
// redaction contract (errors.test.ts locks those outputs).
const DSN_PATTERN = /postgres(ql)?:\/\/(?!<redacted>)[^\s"'`]+/gi;
// host= fragments in connection errors.
const HOST_ASSIGN_PATTERN = /host\s*=\s*(?!<redacted>)[^\s;,]+/gi;
// Bare IPv4 literals.
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// `for user "…"` — never echo which credential failed. The lookahead
// exempts the sanitized `user "<redacted>"` residue.
const USER_PATTERN = /\buser\s+"(?!<redacted>)[^"]+"/gi;

/**
 * Shared secret-shape assertion (mirrors the sanitizeError choke-point plus
 * the access-policy PII redactor). Never echoes the message itself — reasons
 * name only the shape that fired.
 */
export function assertNoSecretsInMessage(message: string): {
  pass: boolean;
  reason: string;
} {
  // Global-flag regexes keep lastIndex state: reset before every test so
  // repeated calls start from zero regardless of earlier matches.
  const shapes: Array<[RegExp, string]> = [
    [DSN_PATTERN, "message contains a postgres DSN"],
    [HOST_ASSIGN_PATTERN, "message contains a host assignment"],
    [IPV4_PATTERN, "message contains a bare IPv4 literal"],
    [USER_PATTERN, "message quotes a database user name"],
  ];
  for (const [pattern, reason] of shapes) {
    pattern.lastIndex = 0;
    if (pattern.test(message)) {
      pattern.lastIndex = 0;
      return { pass: false, reason };
    }
  }
  if (redactPII(message).hit) {
    return { pass: false, reason: "message contains raw phone or email PII" };
  }
  return { pass: true, reason: "message carries no secret shapes" };
}

const OUTPUT_SCHEMAS: Record<
  GatewayTool,
  { safeParse(d: unknown): { success: boolean } }
> = {
  list_tables: ListTablesOutputSchema,
  describe_table: DescribeTableOutputSchema,
  explain_query: ExplainQueryOutputSchema,
  run_query: RunQueryOutputSchema,
  sample_rows: SampleRowsOutputSchema,
};

function cellMaskedShape(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.includes("****") || text.includes("[MASKED");
}

/** Grade one observed outcome against its fixture expectation. */
export function gradeGatewayCase(
  c: Pick<GatewayCase, "tool" | "expect">,
  observed: GatewayObserved,
): { pass: boolean; reason: string } {
  const failures: string[] = [];
  const expect = c.expect;

  if (expect.errorCode !== undefined) {
    if (observed.code !== expect.errorCode) {
      failures.push(
        `errorCode '${observed.code ?? "none"}' is not '${expect.errorCode}'`,
      );
    } else if (observed.isError === false) {
      failures.push("denial arrived as data (isError false), not a tool error");
    }
  }
  if (expect.errorCodeAnyOf !== undefined) {
    if (
      observed.code === undefined ||
      !expect.errorCodeAnyOf.includes(observed.code as ErrorCode)
    ) {
      failures.push(
        `errorCode '${observed.code ?? "none"}' is not in [${expect.errorCodeAnyOf.join(", ")}]`,
      );
    } else if (observed.isError === false) {
      failures.push("denial arrived as data (isError false), not a tool error");
    }
  }
  if (
    expect.httpStatus !== undefined &&
    observed.httpStatus !== expect.httpStatus
  ) {
    failures.push(
      `httpStatus ${observed.httpStatus} is not ${expect.httpStatus}`,
    );
  }
  if (expect.ok !== undefined && observed.ok !== expect.ok) {
    failures.push(`ok is ${observed.ok}, expected ${expect.ok}`);
  }
  if (expect.truncated !== undefined) {
    if (typeof observed.truncated !== "boolean") {
      failures.push("no truncated flag observed on a run_query result");
    } else if (observed.truncated !== expect.truncated) {
      failures.push(
        `truncated is ${observed.truncated}, expected ${expect.truncated}`,
      );
    }
  }
  if (expect.maskedColumns !== undefined) {
    const seen = new Set(observed.maskedColumns ?? []);
    const missing = expect.maskedColumns.filter((col) => !seen.has(col));
    if (missing.length > 0) {
      failures.push(`maskedColumns misses [${missing.join(", ")}]`);
    }
  }
  if (expect.maskedColumnsExact !== undefined) {
    const seen = [...(observed.maskedColumns ?? [])].sort();
    const wanted = [...expect.maskedColumnsExact].sort();
    if (JSON.stringify(seen) !== JSON.stringify(wanted)) {
      failures.push(
        `maskedColumns [${seen.join(", ")}] is not exactly [${wanted.join(", ")}]`,
      );
    }
  }
  if (expect.rawValuesVisible !== undefined) {
    if (!Array.isArray(observed.rows) || observed.rows.length === 0) {
      failures.push("rawValuesVisible needs at least one result row");
    } else {
      for (const col of expect.rawValuesVisible) {
        const visible = observed.rows.some(
          (row) =>
            row[col] !== null &&
            row[col] !== undefined &&
            !cellMaskedShape(row[col]),
        );
        if (!visible) {
          failures.push(`column '${col}' has no visible raw value`);
        }
      }
    }
  }
  if (expect.valuesMasked !== undefined) {
    if (!Array.isArray(observed.rows) || observed.rows.length === 0) {
      failures.push("valuesMasked needs at least one result row");
    } else {
      for (const col of expect.valuesMasked) {
        const leaked = observed.rows.some(
          (row) =>
            row[col] !== null &&
            row[col] !== undefined &&
            redactPII(
              typeof row[col] === "string"
                ? (row[col] as string)
                : JSON.stringify(row[col]),
            ).hit,
        );
        if (leaked) {
          failures.push(`column '${col}' leaks raw phone or email PII`);
        }
      }
    }
  }
  if (expect.noSecretsInMessage === true) {
    const checked = assertNoSecretsInMessage(observed.message ?? "");
    if (!checked.pass) failures.push(checked.reason);
  }
  if (expect.rowCountUnchanged !== undefined) {
    if (
      typeof observed.rowCountBefore !== "number" ||
      typeof observed.rowCountAfter !== "number"
    ) {
      failures.push("rowCountUnchanged needs before/after counts");
    } else if (observed.rowCountBefore !== observed.rowCountAfter) {
      failures.push(
        `row count changed ${observed.rowCountBefore} -> ${observed.rowCountAfter}`,
      );
    }
  }
  if (expect.denyOrMask !== undefined) {
    if (observed.ok) {
      const seen = new Set(observed.maskedColumns ?? []);
      if (!seen.has(expect.denyOrMask.maskedColumn)) {
        failures.push(
          `allowed result does not mask '${expect.denyOrMask.maskedColumn}'`,
        );
      }
    } else if (
      observed.code === undefined ||
      !expect.denyOrMask.codes.includes(observed.code as ErrorCode)
    ) {
      failures.push(
        `denial code '${observed.code ?? "none"}' is not in [${expect.denyOrMask.codes.join(", ")}] and '${expect.denyOrMask.maskedColumn}' is not masked`,
      );
    } else if (observed.isError === false) {
      failures.push("denial arrived as data (isError false), not a tool error");
    }
  }
  if (expect.pgDenyCodes !== undefined) {
    if (
      observed.code === undefined ||
      !expect.pgDenyCodes.includes(observed.code)
    ) {
      failures.push(
        `pg denial code '${observed.code ?? "none"}' is not in [${expect.pgDenyCodes.join(", ")}]`,
      );
    }
  }
  if (expect.outputSchemaValid === true) {
    if (observed.data === undefined) {
      failures.push("outputSchemaValid needs the observed tool payload");
    } else if (!OUTPUT_SCHEMAS[c.tool].safeParse(observed.data).success) {
      failures.push(`${c.tool} payload fails its output schema`);
    }
  }

  if (failures.length > 0) {
    return { pass: false, reason: failures.join("; ") };
  }
  const asserted = Object.keys(expect).length;
  return { pass: true, reason: `${asserted} expectation(s) hold` };
}

export interface AuditExpectation {
  runId: string;
  expectedLines: number;
}

/**
 * Grade the audit tail for one gateway suite: every expected runId must
 * own exactly its call count of lines, every attributed line must carry
 * the full AuditRecord fields, and no attributed line may carry secret
 * shapes. Lines from unattributed runIds (concurrent dev activity in the
 * shared file) are ignored, never graded.
 */
export function gradeAuditLines(
  newLines: string[],
  perCase: AuditExpectation[],
): { pass: boolean; reason: string } {
  const failures: string[] = [];
  const byRunId = new Map<string, Record<string, unknown>[]>();
  newLines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      failures.push(`audit line ${index} is not JSON`);
      return;
    }
    if (!isRecord(parsed)) {
      failures.push(`audit line ${index} is not an object`);
      return;
    }
    if (typeof parsed["runId"] !== "string") {
      failures.push(`audit line ${index} has no runId`);
      return;
    }
    const bucket = byRunId.get(parsed["runId"] as string) ?? [];
    bucket.push(parsed);
    byRunId.set(parsed["runId"] as string, bucket);
  });

  const wanted = new Map(perCase.map((c) => [c.runId, c.expectedLines]));
  for (const [runId, expectedLines] of wanted) {
    const lines = byRunId.get(runId) ?? [];
    if (lines.length !== expectedLines) {
      failures.push(
        `runId owns ${lines.length} audit line(s), expected ${expectedLines}`,
      );
      continue;
    }
    lines.forEach((record, lineIndex) => {
      for (const field of [
        "ts",
        "runId",
        "userId",
        "role",
        "clientId",
        "tool",
        "params",
        "decision",
      ] as const) {
        if (
          record[field] === undefined ||
          record[field] === null ||
          record[field] === ""
        ) {
          failures.push(
            `audit line ${lineIndex} for a suite case misses '${field}'`,
          );
        }
      }
      if (!Array.isArray(record["scopes"])) {
        failures.push(`audit line ${lineIndex} for a suite case misses scopes`);
      }
      if (
        typeof record["rowCount"] !== "number" ||
        typeof record["durationMs"] !== "number" ||
        typeof record["piiHits"] !== "number"
      ) {
        failures.push(
          `audit line ${lineIndex} for a suite case has non-numeric counters`,
        );
      }
      if (record["decision"] !== "allow" && record["decision"] !== "deny") {
        failures.push(
          `audit line ${lineIndex} for a suite case has decision '${String(record["decision"])}'`,
        );
      }
      if (
        record["decision"] === "deny" &&
        !isNonEmptyString(record["errorCode"])
      ) {
        failures.push(
          `audit line ${lineIndex} for a suite case denies without errorCode`,
        );
      }
    });
  }

  for (const [runId, lines] of byRunId) {
    if (!wanted.has(runId)) continue;
    lines.forEach((record, lineIndex) => {
      const secret = assertNoSecretsInMessage(JSON.stringify(record));
      if (!secret.pass) {
        failures.push(`audit line ${lineIndex} for a suite case: ${secret.reason}`);
      }
    });
  }

  if (failures.length > 0) {
    return { pass: false, reason: failures.join("; ") };
  }
  return {
    pass: true,
    reason: `${perCase.length} case(s) own exactly their audit line(s)`,
  };
}
