import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MASKED_EMAIL, MASKED_PHONE } from "@shared/access-policy";
import { appendTraceEvent } from "../src/traces/writer.js";

// OBS-01 canary: synthetic Vietnamese PII in spaced and compact forms must
// never survive to disk. Values are invented for this proof (never seed
// data) so the DB-07 seed-hiding scan stays green.

const CANARY_PHONES = [
  "0912 345 678", // mobile spaced 4-3-3
  "0912345678", // mobile compact
  "033 456 7890", // mobile 03 spaced
  "+84912345678", // international compact
  "024 3123 4567", // landline spaced
];
const CANARY_EMAILS = ["canary.k27@example.vn", "k27.canary@example.com"];

// New Phase-3 payload shapes whose string slots must stay covered by the
// same redact-before-write guarantee (counts and column names only by
// construction; the writer is the backstop if a string ever slips in).
const CANARY_MODEL = "openai/gpt-oss-120b";

describe("OBS-01 PII canary", () => {
  it("lets no raw canary literal reach disk while markers do", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-canary-"));
    for (const phone of CANARY_PHONES) {
      appendTraceEvent(
        {
          runId: "run-canary-1",
          threadId: "thread-canary",
          userId: "demo-user",
          role: "sales_south",
          node: "answer",
          type: "synthesis",
          durationMs: 2,
          payload: { text: `khach hang ${phone} can ho tro` },
        },
        dir,
      );
    }
    for (const email of CANARY_EMAILS) {
      appendTraceEvent(
        {
          runId: "run-canary-1",
          threadId: "thread-canary",
          userId: "demo-user",
          role: "hr",
          node: "answer",
          type: "synthesis",
          durationMs: 2,
          payload: { text: `lien he ${email} de xac minh` },
        },
        dir,
      );
    }
    const content = readFileSync(
      path.join(dir, "run-canary-1.jsonl"),
      "utf8",
    );
    for (const phone of CANARY_PHONES) {
      expect(content).not.toContain(phone);
    }
    for (const email of CANARY_EMAILS) {
      expect(content).not.toContain(email);
    }
    expect(content).toContain(MASKED_PHONE);
    expect(content).toContain(MASKED_EMAIL);
  });

  it("redacts canaries in the new llm_call and RBAC tool_call payloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "traces-canary-g5g1-"));
    const phone = CANARY_PHONES[0] as string;
    const email = CANARY_EMAILS[0] as string;
    appendTraceEvent(
      {
        runId: "run-canary-2",
        threadId: "thread-canary",
        userId: "demo-user",
        role: "sales_south",
        node: "propose",
        type: "llm_call",
        durationMs: 12,
        payload: {
          model: CANARY_MODEL,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: 0.00045,
          pricingKnown: true,
          // Backstop proof: even a free-text slot carrying PII is masked.
          detail: `tong dai ${phone} hoac ${email}`,
        },
      },
      dir,
    );
    appendTraceEvent(
      {
        runId: "run-canary-2",
        threadId: "thread-canary",
        userId: "demo-user",
        role: "sales_south",
        node: "run",
        type: "tool_call",
        durationMs: 4,
        payload: {
          tool: "run_query",
          rowCount: 1,
          maskedColumns: ["customers.phone"],
          rowScopeApplied: [{ table: "sellers", column: "region_group" }],
          filter: `region_group = '${phone}'`,
        },
      },
      dir,
    );
    const content = readFileSync(
      path.join(dir, "run-canary-2.jsonl"),
      "utf8",
    );
    expect(content).not.toContain(phone);
    expect(content).not.toContain(email);
    expect(content).toContain(MASKED_PHONE);
    expect(content).toContain(MASKED_EMAIL);
    // Structural fields survive redaction: names and counts, never values.
    expect(content).toContain("customers.phone");
    expect(content).toContain("region_group");
    expect(content).toContain(CANARY_MODEL);
  });
});
