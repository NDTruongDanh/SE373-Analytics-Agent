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

`CONTRACTS_VERSION` (`src/index.ts`, currently `0.1.0`) is the single version
constant consumers can assert against. Enforcement is by CODEOWNERS review on
`packages/contracts/` (see `.github/CODEOWNERS`).

## Naming: camelCase is canonical

All schema fields are **camelCase** (`tablesUsed`, `resultPreview`,
`answerText`, `promptTokens`). UC-02's design notes use snake_case variants
(`tables_used`, `result_preview`, `answer_text`, `prompt_tokens`, …) — those
are **not** added. There is exactly one canonical shape per the freeze; any
consumer holding snake_case payloads maps them at its own boundary.

## Error codes (11, frozen)

The `ErrorCodes` table maps UC-09 §A.7 E-codes to exported names. E10
(truncation) is **not** an error — it is the `truncated: true` flag on
`RunQueryOutputSchema`. `RATE_LIMITED` is reserved per UC-09 F17.

| E-code | Exported name            | Retryable |
|--------|--------------------------|-----------|
| E1     | `UNAUTHORIZED`           | no        |
| E2     | `SCOPE_DENIED`           | no        |
| E3     | `INVALID_PARAMS`         | no        |
| E4     | `INVALID_SQL`            | no        |
| E5     | `FORBIDDEN_STATEMENT`    | no        |
| E6     | `FORBIDDEN_FUNCTION`     | no        |
| E7     | `UNKNOWN_TABLE`          | no        |
| E8     | `SENSITIVE_COLUMN_DENIED`| no        |
| E9     | `TIMEOUT`                | yes       |
| E10    | — (truncated flag)       | n/a       |
| E11    | `INTERNAL_ERROR`         | yes       |
| F17    | `RATE_LIMITED` (reserved)| yes       |

## Generated interface docs

`docs/mcp_interface.md` is **generated output, never hand-edited**. It is
produced from these schemas via `z.toJSONSchema()`:

```sh
pnpm docs:interface
```

See `scripts/generate-interface.mjs` for the generator.
