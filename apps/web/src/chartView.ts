// UC-03 web chart view-model (pure, node-safe).
//
// Decides whether an `InsightReport` plus its serializer-produced OpenUI
// Lang should reach the upstream `<Renderer/>`, and what plain-text
// fallback the chat shows otherwise. No React, no upstream imports here —
// `charts.tsx` binds the real `Renderer` + `openuiChatLibrary` in the
// browser, where component CSS can load. Node-safe by construction so unit
// tests assert this logic without jsdom.

import type { InsightReport } from "@shared/contracts";

export interface ChartView {
  /** False for `none` (scalar / no_data): render text, not the Renderer. */
  renderable: boolean;
  /** Raw OpenUI Lang lines from the harness serializer. */
  lang: string;
  /** Plain-text fallback: title plus up to two insight claims. */
  fallbackText: string;
}

/**
 * Build the chart view-model. `none` reports and Lang that does not start
 * with the serializer's `root = Card(` envelope are never renderable —
 * the harness serializer is the only Lang producer the UI trusts.
 */
export function buildChartView(
  title: string,
  report: InsightReport,
  lang: string,
): ChartView {
  const renderable =
    report.chartType !== "none" && lang.startsWith("root = Card(");
  const claims = report.insights
    .slice(0, 2)
    .map((insight) => insight.claim);
  const fallbackText = [title, ...claims, ...report.caveats]
    .filter((line) => line.trim() !== "")
    .join("\n");
  return { renderable, lang, fallbackText };
}
