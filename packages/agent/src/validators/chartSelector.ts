// UC-03 deterministic chart-type selector (K1, architecture §3.2.9).
//
// Shape-first rules from docs/UC-plan/UC03.md §1.1: the result-set shape
// decides, never model vibes. The LLM only writes chartReason plus the data
// arrays; the harness overrides the type when the shape demands it. Pure
// function — no model, no I/O — so fixtures grade it without a key.

import type { ChartType } from "@shared/contracts";

export interface ChartSelection {
  chartType: ChartType;
  reason: string;
}

export interface SelectorBuffer {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Row-count ceiling the selector reasons about (bar groups, pie slices). */
export const MAX_BAR_GROUPS = 12;
export const MAX_PIE_SLICES = 6;
export const MIN_PIE_SLICES = 2;

const TIME_COLUMN_RE =
  /(time|date|month|year|day|week|quarter|hour|ngay|ngày|thang|tháng|nam|năm|tuan|tuần|quy|quý)/i;
const SHARE_COLUMN_RE =
  /(share|pct|percent|ratio|t[iỷ]\s*l[ệe]|t[ỷỉ]\s*tr[ọo]ng|^%$|percentile)/i;

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/;
const QUARTER_RE = /^(Q[1-4]|quy|quý\s*[1-4])\s*\d{4}$|^\d{4}\s*[-/]?\s*(Q[1-4]|quy|quý\s*[1-4])$/i;
const MONTH_NAME_RE =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4}$/i;

function cellText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Numeric cells: numbers plus numeric strings ("5,200", " 5200 "). */
export function isNumericCell(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const compact = value.trim().replace(/,/g, "");
  return compact !== "" && Number.isFinite(Number(compact));
}

export function toNumberCell(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const compact = value.trim().replace(/,/g, "");
  if (compact === "") return null;
  const n = Number(compact);
  return Number.isFinite(n) ? n : null;
}

export function isTimeValue(value: unknown): boolean {
  const text = cellText(value)?.trim() ?? "";
  if (text === "") return false;
  return (
    YEAR_MONTH_RE.test(text) || QUARTER_RE.test(text) || MONTH_NAME_RE.test(text)
  );
}

export interface ColumnRoles {
  timeColumns: string[];
  numericColumns: string[];
  categoricalColumns: string[];
  /** Distinct stringified values per column (for group-count rules). */
  distinctCounts: Map<string, number>;
}

/** Single-pass role analysis shared by the selector and the spec builders. */
export function analyzeColumns(buffer: SelectorBuffer): ColumnRoles {
  const timeColumns: string[] = [];
  const numericColumns: string[] = [];
  const categoricalColumns: string[] = [];
  const distinctCounts = new Map<string, number>();
  const { columns, rows } = buffer;
  if (rows.length === 0) {
    return { timeColumns, numericColumns, categoricalColumns, distinctCounts };
  }
  for (const column of columns) {
    let numeric = 0;
    let time = 0;
    let filled = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const value = row[column];
      if (value === null || value === undefined || value === "") continue;
      filled += 1;
      if (isNumericCell(value)) numeric += 1;
      if (isTimeValue(value)) time += 1;
      const text = cellText(value);
      if (text !== null) seen.add(text);
    }
    distinctCounts.set(column, seen.size);
    if (filled > 0 && time / filled >= 0.8) {
      timeColumns.push(column);
    } else if (filled > 0 && numeric / filled >= 0.8) {
      numericColumns.push(column);
    } else {
      categoricalColumns.push(column);
    }
    // A time-named column with time-parseable values wins even on a split.
    if (
      TIME_COLUMN_RE.test(column) &&
      filled > 0 &&
      time / filled >= 0.5 &&
      !timeColumns.includes(column)
    ) {
      const catIndex = categoricalColumns.indexOf(column);
      if (catIndex >= 0) categoricalColumns.splice(catIndex, 1);
      timeColumns.push(column);
    }
  }
  return { timeColumns, numericColumns, categoricalColumns, distinctCounts };
}

function distinctOf(roles: ColumnRoles, column: string): number {
  return roles.distinctCounts.get(column) ?? 0;
}

function shareSemantics(columns: string[], rows: Record<string, unknown>[]): boolean {
  if (columns.some((column) => SHARE_COLUMN_RE.test(column))) return true;
  for (const column of columns) {
    let sum = 0;
    let count = 0;
    for (const row of rows) {
      const n = toNumberCell(row[column]);
      if (n === null || n < 0) {
        count = -1;
        break;
      }
      sum += n;
      count += 1;
    }
    // Shares of ~100% with at least two non-trivial slices.
    if (count >= 2 && sum >= 99 && sum <= 101) return true;
  }
  return false;
}

/**
 * Deterministic chart-type selection (§1.1 rule table).
 *
 * @param buffer Result-set shape (columns + buffer rows, preview or full).
 * @param status RunQuery status: anything but "ok" forces "none".
 */
export function selectChartType(
  buffer: SelectorBuffer,
  status: string,
): ChartSelection {
  const { columns, rows } = buffer;
  if (status !== "ok" || rows.length === 0) {
    return {
      chartType: "none",
      reason:
        status !== "ok"
          ? `Status is ${status}, so no chart is drawn.`
          : "No rows were returned, so no chart is drawn.",
    };
  }
  if (rows.length === 1 && columns.length <= 1) {
    return {
      chartType: "none",
      reason: "A single scalar value needs no chart.",
    };
  }

  const roles = analyzeColumns(buffer);

  // Time series beats everything else when a time axis exists.
  if (roles.timeColumns.length > 0 && roles.numericColumns.length > 0 && rows.length >= 2) {
    return {
      chartType: "line",
      reason: `Column ${roles.timeColumns[0]} is a time axis with ${rows.length} points, so a line chart shows the trend.`,
    };
  }

  // A categorical split plus numeric series: pie for small non-negative
  // shares, bar for comparisons. Two or more categorical splits have no
  // single chart axis (builders cannot pivot), so they list as detail.
  const cat = roles.categoricalColumns[0];
  if (cat !== undefined && roles.numericColumns.length > 0) {
    if (roles.categoricalColumns.length >= 2) {
      return {
        chartType: "table",
        reason: `Multiple categorical splits (${roles.categoricalColumns.join(", ")}) have no single chart axis, so a table shows the detail.`,
      };
    }
    const groups = distinctOf(roles, cat);
    const shareLike = shareSemantics(roles.numericColumns.slice(0, 1), rows);
    const values = rows.map((row) => toNumberCell(row[roles.numericColumns[0]]));
    if (shareLike && values.some((value) => value !== null && (value as number) < 0)) {
      return {
        chartType: "table",
        reason: `Share values for ${cat} go negative, so a table shows the raw figures instead of a misleading chart.`,
      };
    }
    if (
      roles.numericColumns.length === 1 &&
      groups >= MIN_PIE_SLICES &&
      groups <= MAX_PIE_SLICES &&
      shareLike
    ) {
      return {
        chartType: "pie",
        reason: `${groups} ${cat} groups share a non-negative total, so a pie chart shows the breakdown.`,
      };
    }
    if (groups >= 2 && groups <= MAX_BAR_GROUPS) {
      return {
        chartType: "bar",
        reason: `${groups} ${cat} groups are compared on ${roles.numericColumns.length} metric(s), so a bar chart fits.`,
      };
    }
    return {
      chartType: "table",
      reason:
        groups > MAX_BAR_GROUPS
          ? `${groups} ${cat} groups exceed the ${MAX_BAR_GROUPS}-group bar limit, so a table lists the detail.`
          : `A single ${cat} group has no comparison to draw, so a table shows the figures.`,
    };
  }

  // Two numeric variables with no categorical split: correlation view.
  if (
    roles.numericColumns.length >= 2 &&
    roles.categoricalColumns.length === 0 &&
    rows.length >= 3
  ) {
    return {
      chartType: "scatter",
      reason: `Columns ${roles.numericColumns[0]} and ${roles.numericColumns[1]} are both numeric, so a scatter chart shows their relationship.`,
    };
  }

  // Single row with several metrics, or anything the rules above miss.
  return {
    chartType: "table",
    reason: "The result mixes types or has no single chartable axis, so a table shows the detail.",
  };
}
