// Shared EX grader (EVAL-02, PRD 2.2): pure, dependency-free execution
// accuracy over actual versus gold row arrays. Rules: numeric-looking
// strings coerce to numbers first (D-19, results pass through untouched
// elsewhere); numbers compare within half a percent relative tolerance;
// NULL equals only NULL; ISO timestamps normalize through Date parsing;
// column names are ignored (values compare positionally after canonical
// key sort); multiset compare unless ordered is true; cannot_answer
// outcomes grade on status plus reason, never rows.

export type GradeRow = Record<string, unknown>;

export interface GradeActual {
  status: string;
  rows?: GradeRow[] | null;
  reason?: string | null;
}

export interface GradeExpected {
  status?: string;
  rows?: GradeRow[] | null;
  ordered?: boolean;
}

export interface GradeResult {
  pass: boolean;
  mismatches: string[];
}

/** Half-percent relative tolerance bound (PRD 2.2). */
export const EX_TOLERANCE = 0.005;

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}/;

function coerceScalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // D-19: Postgres returns numeric as string; coerce before comparing.
    if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
    if (ISO_LIKE.test(trimmed)) {
      const ms = Date.parse(trimmed);
      if (!Number.isNaN(ms)) return new Date(ms).toISOString();
    }
    return value;
  }
  return value;
}

function numbersEqual(a: number, b: number): boolean {
  if (Object.is(a, b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const denom = Math.max(Math.abs(b), 1e-9);
  // Epsilon slack: 0.5/100 is a hair above 0.005 in binary floating point,
  // but the PRD bound is inclusive (<=0.5%).
  return Math.abs(a - b) / denom <= EX_TOLERANCE * (1 + 1e-9);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  const a = coerceScalar(actual);
  const b = coerceScalar(expected);
  if (a === null || b === null) return a === null && b === null;
  if (typeof a === "number" && typeof b === "number") {
    return numbersEqual(a, b);
  }
  if (typeof a !== typeof b) return false;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Canonical positional form: keys sorted, values coerced, names dropped. */
export function canonicalRow(row: GradeRow): unknown[] {
  return Object.keys(row)
    .sort()
    .map((key) => coerceScalar(row[key]));
}

function compareRowLists(
  actual: GradeRow[],
  gold: GradeRow[],
  ordered: boolean,
  mismatches: string[],
): void {
  if (actual.length !== gold.length) {
    mismatches.push(
      `row count differs: actual ${actual.length}, gold ${gold.length}`,
    );
    return;
  }
  const actualRows = actual.map((row) => canonicalRow(row));
  const goldRows = gold.map((row) => canonicalRow(row));
  const keyOf = (cells: unknown[]): string => JSON.stringify(cells);
  const actualOrder = ordered
    ? actualRows
    : [...actualRows].sort((a, b) =>
        keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
      );
  const goldOrder = ordered
    ? goldRows
    : [...goldRows].sort((a, b) =>
        keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0,
      );
  for (let i = 0; i < goldOrder.length; i += 1) {
    const aCells = actualOrder[i];
    const bCells = goldOrder[i];
    const cellsEqual =
      aCells.length === bCells.length &&
      aCells.every((cell, j) => valuesEqual(cell, bCells[j]));
    if (!cellsEqual) {
      mismatches.push(
        `row ${i} differs (${ordered ? "positional" : "multiset"}): actual ${keyOf(aCells)}, gold ${keyOf(bCells)}`,
      );
    }
  }
}

function gradeCannotAnswer(
  actual: GradeActual,
  mismatches: string[],
): GradeResult {
  if (actual.status !== "cannot_answer") {
    mismatches.push(
      `status differs: actual ${actual.status}, gold cannot_answer`,
    );
    return { pass: false, mismatches };
  }
  if (typeof actual.reason !== "string" || actual.reason.trim() === "") {
    mismatches.push("cannot_answer outcome carries no reason");
    return { pass: false, mismatches };
  }
  return { pass: true, mismatches };
}

export function gradeExecution(
  actual: GradeActual,
  expected: GradeExpected,
): GradeResult {
  const mismatches: string[] = [];
  if (expected.status === "cannot_answer") {
    return gradeCannotAnswer(actual, mismatches);
  }
  compareRowLists(
    actual.rows ?? [],
    expected.rows ?? [],
    expected.ordered ?? false,
    mismatches,
  );
  return { pass: mismatches.length === 0, mismatches };
}
