// UC-03 sample trace writer: drives the VIZ seam over the insight-01
// fixture (12-month line, verified absolute + MoM% claims) with a scripted
// Profile-3 model and records the spans through the real redacted span
// emitter into traces/uc03/. Run once via:
//   pnpm exec tsx evals/uc03/write-trace.ts
// The committed jsonl is the UC-03 Definition-of-Done trace (select ->
// synthesize -> validate -> verified AgentResponse). Fixture data is fake
// vi_VN retail data; the writer redacts before disk write regardless.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSpanEmitter } from "../../packages/agent/src/telemetry/spans.js";
import { createUc03Viz } from "../../packages/agent/src/subgraphs/uc03/viz.js";
import { VizDraftSchema } from "../../packages/agent/src/subgraphs/uc03/synthesize.js";
import type { AgentState, RootRuntime } from "../../packages/agent/src/state.js";

const RUN_ID = "c03a5f1e-7b2d-4c8e-9f0a-1b2c3d4e5f60";
const THREAD_ID = `chat:eval:${RUN_ID}`;
const TRACES_DIR = path.join("traces", "uc03");

interface InsightFixture {
  id: string;
  question: string;
  status: string;
  columns: string[];
  rows: Record<string, unknown>[];
  draft: unknown;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const fixtures = readFileSync(path.join(repoRoot, "evals", "uc03", "insights.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as InsightFixture);
  const fixture = fixtures.find((item) => item.id === "uc03-insight-01");
  if (!fixture) throw new Error("uc03-insight-01 fixture missing");

  const emit = createSpanEmitter({
    runId: RUN_ID,
    threadId: THREAD_ID,
    userId: "eval",
    role: "sales_south",
    tracesDir: TRACES_DIR,
  });
  const rt = {
    emit: (event: { node: string; type: string; durationMs: number; payload?: unknown }) =>
      emit(event),
    config: { configurable: {} },
  } as unknown as RootRuntime;

  const draft = VizDraftSchema.parse(fixture.draft);
  const model = {
    withStructuredOutput: () => ({
      invoke: async (input: string) => {
        if (!input.includes("<untrusted_data>")) {
          throw new Error("synthesis prompt lost its row delimiters");
        }
        return draft;
      },
    }),
  };

  const state = {
    question: fixture.question,
    ucId: "uc03-eval",
    intent: {
      metric: null,
      dimensions: [],
      filters: [],
      timeRange: null,
      requestedMetrics: [],
      schemaEntities: [],
      queryMode: "standard_query",
    },
    semanticChunks: [],
    resultPreview: fixture.rows,
    columns: fixture.columns,
    sql: "SELECT month, revenue FROM orders GROUP BY month",
    tablesUsed: ["orders"],
    toolsCalled: ["describe_table", "run_query"],
    status: fixture.status,
    answerText: "",
    budget: { llmCalls: 1, tokensUsed: 100, maxLlmCalls: 20, maxTokens: 60000, deadlineMs: 0 },
    telemetry: { promptTokens: 0, completionTokens: 0, latencyMs: 0 },
    runId: RUN_ID,
    threadId: THREAD_ID,
    vizSpec: null,
    pendingClarification: null,
    analysisPlan: null,
    rootCauseAnswer: null,
  } as unknown as AgentState;

  const out = await createUc03Viz({ model })(state, rt);
  const spec = out.vizSpec as { report: { chartType: string; insights: unknown[] } };
  emit.emitRunDone("ok");
  console.log(
    `trace ${TRACES_DIR}/${RUN_ID}.jsonl chart=${spec.report.chartType} insights=${spec.report.insights.length}`,
  );
}

await main();
