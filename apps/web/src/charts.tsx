// UC-03 web chart renderer (browser only).
//
// Renders a verified `InsightReport` through the upstream OpenUI chat
// stack: `<Renderer library={openuiChatLibrary}/>` from
// `@openuidev/react-lang` + `@openuidev/react-ui` (MIT). The `lang` prop
// must be harness-serialized output (see `serializeOpenuiLang` in
// `packages/agent/src/subgraphs/uc03/serialize.ts`) — the UI never accepts
// model-written Lang, so untrusted component names or actions cannot reach
// the Renderer. Non-renderable reports fall back to plain text.

import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui";
import type { InsightReport } from "@shared/contracts";
import { buildChartView } from "./chartView.js";

export interface InsightChartProps {
  title: string;
  report: InsightReport;
  /** Harness-serialized OpenUI Lang lines. */
  lang: string;
  /** True while the answer stream is still open. */
  streaming?: boolean;
}

export function InsightChart({ title, report, lang, streaming = false }: InsightChartProps) {
  const view = buildChartView(title, report, lang);
  if (!view.renderable) {
    return null;
  }
  return (
    <Renderer
      response={view.lang}
      library={openuiChatLibrary}
      isStreaming={streaming}
    />
  );
}

export { buildChartView };
export type { ChartView } from "./chartView.js";
