import { describe, expect, it } from "vitest";
import { chatReducer, clarificationFrom, initialChat } from "../src/chat.js";
import type { SseProgressEvent } from "@shared/contracts";

const event = (name: SseProgressEvent["event"], data: unknown, runId = "run-1", threadId = "thread-1"): SseProgressEvent =>
  ({ event: name, runId, threadId, data });

describe("chat state", () => {
  it("supports legacy and structured clarification payloads", () => {
    expect(clarificationFrom({ pendingClarification: ["A", "B"] })?.options).toEqual(["A", "B"]);
    expect(clarificationFrom({ pendingClarification: { question: "Chọn?", options: ["A", "B"] } })?.question).toBe("Chọn?");
    expect(clarificationFrom({ pendingClarification: ["A"] })).toBeNull();
    expect(clarificationFrom({ pendingClarification: ["A", "B", "C", "D", "E"] })).toBeNull();
  });

  it("keeps run and thread over clarification and resume", () => {
    let state = chatReducer(initialChat, { type: "start" });
    state = chatReducer(state, { type: "event", event: event("interrupt_waiting", { pendingClarification: ["A", "B"] }) });
    expect(state.phase).toBe("waiting");
    state = chatReducer(state, { type: "resume" });
    state = chatReducer(state, { type: "event", event: event("completed", { answerText: "Done" }) });
    expect(state).toMatchObject({ runId: "run-1", threadId: "thread-1", phase: "completed", answer: "Done" });
  });

  it("fails closed on mismatched identity and malformed options", () => {
    let state = chatReducer(initialChat, { type: "event", event: event("intent_parsed", {}) });
    state = chatReducer(state, { type: "event", event: event("completed", {}, "another") });
    expect(state.phase).toBe("failed");
    expect(chatReducer(initialChat, { type: "event", event: event("interrupt_waiting", {}) }).phase).toBe("failed");
  });

  it("accepts result detail only when it validates as SQLAnswer", () => {
    const answer = { intent: { metric: null, dimensions: [], filters: [], timeRange: null }, sql: "SELECT 1", tablesUsed: [], citations: [], attempts: [], resultPreview: [], answerText: "Done", status: "ok", telemetry: { promptTokens: 0, completionTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0, latencyMs: 0 } };
    expect(chatReducer(initialChat, { type: "event", event: event("completed", { answer }) }).answerDetail?.sql).toBe("SELECT 1");
    expect(chatReducer(initialChat, { type: "event", event: event("completed", { answer: { ...answer, resultPreview: new Array(51).fill({}) } }) }).answerDetail).toBeNull();
  });
});
