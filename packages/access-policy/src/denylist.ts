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
// deny-by-exception, never an allowlist. (Canonical definitions live in
// ./constants.js; re-exported here for compat.)
import {
  FORBIDDEN_FUNCTIONS,
  FORBIDDEN_FUNCTION_SET,
  SYSTEM_SCHEMA_SET,
  SYSTEM_SCHEMAS,
} from "./constants.js";

export {
  FORBIDDEN_FUNCTIONS,
  FORBIDDEN_FUNCTION_SET,
  SYSTEM_SCHEMA_SET,
  SYSTEM_SCHEMAS,
};

export type ForbiddenFunction = (typeof FORBIDDEN_FUNCTIONS)[number];
