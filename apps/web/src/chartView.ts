import { InsightReportSchema, type InsightReport } from "@shared/contracts";

export interface ChartView {
  renderable: boolean;
  lang: string;
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

// Enforce the harness serializer's root = Card(...) envelope and allowlisted constructors fail-closed.
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
