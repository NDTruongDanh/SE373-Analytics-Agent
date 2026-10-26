import * as z from "zod";

// RenderChart JSON-spec-only contract (CONT-03, UC-03 verification surface).
// The spec is a free-form JSON chart description compiled headlessly by
// UC-03; no code execution happens through this contract.

export const RenderChartInputSchema = z.object({
  chartType: z.enum(["line", "bar", "pie", "scatter", "table", "none"]),
  spec: z.record(z.string(), z.unknown()),
  title: z.string().max(200).optional(),
});

export type RenderChartInput = z.infer<typeof RenderChartInputSchema>;

export const RenderChartOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(500).optional(),
});

export type RenderChartOutput = z.infer<typeof RenderChartOutputSchema>;
