import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createChatModel } from "../src/models/factory.js";
import { TRACER_SQL_PROPOSAL } from "../src/constants.js";
import { writeTraceEvent } from "../src/traces/writer.js";
import { previewCountKey, previewCountTotal } from "../src/subgraphs/previewCount.js";

// Former tracer-slice tests for the removed runTracerGraph/default-entry
// surface are gone with the router refactor (#98). What remains covers
// still-existing behavior: the keyless fake model proposal, the
// previewCount helpers (now in subgraphs/previewCount.ts), and PII
// redaction in writer output. No DB, no API key needed.

const SEED_PHONES = ["0901111111", "0905555555"];
const SEED_EMAIL = "an.nguyen@example.vn";

function threeRows() {
  return [
    { status: "cancelled", n: 2 },
    { status: "completed", n: 7 },
    { status: "pending", n: 3 },
  ];
}

describe("tracer slice remnants", () => {
  it("proposes the canned SQL through the fake model by default", async () => {
    const model = createChatModel();
    const proposal = await model.proposeSql("How many orders do we have per status?");
    expect(proposal).toEqual(TRACER_SQL_PROPOSAL);
  });

  it("previewCountTotal reads n, a live alias, or nothing numeric", () => {
    const aliased = [
      { status: "a", order_count: "10" },
      { status: "b", order_count: "5" },
    ];
    expect(previewCountTotal(["status", "order_count"], aliased)).toBe(15);
    expect(previewCountTotal(["status", "n"], threeRows())).toBe(12);
    expect(previewCountTotal(["status"], [{ status: "a" }])).toBe(0);
    expect(previewCountTotal(["status", "n"], [])).toBe(0);
  });

  it("previewCountKey ignores boolean, null, and empty columns", () => {
    // Number(true), Number(null), and Number("") are all finite: the old
    // Number.isFinite(Number(...)) probe picked these as count columns.
    expect(
      previewCountKey(
        ["status", "active"],
        [
          { status: "a", active: true },
          { status: "b", active: false },
        ],
      ),
    ).toBe("n");
    expect(
      previewCountKey(["region", "x"], [{ region: "s", x: null }]),
    ).toBe("n");
    expect(previewCountKey(["region", "x"], [{ region: "s", x: "" }])).toBe(
      "n",
    );
  });

  it("previewCountKey prefers count names, then the first all-numeric column", () => {
    expect(
      previewCountKey(
        ["id", "status", "order_count"],
        [
          { id: 1, status: "a", order_count: "10" },
          { id: 2, status: "b", order_count: "5" },
        ],
      ),
    ).toBe("order_count");
    expect(
      previewCountKey(["status", "total"], [{ status: "a", total: 7 }]),
    ).toBe("total");
    expect(
      previewCountKey(
        ["status", "num_orders"],
        [{ status: "a", num_orders: "3" }],
      ),
    ).toBe("num_orders");
    expect(
      previewCountKey(["status", "count"], [{ status: "a", count: 4 }]),
    ).toBe("count");
    // An id column wins only as a last resort over genuinely numeric values.
    expect(
      previewCountKey(
        ["id", "status"],
        [
          { id: 1, status: "a" },
          { id: 2, status: "b" },
        ],
      ),
    ).toBe("id");
    // A count-named column with non-numeric values falls through to "n".
    expect(
      previewCountKey(["status", "total"], [{ status: "a", total: "high" }]),
    ).toBe("n");
  });

  it("masks raw seed PII in writer output", () => {
    const tracesDir = mkdtempSync(path.join(tmpdir(), "tracer-agent-"));
    const runId = "run-pii-1";
    writeTraceEvent(
      {
        runId,
        threadId: "t1",
        userId: "demo-user",
        role: "sales_south",
        node: "run",
        type: "tool_call",
        durationMs: 1,
        payload: { leak: `call ${SEED_PHONES[0]} or ${SEED_EMAIL}` },
      },
      tracesDir,
    );
    const content = readFileSync(path.join(tracesDir, `${runId}.jsonl`), "utf8");
    expect(content).toContain("MASKED_PHONE");
    expect(content).toContain("MASKED_EMAIL");
    for (const phone of SEED_PHONES) {
      expect(content).not.toContain(phone);
    }
    expect(content).not.toContain(SEED_EMAIL);
  });
});
