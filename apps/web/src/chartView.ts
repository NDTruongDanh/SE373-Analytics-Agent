// UC-03 web chart view-model (pure, node-safe).
//
// Decides whether an `InsightReport` plus its serializer-produced OpenUI
// Lang should reach the upstream `<Renderer/>`, and what plain-text
// fallback the chat shows otherwise. No React, no upstream imports here —
// `charts.tsx` binds the real `Renderer` + `openuiChatLibrary` in the
// browser, where component CSS can load. Node-safe by construction so unit
// tests assert this logic without jsdom.

import { InsightReportSchema, type InsightReport } from "@shared/contracts";

export interface ChartView {
  /** False for `none` (scalar / no_data) or untrusted/invalid Lang: render text fallback. */
  renderable: boolean;
  /** Raw OpenUI Lang lines from the harness serializer. */
  lang: string;
  /** Plain-text fallback: title plus up to two insight claims and caveats. */
  fallbackText: string;
}

const TRUSTED_COMPONENT_LINE_RE =
  /^[a-z][a-z0-9_]* = (?:Card|TextContent|LineChart|BarChart|PieChart|ScatterChart|Table|Series|ScatterSeries|Point|Col)\([\s\S]*\)$/;

const TRUSTED_ARRAY_LINE_RE = /^(?:labels|values) = \[[\s\S]*\]$/;

const ALLOWED_CALL_NAMES = new Set([
  "Card",
  "TextContent",
  "LineChart",
  "BarChart",
  "PieChart",
  "ScatterChart",
  "Table",
  "Series",
  "ScatterSeries",
  "Point",
  "Col",
]);

function stripQuotedStrings(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function hasOnlyAllowedCalls(line: string): boolean {
  const scrubbed = stripQuotedStrings(line);
  const calls = scrubbed.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g);
  for (const match of calls) {
    if (!ALLOWED_CALL_NAMES.has(match[1]!)) {
      return false;
    }
  }
  return true;
}

/**
 * Verify that OpenUI Lang matches the deterministic harness serializer's
 * `root = Card(...)` envelope and uses only allowlisted chart/layout
 * constructors. Raw model-authored Lang or tool calls (`Query`, `Mutation`,
 * `Stack`, etc.) are rejected fail-closed.
 */
export function isTrustedOpenuiLang(lang: string): boolean {
  if (typeof lang !== "string") return false;
  const lines = lang
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  if (!lines[0]!.startsWith("root = Card(")) return false;
  return lines.every(
    (line) =>
      (TRUSTED_COMPONENT_LINE_RE.test(line) || TRUSTED_ARRAY_LINE_RE.test(line)) &&
      hasOnlyAllowedCalls(line),
  );
}

/**
 * Build the chart view-model. `none` reports, invalid reports, and Lang that
 * does not match the serializer's `root = Card(` envelope are never
 * renderable — the harness serializer is the only Lang producer the UI trusts.
 */
export function buildChartView(
  title: string,
  report: InsightReport,
  lang: string,
): ChartView {
  const validReport = InsightReportSchema.safeParse(report).success;
  const renderable =
    validReport &&
    report.chartType !== "none" &&
    report.chartSpec.chart !== "None" &&
    isTrustedOpenuiLang(lang);
  const claims = Array.isArray(report?.insights)
    ? report.insights.slice(0, 2).map((insight) => insight.claim)
    : [];
  const caveats = Array.isArray(report?.caveats) ? report.caveats : [];
  const fallbackText = [title, ...claims, ...caveats]
    .filter((line) => typeof line === "string" && line.trim() !== "")
    .join("\n");
  return { renderable, lang, fallbackText };
}
