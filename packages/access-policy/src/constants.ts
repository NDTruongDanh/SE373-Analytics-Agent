import { fileURLToPath } from "node:url";
import type { SensitiveColumns } from "./sensitive-columns.js";

export const DEFAULT_SENSITIVE_COLUMNS: SensitiveColumns = {
  version: 1,
  columns: [
    { table: "customers", column: "name" },
    { table: "customers", column: "phone" },
    { table: "customers", column: "email" },
    { table: "customers", column: "address" },
    { table: "employees", column: "salary" },
  ],
};

// Resolved relative to this module (src and dist both sit two levels below repo root) so cwd does not matter.
export const DEFAULT_SENSITIVE_COLUMNS_PATH = fileURLToPath(
  new URL("../../../policies/sensitive_columns.yaml", import.meta.url),
);

export const MASKED_PHONE = "[MASKED_PHONE]";
export const MASKED_EMAIL = "[MASKED_EMAIL]";

// Deny-by-exception matched on the lowercased last segment of FuncCall.funcname
// (catches schema-qualified and mixed-case calls); unlisted functions are allowed.
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

// Explicit defense-in-depth deny so system schemas stay blocked even if a catalog mistakenly lists them.
export const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"] as const;

export const SYSTEM_SCHEMA_SET: ReadonlySet<string> = new Set(SYSTEM_SCHEMAS);
