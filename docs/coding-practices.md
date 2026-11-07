# Coding practices — TypeScript patterns

Read when writing or editing `packages/*/src/**/*.ts`.
Source and `eslint.config.mjs` stay authoritative; this file names the shape so reviews converge.

## Imports — ESM only

- `import`/`export` only; relative paths carry `.ts` suffix (e.g. `from "./state.ts"`).
- Cross-package via `@shared/*` workspace names; builtins via `node:` prefix; third-party bare.
- `import type` for types-only (`isolatedModules`-friendly).
- Barrel `index.ts` re-exports: `export * from "./tools.ts"`.

## Naming — files and identifiers

- Files lowercase single-word (`guard.ts`, `server.ts`); kebab-case only on collision (`sensitive-columns.ts`).
- Name by capability, not UC number — files, variables, functions, types (`textToSql.ts`, `buildTextToSqlGraph()`, `TextToSqlResult`, not `uc01.ts`, `handleUc01()`, `Uc01Result`); keep the UC mapping in the registry and comments.
- Types/schemas/classes `PascalCase`, functions `camelCase`, shared sets/versions `SCREAMING_SNAKE` (`CONTRACTS_VERSION`, `FORBIDDEN_FUNCTIONS`).

## Zod — contracts owns shapes

- Co-locate `XxxSchema` + `type Xxx = z.infer<typeof XxxSchema>`; open every contract file with `import { z } from "zod"` (Zod v4 style).
- Closed vocab `z.enum`, variants `z.discriminatedUnion("kind"|"event", …)` built via `.extend({ kind: z.literal(…) })`.
- Default `z.object` strips unknown keys; the sole `z.strictObject` is empty `ListTablesInputSchema` (scope filtering is server-side).
- Bound inputs: strings `.min(1).max(…)`, ints `.int().min().max()`, dates `z.iso.datetime()`; `z.unknown()` only for opaque `data`/`payload` hatches.
- `contracts` depends on zod only.

## Errors — codes carry retry

- Shape `DbToolError { code, message, retryable, repairable, cursorPosition? }` in `packages/contracts/src/errors.ts`; build via `dbToolError(code, message)` which derives the flags from `RETRYABLE_CODES` / `REPAIRABLE_CODES`.
- MCP seam throws `DbToolError`; past the seam return, don't throw: agent maps to `ExecutorResult` (`ok | no_data | needs_clarification | restricted | error | cannot_answer`) and `SafetyGateResult` (`allow | deny | needs_clarification`).
- Route by flags: `retryable` guides client retry, `repairable` guides the ≤3-attempt repair loop (`routeMcpError`, `MAX_ATTEMPTS=3`); unlisted codes abort.
- Server `sanitizeError` is the single choke: maps PG codes to contract codes, redacts DSN/PII, caps at 500 chars, keeps `cursorPosition` only for `INVALID_SQL`.

## Async + types — narrow unknowns

- `async`/`await` throughout; raw `.then` / `new Promise` only to promisify streams or server listen.
- `unknown` + narrow, never `any`: rows as `Record<string, unknown>[]`, casts as `(field as Record<string, unknown>)`, derived types as `Awaited<ReturnType<typeof parse>>`.

## Layout — flat src, tests per package

- Flat `src/*.ts` per concern (`index, server, pipeline, executor, tools, errors, config, catalog, audit, auth`); `queryExecutor/` subdir only for the SQL path.
- Tests in `packages/<pkg>/test/*.test.ts`; validate with `pnpm typecheck && pnpm lint`.
