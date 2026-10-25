// Phase 3 AccessPolicy seam (GUARD-06, D-02): interface plus pass-through
// ColumnScopePolicy stub. Full masking is deferred to UC09-01 (UC-09 milestone).

// A single column reference as the future server pipeline will pass it:
// guard output (tables/columns) intersected with the validated YAML config.
export interface PolicyColumnRef {
  table: string;
  column: string;
}

// Input the Phase 4 server pipeline (guard -> policy -> executor) passes to
// the policy. The stub ignores everything except the contract shape so UC-09
// can extend apply() without changing the server call site.
export interface PolicyInput {
  sql: string;
  tables: string[];
  columns: PolicyColumnRef[];
}

// The stub only ever allows. A future enforcing policy may return a denial,
// but that shape is UC09-01 scope and deliberately absent here.
export interface PolicyAllow {
  allowed: true;
  maskedColumns: string[];
}

// Plug-in point for UC-08/UC-09: pure function of AST-derived refs plus the
// validated YAML config. No DB or filesystem access inside the guard path.
export interface AccessPolicy {
  readonly name: string;
  // False for every Phase 3 implementation: apply() claims no enforcement.
  readonly enforcesMasking: boolean;
  apply(input: PolicyInput): PolicyAllow;
}

// Structural shape of the validated sensitive-columns config (mirrors
// SensitiveColumnsSchema in ./sensitive-columns.js). Defined structurally
// here so the seam has no loader dependency: the constructor re-validates
// defensively (fail-fast) even when callers bypass the zod loader.
export interface ColumnScopeConfig {
  version: 1;
  columns: PolicyColumnRef[];
}

export const COLUMN_SCOPE_POLICY_STUB_NOTICE =
  "ColumnScopePolicy is a Phase 3 pass-through stub: apply() always allows with maskedColumns: []; full masking lands in UC09-01.";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertValidConfig(config: unknown): asserts config is ColumnScopeConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("ColumnScopePolicy: config must be an object");
  }
  const candidate = config as Record<string, unknown>;
  if (candidate["version"] !== 1) {
    throw new Error("ColumnScopePolicy: config.version must be 1");
  }
  if (!Array.isArray(candidate["columns"])) {
    throw new Error("ColumnScopePolicy: config.columns must be an array");
  }
  for (const entry of candidate["columns"]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !isNonEmptyString((entry as Record<string, unknown>)["table"]) ||
      !isNonEmptyString((entry as Record<string, unknown>)["column"])
    ) {
      throw new Error(
        "ColumnScopePolicy: every config.columns entry must have non-empty string table and column",
      );
    }
  }
}

export class ColumnScopePolicy implements AccessPolicy {
  readonly name = "ColumnScopePolicy/stub";
  readonly enforcesMasking = false as const;
  private readonly config: ColumnScopeConfig;

  constructor(config: unknown) {
    // Fail-fast per UC-09 A.8: invalid config throws at construction instead
    // of loading silent defaults. Fail-closed by construction: an unusable
    // policy can never be built, so the server can never run under one.
    assertValidConfig(config);
    this.config = {
      version: 1,
      columns: config.columns.map((entry) => ({
        table: entry.table,
        column: entry.column,
      })),
    };
    Object.freeze(this.config.columns);
    Object.freeze(this.config);
  }

  get columnCount(): number {
    return this.config.columns.length;
  }

  apply(): PolicyAllow {
    // Explicit pass-through: no masking, no denial. Claiming anything more
    // would lie to the pipeline, so the stub shape has no deny branch.
    // (No input parameter: the stub ignores the query refs by design; the
    // AccessPolicy interface documents the shape UC09-01 will consume.)
    return { allowed: true, maskedColumns: [] };
  }
}
