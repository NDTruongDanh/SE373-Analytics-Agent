import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui";
import type { InsightReport } from "@shared/contracts";
import { buildChartView } from "./chartView.js";

export interface InsightChartProps {
  title: string;
  report: InsightReport;
  lang: string;
  streaming?: boolean;
}

export function InsightChart({ title, report, lang, streaming = false }: InsightChartProps) {
  const view = buildChartView(title, report, lang);
  if (!view.renderable) {
    if (!view.fallbackText) {
      return null;
    }
    return (
      <div
        className="insight-chart-fallback rounded-xl border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-foreground"
        data-testid="insight-chart-fallback"
      >
        {view.fallbackText}
      </div>
    );
  }
  return (
    <div
      className="insight-chart my-3"
      data-testid="insight-chart"
      data-chart-type={report.chartType}
      data-streaming={streaming ? "true" : "false"}
    >
      <Renderer
        response={view.lang}
        library={openuiChatLibrary}
        isStreaming={streaming}
      />
    </div>
  );
}

export { buildChartView, isTrustedOpenuiLang } from "./chartView.js";
export type { ChartView } from "./chartView.js";
