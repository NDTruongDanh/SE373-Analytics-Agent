// Deterministic OpenUI Lang serializer (UC-03, docs/UC-plan/UC03.md §2.1).
//
// The harness — never the model — converts the validated chart spec into
// OpenUI Lang lines for `apps/web`'s `<Renderer library={openuiChatLibrary}/>`,
// so the model can never invent component names or malformed Lang. Shapes
// mirror the upstream genui-lib chat library 1:1
// (`@openuidev/react-ui`, MIT):
//
//   root = Card([title, chart, notes])          (library root is "Card")
//   title = TextContent("…", "large-heavy")
//   chart = BarChart(labels, [s1], "grouped")  (positional = schema key order)
//   labels = ["Oct", …] / s1 = Series("…", […])
//   tbl = Table([c1, c2]) / c1 = Col("…", data, "number")
//   chart = PieChart(labels, values)
//   chart = ScatterChart([d1], "Price", "Qty") / d1 = ScatterSeries("…", [p1])
//
// Pure function — parse-safe by construction (identifiers are generated,
// every string literal is JSON-encoded).

import type { OpenuiChartSpec } from "@shared/contracts";

export interface SerializeInput {
  title: string;
  spec: OpenuiChartSpec;
  /** Zero or more closing notes; joined into one TextContent. */
  notes?: string[];
}

/** Generated variable names — never model-controlled, always Lang-safe. */
function seriesVar(index: number): string {
  return `s${index + 1}`;
}

function datasetVar(index: number): string {
  return `d${index + 1}`;
}

function pointVar(dataset: number, index: number): string {
  return `p${dataset + 1}_${index + 1}`;
}

function columnVar(index: number): string {
  return `c${index + 1}`;
}

function lit(value: unknown): string {
  return JSON.stringify(value);
}

function linesFor(
  spec: OpenuiChartSpec,
  chartVar: string,
  define: string[],
): string {
  switch (spec.chart) {
    case "LineChart":
    case "BarChart": {
      const seriesVars = spec.series.map((_, index) => seriesVar(index));
      const args = [`labels`, `[${seriesVars.join(", ")}]`];
      if (spec.variant !== undefined) args.push(lit(spec.variant));
      if (spec.xLabel !== undefined || spec.yLabel !== undefined) {
        if (spec.variant === undefined) {
          args.push(lit(spec.chart === "LineChart" ? "linear" : "grouped"));
        }
        args.push(lit(spec.xLabel ?? ""), lit(spec.yLabel ?? ""));
      }
      if (spec.height !== undefined) {
        while (args.length < 4) args.push(lit(""));
        args.push(String(spec.height));
      }
      define.push(`${chartVar} = ${spec.chart}(${args.join(", ")})`);
      define.push(`labels = ${lit(spec.labels)}`);
      spec.series.forEach((series, index) => {
        define.push(
          `${seriesVars[index]} = Series(${lit(series.category)}, ${lit(series.values)})`,
        );
      });
      return chartVar;
    }
    case "PieChart": {
      const args = [`labels`, `values`];
      if (spec.variant !== undefined) args.push(lit(spec.variant));
      if (spec.appearance !== undefined) {
        if (spec.variant === undefined) args.push(lit("pie"));
        args.push(lit(spec.appearance));
      }
      define.push(`${chartVar} = PieChart(${args.join(", ")})`);
      define.push(`labels = ${lit(spec.labels)}`);
      define.push(`values = ${lit(spec.values)}`);
      return chartVar;
    }
    case "ScatterChart": {
      const vars = spec.datasets.map((_, index) => datasetVar(index));
      const args = [`[${vars.join(", ")}]`];
      if (spec.xLabel !== undefined || spec.yLabel !== undefined) {
        args.push(lit(spec.xLabel ?? ""), lit(spec.yLabel ?? ""));
      }
      define.push(`${chartVar} = ScatterChart(${args.join(", ")})`);
      spec.datasets.forEach((dataset, di) => {
        const points = dataset.points.map((_, pi) => pointVar(di, pi));
        define.push(
          `${vars[di]} = ScatterSeries(${lit(dataset.name)}, [${points.join(", ")}])`,
        );
        dataset.points.forEach((point, pi) => {
          const coords =
            point.z !== undefined
              ? `${point.x}, ${point.y}, ${point.z}`
              : `${point.x}, ${point.y}`;
          define.push(`${points[pi]} = Point(${coords})`);
        });
      });
      return chartVar;
    }
    case "Table": {
      const vars = spec.columns.map((_, index) => columnVar(index));
      define.push(`${chartVar} = Table([${vars.join(", ")}])`);
      spec.columns.forEach((column, index) => {
        const dataLit = lit(column.data);
        const withType =
          column.type !== undefined
            ? `Col(${lit(column.label)}, ${dataLit}, ${lit(column.type)})`
            : `Col(${lit(column.label)}, ${dataLit})`;
        define.push(`${vars[index]} = ${withType}`);
      });
      return chartVar;
    }
    case "None":
      return "";
  }
}

/**
 * Serialize a validated spec to OpenUI Lang. `None` specs (single scalar
 * or `no_data`) emit title + notes only — there is no chart to draw.
 */
export function serializeOpenuiLang(input: SerializeInput): string {
  const define: string[] = [];
  const title = input.title.slice(0, 200);
  define.push(`title = TextContent(${lit(title)}, "large-heavy")`);
  const parts = ["title"];
  if (input.spec.chart !== "None") {
    linesFor(input.spec, "chart", define);
    parts.push("chart");
  }
  const notes = (input.notes ?? []).filter((note) => note.trim() !== "");
  if (notes.length > 0) {
    define.push(`notes = TextContent(${lit(notes.join(" "))}, "default")`);
    parts.push("notes");
  }
  define.unshift(`root = Card([${parts.join(", ")}])`);
  return define.join("\n");
}
