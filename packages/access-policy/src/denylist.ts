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

export type ForbiddenFunction = (typeof FORBIDDEN_FUNCTIONS)[number];

export const FORBIDDEN_FUNCTION_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_FUNCTIONS,
);

// System schemas are denied defense-in-depth (UC-09 F7): the catalog
// whitelist would miss them anyway when the fixture only lists business
// tables, but the explicit deny gives a clearer error and stays fail-closed
// if a future catalog ever lists them by mistake.
export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"] as const;

export const SYSTEM_SCHEMA_SET: ReadonlySet<string> = new Set(SYSTEM_SCHEMAS);
