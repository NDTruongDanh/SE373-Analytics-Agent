export const HIGH_CARDINALITY_THRESHOLD = 20;

const VERIFIED_DISTINCT_COUNTS: Readonly<Record<string, number>> = {
  "products.name": 32954,
  "categories.name_vi": 75,
  "regions.province": 34,
  "customers.province": 34,
  "sellers.province": 34,
  "employees.province": 34,
};

export function isHighCardinalityDiagnosticColumn(table: string, column: string): boolean {
  return (VERIFIED_DISTINCT_COUNTS[`${table.toLowerCase()}.${column.toLowerCase()}`] ?? 0) >
    HIGH_CARDINALITY_THRESHOLD;
}

export function likeDiagnosticTerms(literal: string): string[] {
  const raw = literal.trim().slice(0, 80);
  if (raw.length < 2 || /[\u0000-\u001f]/.test(raw)) return [];
  const tokens = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  const fallbacks = tokens.filter((token) => token.length >= 3)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .filter((token) => token.toLowerCase() !== raw.toLowerCase())
    .slice(0, 2);
  return [raw, ...fallbacks];
}

export function escapedIlikePattern(term: string): string {
  const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
  return `E'${pattern.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}
