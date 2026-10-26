# @se373/contracts

Shared zod schemas (v4) for the SE373 Analytics Agent harness. Every package
imports these types — nothing in `packages/contracts` imports anything else.

## Governance: additive-only evolution

After the Phase 1 freeze, contract changes follow the **additive-only** rule:

- **Allowed with 1 code-owner review:** adding new optional fields, adding new
  schemas, adding new enum members that widen (never reinterpret) a result.
- **Breaking changes** — removing or renaming fields, tightening types
  (e.g. lowering a `max()`, making an optional field required), changing enum
  members, changing error codes — require a `CONTRACTS_VERSION` major bump
  **plus approval from every affected UC owner**.

`CONTRACTS_VERSION` (`src/index.ts`, currently `1.0.0`) is the single version
constant consumers can assert against. Enforcement is by CODEOWNERS review on
`packages/contracts/` (see `.github/CODEOWNERS`).

## Naming: camelCase is canonical

All schema fields are **camelCase** (`tablesUsed`, `resultPreview`,
`answerText`, `promptTokens`). UC-02's design notes use snake_case variants
(`tables_used`, `result_preview`, `answer_text`, `prompt_tokens`, …) — those
are **not** added. There is exactly one canonical shape per the freeze; any
consumer holding snake_case payloads maps them at its own boundary.

## Error codes (12, frozen)

The `ErrorCodes` table maps UC-09 §A.7 E-codes to exported names. E10
(truncation) is **not** an error — it is the `truncated: true` flag on
`RunQueryOutputSchema`. `RATE_LIMITED` is reserved per UC-09 F17.
`SQL_EXECUTION_ERROR` (E12) is the 12th code for runtime data errors from
valid-parse SQL (PG classes 22/42): repairable by the SQL generator, never
retried by the transport (ARCH-REVIEW C1).

| E-code | Exported name            | retryable | repairable |
|--------|--------------------------|-----------|------------|
| E1     | `UNAUTHORIZED`           | no        | no         |
| E2     | `SCOPE_DENIED`           | no        | no         |
| E3     | `INVALID_PARAMS`         | no        | no         |
| E4     | `INVALID_SQL`            | no        | yes        |
| E5     | `FORBIDDEN_STATEMENT`    | no        | no         |
| E6     | `FORBIDDEN_FUNCTION`     | no        | no         |
| E7     | `UNKNOWN_TABLE`          | no        | yes        |
| E8     | `SENSITIVE_COLUMN_DENIED`| no        | no         |
| E12    | `SQL_EXECUTION_ERROR`    | no        | yes        |
| E9     | `TIMEOUT`                | yes       | no         |
| E10    | — (truncated flag)       | n/a       | n/a        |
| E11    | `INTERNAL_ERROR`         | yes       | no         |
| F17    | `RATE_LIMITED` (reserved)| yes       | no         |

### Retryable vs repairable routing (mirrors architecture §5.1)

| Category              | Codes                                            | Harness action                                                        |
|-----------------------|--------------------------------------------------|-----------------------------------------------------------------------|
| Transport / transient | `TIMEOUT`, `RATE_LIMITED`, `INTERNAL_ERROR`      | MCP client retries with backoff; `TIMEOUT` allows one simplification rewrite |
| SQL / schema diagnostic | `INVALID_SQL`, `UNKNOWN_TABLE`, `SQL_EXECUTION_ERROR` | `ValidatedQueryExecutor` repairs with sanitized code + `cursorPosition` (≤3 attempts) |
| Hard security / policy | `UNAUTHORIZED`, `SCOPE_DENIED`, `INVALID_PARAMS`, `FORBIDDEN_*`, `SENSITIVE_COLUMN_DENIED` | Immediate hard abort on attempt 1 |

`retryable` and `repairable` are computed by `dbToolError()` from
`RETRYABLE_CODES` and `REPAIRABLE_CODES`; `cursorPosition` is an optional
non-negative integer returned with `INVALID_SQL`.

## Generated interface docs

`docs/mcp_interface.md` is **generated output, never hand-edited**. It is
produced from these schemas via `z.toJSONSchema()`:

```sh
pnpm docs:interface
```

See `scripts/generate-interface.mjs` for the generator.
