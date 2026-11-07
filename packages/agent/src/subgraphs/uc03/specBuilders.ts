// Deterministic chart-spec builders (UC-03, docs/UC-plan/UC03.md §2.1).
//
// Code-built specs plucked straight from the buffer: used for the keyless
// deterministic path (no model key → no LLM call) and as the Loop-4
// fallback when LLM repairs are exhausted. Built specs always pass
// `validateChartGrounding` against the buffer they were built from.

import type { ChartType, OpenuiChartSpec } from "@shared/contracts";
import { buildTableSpec } from "../../validators/renderChart.js";
import {
  analyzeColumns,
  toNumberCell,
  type SelectorBuffer,
} from "../../validators/chartSelector.js";

/** Max series the builders emit (contract cap is 8). */
export const MAX_SPEC_SERIES = 8;

function stringCell(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value === null || value === undefined) return "null";
  try {
    return (JSON.stringify(value) ?? "null").slice(0, 256);
  } catch {
    return "unserializable";
  }
}

/** Rows where every listed column is numeric-coercible. */
function numericRows(
  buffer: SelectorBuffer,
  columns: string[],
): Record<string, unknown>[] {
  return buffer.rows.filter((row) =>
    columns.every((column) => toNumberCell(row[column]) !== null),
  );
}

function buildLine(buffer: SelectorBuffer): OpenuiChartSpec | null {
  const roles = analyzeColumns(buffer);
  const time = roles.timeColumns[0];
  const seriesCols = roles.numericColumns.slice(0, MAX_SPEC_SERIES);
  if (time === undefined || seriesCols.length === 0) return null;
  const rows = numericRows(buffer, seriesCols);
  if (rows.length === 0) return null;
  return {
    chart: "LineChart",
    labels: rows.map((row) => stringCell(row[time])),
    series: seriesCols.map((column) => ({
      category: column.slice(0, 128),
      values: rows.map((row) => toNumberCell(row[column]) as number),
    })),
    variant: "linear",
  };
}

function buildBar(buffer: SelectorBuffer): OpenuiChartSpec | null {
  const roles = analyzeColumns(buffer);
  const cat = roles.categoricalColumns[0];
  const seriesCols = roles.numericColumns.slice(0, MAX_SPEC_SERIES);
  if (cat === undefined || seriesCols.length === 0) return null;
  const rows = numericRows(buffer, seriesCols);
  if (rows.length === 0) return null;
  return {
    chart: "BarChart",
    labels: rows.map((row) => stringCell(row[cat])),
    series: seriesCols.map((column) => ({
      category: column.slice(0, 128),
      values: rows.map((row) => toNumberCell(row[column]) as number),
    })),
    variant: "grouped",
  };
}

function buildPie(buffer: SelectorBuffer): OpenuiChartSpec | null {
  const roles = analyzeColumns(buffer);
  const cat = roles.categoricalColumns[0];
  const valueCol = roles.numericColumns[0];
  if (cat === undefined || valueCol === undefined) return null;
  const rows = numericRows(buffer, [valueCol]);
  if (rows.length < 2) return null;
  const values = rows.map((row) => toNumberCell(row[valueCol]) as number);
  if (values.some((value) => value < 0)) return null;
  return {
    chart: "PieChart",
    labels: rows.map((row) => stringCell(row[cat])),
    values,
    variant: "pie",
  };
}

function buildScatter(buffer: SelectorBuffer): OpenuiChartSpec | null {
  const roles = analyzeColumns(buffer);
  const [xCol, yCol] = roles.numericColumns;
  if (xCol === undefined || yCol === undefined) return null;
  const rows = numericRows(buffer, [xCol, yCol]).slice(0, 1000);
  if (rows.length === 0) return null;
  return {
    chart: "ScatterChart",
    datasets: [
      {
        name: `${yCol} vs ${xCol}`.slice(0, 128),
        points: rows.map((row) => ({
          x: toNumberCell(row[xCol]) as number,
          y: toNumberCell(row[yCol]) as number,
        })),
      },
    ],
    xLabel: xCol.slice(0, 128),
    yLabel: yCol.slice(0, 128),
  };
}

/**
 * Build a valid spec for the selected chart type from buffer cells.
 * Returns null when the buffer cannot back the type (caller falls back
 * to `buildTableSpec`, then to `None`).
 */
export function buildSpecForChart(
  chartType: ChartType,
  buffer: SelectorBuffer,
): OpenuiChartSpec | null {
  switch (chartType) {
    case "line":
      return buildLine(buffer);
    case "bar":
      return buildBar(buffer);
    case "pie":
      return buildPie(buffer);
    case "scatter":
      return buildScatter(buffer);
    case "table":
      return buildTableSpec(buffer);
    case "none":
      return { chart: "None" };
  }
}
