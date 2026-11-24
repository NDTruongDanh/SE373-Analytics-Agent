import { z } from "zod";

// Keep these six values frozen: eval fixtures label chart types with these names.
export const ChartTypeSchema = z.enum(["line", "bar", "pie", "scatter", "table", "none"]);

export type ChartType = z.infer<typeof ChartTypeSchema>;

export const OpenuiChartNameSchema = z.enum([
  "LineChart",
  "BarChart",
  "PieChart",
  "ScatterChart",
  "Table",
  "None",
]);

export type OpenuiChartName = z.infer<typeof OpenuiChartNameSchema>;

export const OpenuiSeriesSchema = z.object({
  category: z.string().min(1).max(128),
  values: z.array(z.number()).min(1).max(200),
});

export type OpenuiSeries = z.infer<typeof OpenuiSeriesSchema>;

const openuiLabelsSchema = z.array(z.string().min(1).max(256)).min(1).max(200);

const openuiAxisSchema = z.object({
  xLabel: z.string().min(1).max(128).optional(),
  yLabel: z.string().min(1).max(128).optional(),
  height: z.number().positive().max(2000).optional(),
});

export const OpenuiLineChartSpecSchema = openuiAxisSchema.extend({
  chart: z.literal("LineChart"),
  labels: openuiLabelsSchema,
  series: z.array(OpenuiSeriesSchema).min(1).max(8),
  variant: z.enum(["linear", "natural", "step"]).optional(),
}).superRefine((spec, ctx) => {
  for (const [i, s] of spec.series.entries()) {
    if (s.values.length !== spec.labels.length) {
      ctx.addIssue({
        code: "custom",
        message: `series[${i}].values length ${s.values.length} must match labels length ${spec.labels.length}`,
        path: ["series", i, "values"],
      });
    }
  }
});

export type OpenuiLineChartSpec = z.infer<typeof OpenuiLineChartSpecSchema>;

export const OpenuiBarChartSpecSchema = openuiAxisSchema.extend({
  chart: z.literal("BarChart"),
  labels: openuiLabelsSchema,
  series: z.array(OpenuiSeriesSchema).min(1).max(8),
  variant: z.enum(["grouped", "stacked"]).optional(),
}).superRefine((spec, ctx) => {
  for (const [i, s] of spec.series.entries()) {
    if (s.values.length !== spec.labels.length) {
      ctx.addIssue({
        code: "custom",
        message: `series[${i}].values length ${s.values.length} must match labels length ${spec.labels.length}`,
        path: ["series", i, "values"],
      });
    }
  }
});

export type OpenuiBarChartSpec = z.infer<typeof OpenuiBarChartSpecSchema>;

export const OpenuiPieChartSpecSchema = z.object({
  chart: z.literal("PieChart"),
  labels: z.array(z.string().min(1).max(256)).min(2).max(6),
  values: z.array(z.number()).min(2).max(6),
  variant: z.enum(["pie", "donut"]).optional(),
  appearance: z.enum(["circular", "semiCircular"]).optional(),
}).superRefine((spec, ctx) => {
  if (spec.values.length !== spec.labels.length) {
    ctx.addIssue({
      code: "custom",
      message: `values length ${spec.values.length} must match labels length ${spec.labels.length}`,
      path: ["values"],
    });
  }
});

export type OpenuiPieChartSpec = z.infer<typeof OpenuiPieChartSpecSchema>;

export const OpenuiScatterPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number().optional(),
});

export type OpenuiScatterPoint = z.infer<typeof OpenuiScatterPointSchema>;

export const OpenuiScatterDatasetSchema = z.object({
  name: z.string().min(1).max(128),
  points: z.array(OpenuiScatterPointSchema).min(1).max(1000),
});

export type OpenuiScatterDataset = z.infer<typeof OpenuiScatterDatasetSchema>;

export const OpenuiScatterChartSpecSchema = z.object({
  chart: z.literal("ScatterChart"),
  datasets: z.array(OpenuiScatterDatasetSchema).min(1).max(8),
  xLabel: z.string().min(1).max(128).optional(),
  yLabel: z.string().min(1).max(128).optional(),
});

export type OpenuiScatterChartSpec = z.infer<typeof OpenuiScatterChartSpecSchema>;

// Restricted to string/number cells so the numeric validator can verify every cell against RunQueryOutput.
export const OpenuiTableColSchema = z.object({
  label: z.string().min(1).max(128),
  data: z.array(z.union([z.string().min(1).max(1000), z.number()])).max(200),
  type: z.enum(["string", "number"]).optional(),
});

export type OpenuiTableCol = z.infer<typeof OpenuiTableColSchema>;

export const OpenuiTableChartSpecSchema = z.object({
  chart: z.literal("Table"),
  columns: z.array(OpenuiTableColSchema).min(1).max(32),
}).superRefine((spec, ctx) => {
  const expected = spec.columns[0]?.data.length ?? 0;
  for (const [i, col] of spec.columns.entries()) {
    if (col.data.length !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `columns[${i}].data length ${col.data.length} must match first column length ${expected}`,
        path: ["columns", i, "data"],
      });
    }
  }
});

export type OpenuiTableChartSpec = z.infer<typeof OpenuiTableChartSpecSchema>;

export const OpenuiNoneChartSpecSchema = z.object({
  chart: z.literal("None"),
});

export type OpenuiNoneChartSpec = z.infer<typeof OpenuiNoneChartSpecSchema>;

export const OpenuiChartSpecSchema = z.discriminatedUnion("chart", [
  OpenuiLineChartSpecSchema,
  OpenuiBarChartSpecSchema,
  OpenuiPieChartSpecSchema,
  OpenuiScatterChartSpecSchema,
  OpenuiTableChartSpecSchema,
  OpenuiNoneChartSpecSchema,
]);

export type OpenuiChartSpec = z.infer<typeof OpenuiChartSpecSchema>;

export const CHART_TYPE_TO_COMPONENT = {
  line: "LineChart",
  bar: "BarChart",
  pie: "PieChart",
  scatter: "ScatterChart",
  table: "Table",
  none: "None",
} as const;

export const RenderChartInputSchema = z.object({
  chartType: ChartTypeSchema,
  spec: OpenuiChartSpecSchema,
  title: z.string().max(200).optional(),
}).superRefine((input, ctx) => {
  const expected = CHART_TYPE_TO_COMPONENT[input.chartType];
  if (input.spec.chart !== expected) {
    ctx.addIssue({
      code: "custom",
      message: `chartType "${input.chartType}" requires spec.chart "${expected}", got "${input.spec.chart}"`,
      path: ["spec", "chart"],
    });
  }
});

export type RenderChartInput = z.infer<typeof RenderChartInputSchema>;

export const RenderChartOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(500).optional(),
});

export type RenderChartOutput = z.infer<typeof RenderChartOutputSchema>;
