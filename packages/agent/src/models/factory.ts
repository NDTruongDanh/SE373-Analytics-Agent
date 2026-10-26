import * as z from "zod";
import { FakeListChatModel } from "@langchain/core/utils/testing";

// TRACER model factory (AGENT-05 slice). Default: a deterministic fake with a
// canned structured SQL proposal, so no API key is needed. Only when
// AGENT_MODEL_API_KEY is set, a minimal fetch-based OpenAI-compatible
// chat-completions call is used (no new dependency). The @langchain/openai
// profiles plus the beforeToolCall fork land in 01-12.

export const TRACER_DEMO_QUESTION = "How many orders do we have per status?";

export const TRACER_SQL_PROPOSAL = {
  sql: "SELECT status, COUNT(*) AS n FROM public.orders GROUP BY status ORDER BY status",
  tablesUsed: ["orders"],
};

// TRACER structured-proposal shape. The shared executor proposal schema
// (01-11) replaces this.
export const SqlProposalSchema = z.object({
  sql: z.string().min(1),
  tablesUsed: z.array(z.string()),
});

export type SqlProposal = z.infer<typeof SqlProposalSchema>;

export interface TracerChatModel {
  proposeSql(question: string): Promise<SqlProposal>;
}

class FakeTracerModel implements TracerChatModel {
  private readonly inner = new FakeListChatModel({
    responses: [JSON.stringify(TRACER_SQL_PROPOSAL)],
  });

  async proposeSql(question: string): Promise<SqlProposal> {
    const out = await this.inner
      .withStructuredOutput(SqlProposalSchema, { name: "sql_proposal" })
      .invoke(question);
    // Fail-closed: the fake path still goes through schema validation.
    return SqlProposalSchema.parse(out);
  }
}

class FetchTracerModel implements TracerChatModel {
  async proposeSql(question: string): Promise<SqlProposal> {
    const baseUrl = (process.env.AGENT_MODEL_BASE_URL ?? "").replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("AGENT_MODEL_BASE_URL is not set");
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.AGENT_MODEL_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.AGENT_MODEL_ID ?? "tracer-default",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: `Propose read-only SQL as JSON {"sql": "...", "tablesUsed": [...]} for: ${question}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`model request failed with HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    return SqlProposalSchema.parse(JSON.parse(content));
  }
}

export function createChatModel(): TracerChatModel {
  if (process.env.AGENT_MODEL_API_KEY) {
    return new FetchTracerModel();
  }
  return new FakeTracerModel();
}
