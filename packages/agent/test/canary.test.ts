import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MASKED_EMAIL, MASKED_PHONE } from "@se373/access-policy";
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
});
