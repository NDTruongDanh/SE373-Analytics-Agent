// Headless `render_chart` validator (UC-03 K7, architecture §3.2.9).
//
// Local deterministic utility — no code execution, no network, no model
// (PRD §4.1 `render_chart` row). Two layers:
//
// 1. `validateChartSpec` — structural check: zod `OpenuiChartSpecSchema` plus
//    the `chartType` ↔ component match (`CHART_TYPE_TO_COMPONENT`). Returns a
//    structured diff, never throws, so the repair loop can re-prompt with
//    `{ code, field, hint }` instead of raw errors.
// 2. `validateChartGrounding` — data check: every string in `labels` / Table
//    label data must appear as a buffer cell; every number must match a
//    numeric buffer cell within <= 1% rounding tolerance. OpenUI specs carry
//    plucked inline data (not field references), so this check is stronger
//    than a field-∈-columns test: the chart cannot show a number the query
//    never returned.
//
// `RENDER_REPAIR_LIMIT` caps the repair loop (Loop 4, <= 2 repairs); after
// that the caller falls back to `buildTableSpec`, never blocking the answer.

import {
  CHART_TYPE_TO_COMPONENT,
  OpenuiChartSpecSchema,
  type ChartType,
  type OpenuiChartSpec,
} from "@shared/contracts";
import { toNumberCell, type SelectorBuffer } from "./chartSelector.js";

/** Structured validator diff consumed by the repair re-prompt. */
export interface ChartIssue {
  code: "chart_shape" | "chart_mismatch" | "chart_grounding";
  field: string;
  message: string;
}

export type ChartValidation =
  | { ok: true; spec: OpenuiChartSpec }
  | { ok: false; issue: ChartIssue };

/** Loop 4 bound: at most two targeted repairs per report. */
export const RENDER_REPAIR_LIMIT = 2;

/** <= 1% relative rounding tolerance (same bound as numeric claims). */
export const CHART_NUMBER_TOLERANCE = 0.01;

function mismatch(chartType: ChartType, got: unknown): ChartValidation {
  const expected =
    CHART_TYPE_TO_COMPONENT[chartType as keyof typeof CHART_TYPE_TO_COMPONENT] ??
    "unknown";
  return {
    ok: false,
    issue: {
      code: "chart_mismatch",
      field: "chartSpec.chart",
      message: `chartType "${chartType}" requires spec component "${expected}", got ${JSON.stringify(got)}.`,
    },
  };
}

/**
 * Structural validation only (no buffer needed): zod shape plus the
 * chartType ↔ component refine, normalized to a ChartIssue.
 */
export function validateChartSpec(
  chartType: ChartType,
  spec: unknown,
): ChartValidation {
  const parsed = OpenuiChartSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      issue: {
        code: "chart_shape",
        field: first?.path.join(".") || "chartSpec",
        message: `chartSpec shape invalid: ${first?.message ?? "unknown zod issue"}.`,
      },
    };
  }
  const expected =
    CHART_TYPE_TO_COMPONENT[chartType as keyof typeof CHART_TYPE_TO_COMPONENT];
  if (expected === undefined) {
    return {
      ok: false,
      issue: {
        code: "chart_shape",
        field: "chartType",
        message: `unknown chartType ${JSON.stringify(chartType)}.`,
      },
    };
  }
  if (parsed.data.chart !== expected) return mismatch(chartType, parsed.data.chart);
  return { ok: true, spec: parsed.data };
}

function bufferTexts(buffer: SelectorBuffer): Set<string> {
  const texts = new Set<string>();
  for (const row of buffer.rows) {
    for (const column of buffer.columns) {
      const value = row[column];
      if (typeof value === "string" && value !== "") texts.add(value);
      else if (typeof value === "number" && Number.isFinite(value)) {
        texts.add(String(value));
      }
    }
  }
  return texts;
}

function bufferNumbers(buffer: SelectorBuffer): number[] {
  const numbers: number[] = [];
  for (const row of buffer.rows) {
    for (const column of buffer.columns) {
      const n = toNumberCell(row[column]);
      if (n !== null) numbers.push(n);
    }
  }
  return numbers;
}

function numberGrounded(value: number, pool: number[]): boolean {
  for (const actual of pool) {
    const denom = Math.max(Math.abs(actual), 1e-9);
    if (Math.abs(value - actual) / denom <= CHART_NUMBER_TOLERANCE) return true;
  }
  return false;
}

function collectStrings(spec: OpenuiChartSpec): { field: string; values: string[] }[] {
  switch (spec.chart) {
    case "LineChart":
    case "BarChart":
      return [{ field: "labels", values: spec.labels }];
    case "PieChart":
      return [{ field: "labels", values: spec.labels }];
    case "ScatterChart":
      return [];
    case "Table": {
      const out: { field: string; values: string[] }[] = [];
      spec.columns.forEach((column, index) => {
        const strings = column.data.filter(
          (cell): cell is string => typeof cell === "string",
        );
        if (strings.length > 0) {
          out.push({ field: `columns[${index}].data`, values: strings });
        }
      });
      return out;
    }
    case "None":
      return [];
  }
}

function collectNumbers(spec: OpenuiChartSpec): { field: string; values: number[] }[] {
  switch (spec.chart) {
    case "LineChart":
    case "BarChart": {
      const out: { field: string; values: number[] }[] = [];
      spec.series.forEach((series, index) => {
        out.push({ field: `series[${index}].values`, values: series.values });
      });
      return out;
    }
    case "PieChart":
      return [{ field: "values", values: spec.values }];
    case "ScatterChart": {
      const out: { field: string; values: number[] }[] = [];
      spec.datasets.forEach((dataset, index) => {
        const values: number[] = [];
        for (const point of dataset.points) {
          values.push(point.x, point.y);
          if (point.z !== undefined) values.push(point.z);
        }
        out.push({ field: `datasets[${index}].points`, values });
      });
      return out;
    }
    case "Table": {
      const out: { field: string; values: number[] }[] = [];
      spec.columns.forEach((column, index) => {
        const numbers = column.data.filter(
          (cell): cell is number => typeof cell === "number",
        );
        if (numbers.length > 0) {
          out.push({ field: `columns[${index}].data`, values: numbers });
        }
      });
      return out;
    }
    case "None":
      return [];
  }
}

/**
 * Data-grounding validation: every label string and every plotted number
 * must trace to a buffer cell. Series/dataset *names* and axis labels are
 * display text, not data, and are not grounded.
 */
export function validateChartGrounding(
  spec: OpenuiChartSpec,
  buffer: SelectorBuffer,
): ChartValidation {
  const texts = bufferTexts(buffer);
  for (const { field, values } of collectStrings(spec)) {
    for (const value of values) {
      if (!texts.has(value)) {
        return {
          ok: false,
          issue: {
            code: "chart_grounding",
            field,
            message: `label ${JSON.stringify(value)} does not appear in the query results.`,
          },
        };
      }
    }
  }
  const pool = bufferNumbers(buffer);
  for (const { field, values } of collectNumbers(spec)) {
    for (const value of values) {
      if (!numberGrounded(value, pool)) {
        return {
          ok: false,
          issue: {
            code: "chart_grounding",
            field,
            message: `number ${value} matches no query result cell within 1% tolerance.`,
          },
        };
      }
    }
  }
  return { ok: true, spec };
}

/** Full headless compile: shape, then type match, then grounding. */
export function validateChart(
  chartType: ChartType,
  spec: unknown,
  buffer: SelectorBuffer,
): ChartValidation {
  const shaped = validateChartSpec(chartType, spec);
  if (!shaped.ok) return shaped;
  return validateChartGrounding(shaped.spec, buffer);
}

function toCell(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value.slice(0, 1000);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value)?.slice(0, 1000) ?? "null";
  } catch {
    return "unserializable";
  }
}

/**
 * Deterministic fallback: a Table spec plucked straight from the buffer, so
 * a failed chart never blocks the answer. Always passes grounding against
 * the buffer it was built from.
 */
export function buildTableSpec(
  buffer: SelectorBuffer,
  maxRows = 50,
  maxColumns = 32,
): OpenuiChartSpec {
  const columns = buffer.columns.slice(0, Math.max(1, maxColumns)).map((label) => ({
    label: label.slice(0, 128),
    data: buffer.rows
      .slice(0, maxRows)
      .map((row) => toCell(row[label])),
    type: "string" as const,
  }));
  if (columns.length === 0) {
    return { chart: "None" };
  }
  return { chart: "Table", columns };
}
