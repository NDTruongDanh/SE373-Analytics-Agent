// Chat-model factory (AGENT-05, 01-12): three OpenAI-compatible profiles on
// ChatOpenAI configuration routing, plus an explicit fake for tests and CI.
// Profile intent proposes plans, profile sql proposes structured SQL, profile
// synthesis writes the final answer. The synthesis path never binds tools
// (architecture invariant section 1.2.3) and every row entering a prompt is
// wrapped in <untrusted_data> delimiters. The 01-01 fetch-based stub is gone:
// keyed runs construct ChatOpenAI; keyless runs fall back to the canned fake
// only through the legacy zero-arg surface below.

import { FakeListChatModel } from "@langchain/core/utils/testing";
import { ChatOpenAI } from "@langchain/openai";
import * as z from "zod";
import {
  SqlProposalSchema,
  type SqlProposal,
} from "../queryExecutor/executor.js";

// The SQL proposal shape stays owned by the 01-11 executor (single source);
// this module re-exports it for the legacy tracer surface, never duplicates it.
export { SqlProposalSchema };
export type { SqlProposal };

// Legacy tracer-compatible surface, consumed by the 01-10 default route
// (subgraphs/registry.ts) and tracer.test.ts until 01-14 replaces the demo.
export const TRACER_DEMO_QUESTION = "How many orders do we have per status?";

export const TRACER_SQL_PROPOSAL = {
  sql: "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status",
  tablesUsed: ["orders"],
};

export interface TracerChatModel {
  proposeSql(question: string): Promise<SqlProposal>;
}

/** The three model profiles (agent research Pattern 4). */
export type ModelProfile = "intent" | "sql" | "synthesis";

/** Explicit fake spec: canned JSON responses, no API key needed. */
export interface FakeModelSpec {
  responses: string[];
}

export interface CreateChatModelOptions {
  /** Presence selects FakeListChatModel; absence selects ChatOpenAI. */
  fake?: FakeModelSpec;
  /** Model id override; otherwise resolved from the environment. */
  model?: string;
}

/**
 * Documented default model id when neither AGENT_MODEL_ID nor the
 * per-profile AGENT_MODEL_ID_<PROFILE> override is set.
 */
export const DEFAULT_MODEL_ID = "agent-default";

/** Either production ChatOpenAI or the explicit test fake. */
export type AnyChatModel = ChatOpenAI | FakeListChatModel;

function resolveModelId(profile: ModelProfile, override?: string): string {
  return (
    override ??
    process.env[`AGENT_MODEL_ID_${profile.toUpperCase()}`] ??
    process.env.AGENT_MODEL_ID ??
    DEFAULT_MODEL_ID
  );
}

function buildRealModel(profile: ModelProfile, override?: string): ChatOpenAI {
  const baseURL = (process.env.AGENT_MODEL_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.AGENT_MODEL_API_KEY ?? "";
  return new ChatOpenAI({
    model: resolveModelId(profile, override),
    temperature: 0,
    configuration: { baseURL, apiKey },
  });
}

class ProfileTracerModel implements TracerChatModel {
  constructor(private readonly model: AnyChatModel) {}

  async proposeSql(question: string): Promise<SqlProposal> {
    const out = await withStructured(this.model, SqlProposalSchema, {
      name: "sql_proposal",
    }).invoke(question);
    // Fail-closed: every proposal path goes through schema validation.
    return SqlProposalSchema.parse(out);
  }
}

function legacyTracerModel(): TracerChatModel {
  if (process.env.AGENT_MODEL_API_KEY) {
    return new ProfileTracerModel(buildRealModel("sql"));
  }
  return new ProfileTracerModel(
    new FakeListChatModel({
      responses: [JSON.stringify(TRACER_SQL_PROPOSAL)],
    }),
  );
}

export function createChatModel(): TracerChatModel;
export function createChatModel(
  profile: ModelProfile,
  opts?: CreateChatModelOptions,
): AnyChatModel;
export function createChatModel(
  profile?: ModelProfile,
  opts: CreateChatModelOptions = {},
): TracerChatModel | AnyChatModel {
  if (profile === undefined) {
    return legacyTracerModel();
  }
  if (opts.fake) {
    return new FakeListChatModel({ responses: [...opts.fake.responses] });
  }
  return buildRealModel(profile, opts.model);
}

/**
 * Structured-output helper taking a caller-supplied zod schema (the SQL
 * proposal schema itself is owned by the 01-11 executor, never duplicated
 * here). Returns a narrow invoke surface so callers never touch the raw
 * runnable type.
 */
export function withStructured<S extends z.ZodType>(
  model: AnyChatModel,
  schema: S,
  opts?: { name?: string },
): { invoke(input: string): Promise<z.infer<S>> } {
  return {
    invoke: async (input: string): Promise<z.infer<S>> => {
      const structured =
        model instanceof ChatOpenAI
          ? model.withStructuredOutput(schema, opts)
          : model.withStructuredOutput(schema, opts);
      const out = await structured.invoke(input);
      return schema.parse(out);
    },
  };
}

/** Delimiter tags marking query rows as untrusted data (never instructions). */
export const UNTRUSTED_DATA_OPEN = "<untrusted_data>";
export const UNTRUSTED_DATA_CLOSE = "</untrusted_data>";

/** Enclose result rows so row text can never become an instruction. */
export function wrapUntrusted(rows: Record<string, unknown>[]): string {
  return `${UNTRUSTED_DATA_OPEN}${JSON.stringify(rows)}${UNTRUSTED_DATA_CLOSE}`;
}

/**
 * Build the synthesis prompt: the question plus delimited rows, with an
 * explicit no-fabrication rule. Pure (no model call) so tests assert the
 * delimiter contract without a key.
 */
export function buildSynthesisPrompt(
  rows: Record<string, unknown>[],
  question: string,
): string {
  return [
    "Answer the question using ONLY the rows below. Do not invent values;",
    "if the rows cannot answer the question, reply cannot_answer.",
    `Question: ${question}`,
    `Rows: ${wrapUntrusted(rows)}`,
  ].join("\n");
}

/**
 * Synthesis entry point: builds the delimited prompt and invokes the
 * profile-3 model directly. Never calls the tool-binding method on this path
 * (architecture invariant: zero tools bound over untrusted data).
 */
export async function synthesize(
  rows: Record<string, unknown>[],
  question: string,
  opts?: { model?: AnyChatModel },
): Promise<string> {
  const model = opts?.model ?? createChatModel("synthesis");
  const result = await model.invoke(buildSynthesisPrompt(rows, question));
  const content = result.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}
