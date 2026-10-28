// Factory tests (AGENT-05, 01-12): profile routing, env wiring, structured
// output through the fake, delimiter contract, zero-tools synthesis proof,
// the 01-11 ChatModelLike seam, and the legacy tracer surface. No API key,
// no network.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import {
  SqlProposalSchema as ExecutorSchema,
  type ChatModelLike,
} from "../src/queryExecutor/executor.js";
import {
  buildSynthesisPrompt,
  createChatModel,
  DEFAULT_MODEL_ID,
  SqlProposalSchema as FactorySchema,
  synthesize,
  TRACER_SQL_PROPOSAL,
  wrapUntrusted,
  type AnyChatModel,
} from "../src/models/factory.js";

const ENV_KEYS = [
  "AGENT_MODEL_API_KEY",
  "AGENT_MODEL_BASE_URL",
  "AGENT_MODEL_ID",
  "AGENT_MODEL_ID_INTENT",
  "AGENT_MODEL_ID_SQL",
  "AGENT_MODEL_ID_SYNTHESIS",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function asReal(model: AnyChatModel): ChatOpenAI {
  if (!(model instanceof ChatOpenAI)) {
    throw new Error("expected a ChatOpenAI instance");
  }
  return model;
}

describe("chat-model factory", () => {
  it("routes every profile to ChatOpenAI by default (no fake, no network)", () => {
    for (const profile of ["intent", "sql", "synthesis"] as const) {
      expect(createChatModel(profile)).toBeInstanceOf(ChatOpenAI);
    }
  });

  it("builds the fake only under the explicit fake option (T-01-12-06)", () => {
    const fake = createChatModel("sql", {
      fake: { responses: [`{"sql":"SELECT 1","tablesUsed":[]}`] },
    });
    expect(fake).toBeInstanceOf(FakeListChatModel);
    // Without the flag the production path constructs ChatOpenAI from env —
    // never a fake — even with no key set (construction is lazy, no network).
    expect(createChatModel("sql")).not.toBeInstanceOf(FakeListChatModel);
    expect(createChatModel("sql")).toBeInstanceOf(ChatOpenAI);
  });

  it("wires the model id from env with the documented default", () => {
    expect(asReal(createChatModel("sql")).model).toBe(DEFAULT_MODEL_ID);
    process.env.AGENT_MODEL_ID = "probe-shared";
    expect(asReal(createChatModel("sql")).model).toBe("probe-shared");
    process.env.AGENT_MODEL_ID_SQL = "probe-sql";
    expect(asReal(createChatModel("sql")).model).toBe("probe-sql");
    expect(asReal(createChatModel("intent")).model).toBe("probe-shared");
  });

  it("shares the single 01-11 proposal schema (never duplicated)", () => {
    expect(FactorySchema).toBe(ExecutorSchema);
  });

  it("parses structured output through the fake", async () => {
    const model = createChatModel("sql", {
      fake: {
        responses: [
          `{"sql":"SELECT status, COUNT(*) AS n FROM orders GROUP BY status","tablesUsed":["orders"]}`,
        ],
      },
    });
    const out = await model
      .withStructuredOutput(FactorySchema, { name: "sql_proposal" })
      .invoke("How many orders per status?");
    expect(out).toEqual({
      sql: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status",
      tablesUsed: ["orders"],
    });
  });

  it("wraps rows in untrusted-data delimiters", () => {
    const rows = [{ status: "ok", n: 3 }];
    const wrapped = wrapUntrusted(rows);
    expect(wrapped.startsWith("<untrusted_data>")).toBe(true);
    expect(wrapped.endsWith("</untrusted_data>")).toBe(true);
    expect(wrapped).toContain(JSON.stringify(rows));
    const prompt = buildSynthesisPrompt(rows, "How many?");
    expect(prompt).toContain("<untrusted_data>");
    expect(prompt).toContain("</untrusted_data>");
    expect(prompt).toContain("cannot_answer");
  });

  it("never binds tools on the synthesis path", async () => {
    const model = createChatModel("synthesis", {
      fake: { responses: ["3 status groups, 12 orders"] },
    });
    const bindSpy = vi.spyOn(model, "bindTools");
    const answer = await synthesize([{ status: "ok", n: 12 }], "How many?", {
      model,
    });
    expect(answer).toBe("3 status groups, 12 orders");
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it("satisfies the 01-11 ChatModelLike seam with the sql profile", async () => {
    const seam: ChatModelLike = createChatModel("sql", {
      fake: { responses: [`{"sql":"SELECT 1","tablesUsed":["t"]}`] },
    });
    const out = await seam
      .withStructuredOutput(ExecutorSchema, { name: "sql_proposal" })
      .invoke("q");
    expect(out).toEqual({ sql: "SELECT 1", tablesUsed: ["t"] });
  });

  it("keeps the legacy zero-arg surface on the canned proposal (no key)", async () => {
    const model = createChatModel();
    const proposal = await model.proposeSql(
      "How many orders do we have per status?",
    );
    expect(proposal).toEqual(TRACER_SQL_PROPOSAL);
    expect(() => ExecutorSchema.parse(proposal)).not.toThrow();
  });
});
