import { z } from "zod";
import type { SchemaCatalog } from "@shared/contracts";
import type { ExecutorPrincipal } from "../queryExecutor/executor.js";
import type { ValidatedQueryExecutor } from "../queryExecutor/executor.js";

export const AlertDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected date in YYYY-MM-DD format")
  .refine((value) => {
    if (value.startsWith("0000-")) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Expected a valid calendar date");

export type AlertQueryExecutor = Pick<ValidatedQueryExecutor, "run">;

export interface AlertQueryInput {
  queryExecutor: AlertQueryExecutor;
  principal: ExecutorPrincipal;
  catalog: SchemaCatalog;
  question: string;
  sql: string;
  candidateTables: string[];
}

export interface AlertQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  sql: string;
}

export async function executeAlertQuery(
  input: AlertQueryInput,
): Promise<AlertQueryResult> {
  const result = await input.queryExecutor.run({
    question: `${input.question}\nInitial SQL:\n${input.sql}`,
    initialSql: input.sql,
    candidateTables: input.candidateTables,
    principal: input.principal,
    catalog: input.catalog,
  });

  if (result.status === "ok" || result.status === "no_data") {
    return {
      rows: result.rows,
      rowCount: result.rows.length,
      sql: result.sql,
    };
  }

  if (result.status === "error" || result.status === "restricted") {
    throw new Error(
      `Validated alert query ${result.status}: ${result.error.code} - ${result.error.message}`,
    );
  }

  if (result.status === "needs_clarification") {
    throw new Error(
      `Validated alert query needs clarification: ${result.reason}`,
    );
  }

  throw new Error(`Validated alert query cannot run: ${result.reason}`);
}
