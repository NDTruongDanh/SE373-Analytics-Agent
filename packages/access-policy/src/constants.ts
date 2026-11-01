// Central magic values for @shared/access-policy (UC-01 root governance).
// Single source of truth for sensitive-column defaults, redaction sentinels,
// and SQL-guard deny sets. The original modules re-export these for compat
// so external importers keep working.
import { fileURLToPath } from "node:url";
import type { SensitiveColumns } from "./sensitive-columns.js";

// Default sensitive set: the v1 reference set (customers contact fields plus
// the employees compensation field), with exact table/column names matching
// the 01-04 catalog once merged. Used by ColumnScopePolicy when no explicit
// list is passed; the yaml FILE itself lands in 01-08
// (policies/sensitive_columns.yaml) — never created here.
export const DEFAULT_SENSITIVE_COLUMNS: SensitiveColumns = {
  version: 1,
  columns: [
    { table: "customers", column: "phone" },
    { table: "customers", column: "email" },
    { table: "customers", column: "address" },
    { table: "employees", column: "salary" },
  ],
};

// Repo-root policies file, resolved from this module's location so the
// default works regardless of the caller's cwd (src and dist layouts both
// sit two levels below the repo root).
export const DEFAULT_SENSITIVE_COLUMNS_PATH = fileURLToPath(
  new URL("../../../policies/sensitive_columns.yaml", import.meta.url),
);

// Shared PII redactor sentinels: patterns are locked to the gateway-research
// §4 set, derived from the Faker `vi` phone formats. No DB or network I/O.
export const MASKED_PHONE = "[MASKED_PHONE]";
export const MASKED_EMAIL = "[MASKED_EMAIL]";

// Frozen deny sets for the SQL guard (harness core, D-01 purity: no DB
// imports here). Ported verbatim from the archived Phase 3 reference
// (origin/feat/phase-3-sql-guard, read via git show, never merged — D-06).
// Function names are matched on the lowercased LAST segment of
// FuncCall.funcname, so schema-qualified calls (pg_catalog.pg_sleep) and any
// casing (PG_SLEEP) are caught by the same entry.
//
// Explicit ALLOW posture: everything NOT in the denylist passes the function
// check — current_setting, current_user, version, aggregates, window, math,
// string and date functions are all allowed by default. The denylist is
// deny-by-exception, never an allowlist.
export const FORBIDDEN_FUNCTIONS = [
  "pg_sleep",
  "pg_read_file",
  "pg_ls_dir",
  "pg_logdir_ls",
  "dblink",
  "dblink_exec",
  "lo_import",
  "lo_export",
  "lo_unlink",
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_execute_server_program",
  "nextval",
  "setval",
  "currval",
] as const;

export const FORBIDDEN_FUNCTION_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_FUNCTIONS,
);

// System schemas are denied defense-in-depth (UC-09 F7): the catalog
// whitelist would miss them anyway when the fixture only lists business
// tables, but the explicit deny gives a clearer error and stays fail-closed
// if a future catalog ever lists them by mistake.
export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"] as const;

export const SYSTEM_SCHEMA_SET: ReadonlySet<string> = new Set(SYSTEM_SCHEMAS);
