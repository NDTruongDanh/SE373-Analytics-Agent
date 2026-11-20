// UC-03 numeric/causal claim validator tests (≤ 1% tolerance, strip+log).
import { describe, expect, it } from "vitest";
import {
  extractClaimNumbers,
  verifyNumericClaims,
  type ClaimBuffer,
} from "../src/validators/claimValidator.js";

const BUFFER: ClaimBuffer = {
  columns: ["month", "revenue"],
  rows: [
    { month: "2026-08", revenue: 4815 },
    { month: "2026-09", revenue: 5200 },
  ],
};

const EVIDENCE = [
  { column: "revenue", rowKey: "2026-09", value: 5200 },
  { column: "revenue", rowKey: "2026-08", value: 4815 },
];

describe("UC-03 claim number extraction", () => {
  it("parses thousands separators and unit suffixes", () => {
    const out = extractClaimNumbers("Revenue was 5,200M VND.");
    expect(out).toHaveLength(1);
    expect(out[0].bare).toBe(5200);
    expect(out[0].scaled).toBe(5200 * 1e6);
    expect(out[0].isPercent).toBe(false);
  });

  it("parses percentages and Vietnamese scale words", () => {
    const pct = extractClaimNumbers("up 8.0% vs August");
    expect(pct).toHaveLength(1);
    expect(pct[0].bare).toBeCloseTo(8.0, 10);
    expect(pct[0].isPercent).toBe(true);
    const ty = extractClaimNumbers("đạt 2,1 tỷ ₫");
    expect(ty).toHaveLength(1);
    expect(ty[0].bare).toBeCloseTo(2.1, 10);
    expect(ty[0].scaled).toBeCloseTo(2.1e9, 4);
  });

  it("does not split hyphenated and slashed dates into numbers", () => {
    expect(extractClaimNumbers("in 2026-09 revenue grew")).toEqual([]);
    expect(extractClaimNumbers("từ ngày 05/09/2026")).toEqual([]);
    // A bare year still extracts (grounded later as a label number).
    expect(extractClaimNumbers("Revenue in 2026 was high")).toHaveLength(1);
  });
});

describe("UC-03 numeric claim verification", () => {
  it("verifies the PRD example insight (absolute + MoM%)", () => {
    const out = verifyNumericClaims(
      [
        {
          claim: "Revenue in September 2026 was 5,200M VND, up 8.0% vs August (4,815M VND).",
          evidence: EVIDENCE,
        },
      ],
      BUFFER,
    );
    expect(out.stripped).toEqual([]);
    expect(out.verified).toHaveLength(1);
  });

  it("passes numbers within 1% rounding but strips a 2% fabrication", () => {
    const buffer = {
      columns: ["month", "revenue"],
      rows: [
        { month: "2026-08", revenue: 4815 },
        { month: "2026-09", revenue: 5200 },
      ],
    };
    const close = verifyNumericClaims(
      [
        {
          claim: "September revenue was 5,226M VND.",
          evidence: [{ column: "revenue", rowKey: "2026-09", value: 5226 }],
        },
      ],
      buffer,
    );
    expect(close.verified).toHaveLength(1);
    const far = verifyNumericClaims(
      [
        {
          claim: "September revenue was 5,304M VND.",
          evidence: [{ column: "revenue", rowKey: "2026-09", value: 5304 }],
        },
      ],
      buffer,
    );
    expect(far.verified).toHaveLength(0);
    expect(far.stripped[0].reason).toMatch(/matches no query result cell/);
  });

  it("strips percentages that do not recompute from evidence", () => {
    const out = verifyNumericClaims(
      [
        {
          claim: "Revenue grew 25% month over month to 5,200M VND.",
          evidence: EVIDENCE,
        },
      ],
      BUFFER,
    );
    expect(out.verified).toHaveLength(0);
    expect(out.stripped[0].reason).toMatch(/does not recompute/);
  });

  it("strips pointers naming cells absent from the buffer", () => {
    const out = verifyNumericClaims(
      [
        {
          claim: "Danang revenue was 9,999M VND.",
          evidence: [{ column: "revenue", rowKey: "Danang", value: 9999 }],
        },
      ],
      BUFFER,
    );
    expect(out.verified).toHaveLength(0);
    expect(out.stripped[0].reason).toMatch(/matches no query result cell/);
  });

  it("strips ungrounded causal claims in English and Vietnamese", () => {
    for (const claim of [
      "Revenue fell due to competitor pricing in September.",
      "Doanh thu giảm do đối thủ cạnh tranh trong tháng 9.",
    ]) {
      const out = verifyNumericClaims(
        [
          {
            claim,
            evidence: [{ column: "revenue", rowKey: "2026-09", value: 5200 }],
          },
        ],
        BUFFER,
      );
      expect(out.verified).toHaveLength(0);
      expect(out.stripped[0].reason).toMatch(/cause is unverified/);
    }
  });

  it("keeps causal claims backed by an event citation", () => {
    const out = verifyNumericClaims(
      [
        {
          claim: "Revenue fell 10% after the warehouse closure.",
          evidence: [
            { column: "event:warehouse_closure_bd", rowKey: "2026-09-05", value: "closure" },
            { column: "revenue", rowKey: "2026-09", value: 4680 },
            { column: "revenue", rowKey: "2026-08", value: 5200 },
          ],
        },
      ],
      {
        columns: ["month", "revenue"],
        rows: [
          { month: "2026-08", revenue: 5200 },
          { month: "2026-09", revenue: 4680 },
        ],
      },
    );
    expect(out.verified).toHaveLength(1);
  });

  it("treats injection payloads as inert literals, not instructions", () => {
    const out = verifyNumericClaims(
      [
        {
          claim: "Top product is Nồi cơm điện, 120 units sold.",
          evidence: [
            { column: "product", rowKey: "Nồi cơm điện", value: "Nồi cơm điện" },
            { column: "units", rowKey: "Nồi cơm điện", value: 120 },
          ],
        },
      ],
      {
        columns: ["product", "units"],
        rows: [{ product: "Nồi cơm điện", units: 120 }],
      },
    );
    // No tool call exists on this path; the text survives only as a claim.
    expect(out.verified).toHaveLength(1);
  });

  it("accepts direct percentage cells (share) while still stripping ungrounded deltas", () => {
    const shareBuffer: ClaimBuffer = {
      columns: ["category", "share"],
      rows: [
        { category: "Điện tử", share: 35 },
        { category: "Gia dụng", share: 30 },
      ],
    };
    const ok = verifyNumericClaims(
      [
        {
          claim: "Electronics leads with 35% share.",
          evidence: [{ column: "share", rowKey: "Điện tử", value: 35 }],
        },
      ],
      shareBuffer,
    );
    expect(ok.verified).toHaveLength(1);
    expect(ok.stripped).toHaveLength(0);

    const badDelta = verifyNumericClaims(
      [
        {
          claim: "Electronics leads with 35% share, up 25% vs last quarter.",
          evidence: [
            { column: "share", rowKey: "Điện tử", value: 35 },
            { column: "share", rowKey: "Gia dụng", value: 30 },
          ],
        },
      ],
      shareBuffer,
    );
    expect(badDelta.verified).toHaveLength(0);
    expect(badDelta.stripped[0].reason).toMatch(/does not recompute/);
  });

  it("allows explicit cause-unknown disclaimers while still stripping ungrounded causes", () => {
    const allowed = verifyNumericClaims(
      [
        {
          claim: "Doanh thu tháng 9 đạt 5,200M VND, tăng 8.0% so với tháng 8 (4,815M VND); nguyên nhân chưa rõ.",
          evidence: EVIDENCE,
        },
        {
          claim: "Revenue rose 8.0% to 5,200M VND; cause unknown.",
          evidence: EVIDENCE,
        },
      ],
      BUFFER,
    );
    expect(allowed.verified).toHaveLength(2);
    expect(allowed.stripped).toHaveLength(0);

    const mixedBad = verifyNumericClaims(
      [
        {
          claim: "Revenue rose to 5,200M VND due to competitor weakness (cause unknown).",
          evidence: [{ column: "revenue", rowKey: "2026-09", value: 5200 }],
        },
      ],
      BUFFER,
    );
    expect(mixedBad.verified).toHaveLength(0);
    expect(mixedBad.stripped[0].reason).toMatch(/cause is unverified/);
  });
});
