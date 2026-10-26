import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TraceEventSchema } from "@se373/contracts";
import { MASKED_EMAIL, MASKED_PHONE } from "@se373/access-policy";
import { appendTraceEvent } from "../src/traces/writer.js";

// TraceWriter suite: span linkage survives the round trip, every
// research-listed phone/email shape comes back marker-only with source
// literals absent, and the file parses as one event per line.

const PHONES = [
  "0901 234 567", // mobile spaced
  "0901234567", // mobile compact
  "032 123 4567", // mobile 03 spaced
  "0587654321", // mobile 05 compact
  "0285 8212 0590", // landline spaced
  "028582120590", // landline compact
  "024 0590 1799", // national 024 spaced
  "+84901234567", // international compact
  "+84 901 234 567", // international spaced
  "0901.234.567", // dotted separators
  "0901-234-567", // dashed separators
];
const EMAIL = "lan@example.com";

function baseEvent(runId: string, payload?: unknown) {
  return {
    runId,
    threadId: "thread-1",
    userId: "demo-user",
    role: "sales_south",
    node: "run",
    type: "tool_call",
    durationMs: 1,
    payload,
  };
}

describe("TraceWriter", () => {
  it("keeps span linkage fields through the round trip", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-link-"));
    const parent = appendTraceEvent(baseEvent("run-link-1"), dir);
    const child = appendTraceEvent(
      { ...baseEvent("run-link-1"), parentSpanId: parent.spanId, attempt: 1 },
      dir,
    );
    const lines = readFileSync(path.join(dir, "run-link-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const [parsedParent, parsedChild] = lines.map((line) =>
      TraceEventSchema.parse(JSON.parse(line)),
    );
    expect(parsedParent.spanId).toBe(parent.spanId);
    expect(parsedParent.parentSpanId).toBeUndefined();
    expect(parsedChild.parentSpanId).toBe(parent.spanId);
    expect(parsedChild.spanId).toBe(child.spanId);
    expect(parsedChild.attempt).toBe(1);
  });

  it.each(PHONES)("redacts phone shape %s with the shared marker", (phone) => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-phone-"));
    const result = appendTraceEvent(
      baseEvent("run-phone-1", { customer: `lien he ${phone} nhe` }),
      dir,
    );
    expect(result.redacted).toBe(true);
    const content = readFileSync(path.join(dir, "run-phone-1.jsonl"), "utf8");
    expect(content).toContain(MASKED_PHONE);
    expect(content).not.toContain(phone);
  });

  it("redacts email addresses with the shared marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-email-"));
    const result = appendTraceEvent(
      baseEvent("run-email-1", { contact: `mail ${EMAIL} di` }),
      dir,
    );
    expect(result.redacted).toBe(true);
    const content = readFileSync(path.join(dir, "run-email-1.jsonl"), "utf8");
    expect(content).toContain(MASKED_EMAIL);
    expect(content).not.toContain(EMAIL);
  });

  it("redacts row-array payloads cell by cell", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-rows-"));
    appendTraceEvent(
      baseEvent("run-rows-1", [
        { status: "completed", phone: "0901234567" },
        { status: "pending", phone: "none" },
      ]),
      dir,
    );
    const content = readFileSync(path.join(dir, "run-rows-1.jsonl"), "utf8");
    expect(content).toContain(MASKED_PHONE);
    expect(content).not.toContain("0901234567");
  });

  it("leaves clean payloads untouched with hit false", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-clean-"));
    const result = appendTraceEvent(
      baseEvent("run-clean-1", { total: 42 }),
      dir,
    );
    expect(result.redacted).toBe(false);
    const content = readFileSync(path.join(dir, "run-clean-1.jsonl"), "utf8");
    expect(content).toContain('"total":42');
  });

  it("writes one contract-valid event per line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-lines-"));
    for (let i = 0; i < 3; i += 1) {
      appendTraceEvent(baseEvent("run-lines-1", { i }), dir);
    }
    const lines = readFileSync(path.join(dir, "run-lines-1.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = TraceEventSchema.parse(JSON.parse(line));
      expect(parsed.runId).toBe("run-lines-1");
      expect(parsed.spanId).toBeDefined();
    }
  });
});
