/**
 * Prefer explicit count columns because Number(true)/Number(null)/Number("") are finite;
 * numeric-only id columns remain a last resort.
 */
const COUNT_COLUMN_NAME = /^(n|count|total|.*_count|count_.*|num_.*)$/i;

function isCountCell(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return (
    typeof value === "string" &&
    value.length > 0 &&
    /^-?\d+(\.\d+)?$/.test(value)
  );
}

export function previewCountKey(
  columns: readonly string[],
  preview: readonly Record<string, unknown>[],
): string {
  if (columns.includes("n")) return "n";
  const countLike = (column: string): boolean =>
    COUNT_COLUMN_NAME.test(column) &&
    preview.length > 0 &&
    preview.every((row) => isCountCell(row[column]));
  const named = columns.find(countLike);
  if (named !== undefined) return named;
  return (
    columns.find(
      (column) =>
        preview.length > 0 &&
        preview.every((row) => isCountCell(row[column])),
    ) ?? "n"
  );
}

export function previewCountTotal(
  columns: readonly string[],
  preview: readonly Record<string, unknown>[],
): number {
  const key = previewCountKey(columns, preview);
  return preview.reduce((sum, row) => sum + Number(row[key] ?? 0), 0);
}
