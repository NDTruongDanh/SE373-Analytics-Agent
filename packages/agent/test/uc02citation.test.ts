// UC-02 CitationValidator tests: 100% validity + SQL header + <= 2 repairs.
import { describe, expect, it } from "vitest";
import {
  deriveCitations,
  ensureCitationHeader,
  parseCitationHeader,
  repairCitations,
  validateCitations,
  CITATION_REPAIR_LIMIT,
} from "../src/validators/citationValidator.js";

const RETRIEVED = ["metric:net_revenue", "column:orders.status", "join_rule:orders_order_items"];
const CATALOG = [
  "metric:net_revenue",
  "metric:aov",
  "column:orders.status",
  "orders.status",
  "join_rule:orders_order_items",
  "table:orders",
];

describe("UC-02 CitationValidator", () => {
  it("caps repairs at 2", () => {
    expect(CITATION_REPAIR_LIMIT).toBe(2);
  });

  it("accepts valid citations and prepends the SQL header", () => {
    const out = validateCitations({
      citations: ["metric:net_revenue", "column:orders.status"],
      sql: "SELECT SUM(x) FROM t",
      requestedMetrics: ["doanh thu thuần"],
      retrievedChunkIds: RETRIEVED,
      catalogIds: CATALOG,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.sql).toMatch(/^-- @citations: /);
      expect(out.sql).toMatch(/metric:net_revenue/);
      expect(parseCitationHeader(out.sql)).toEqual(
        expect.arrayContaining(["metric:net_revenue", "column:orders.status"]),
      );
    }
  });

  it("accepts column-variant citations (orders.status <-> column:orders.status)", () => {
    const out = validateCitations({
      citations: ["orders.status"],
      sql: "SELECT 1",
      retrievedChunkIds: ["column:orders.status"],
      catalogIds: ["column:orders.status", "orders.status"],
    });
    expect(out.ok).toBe(true);
  });

  it("rejects citations missing from the catalog", () => {
    const out = validateCitations({
      citations: ["metric:nps"],
      sql: "SELECT 1",
      requestedMetrics: ["NPS"],
      retrievedChunkIds: ["metric:nps"],
      catalogIds: CATALOG,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe("citation_unknown");
  });

  it("rejects citations not retrieved this turn", () => {
    const out = validateCitations({
      citations: ["metric:aov"],
      sql: "SELECT 1",
      requestedMetrics: ["AOV"],
      retrievedChunkIds: RETRIEVED,
      catalogIds: CATALOG,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe("citation_not_retrieved");
  });

  it("requires >= 1 metric:* citation for metric queries", () => {
    const out = validateCitations({
      citations: ["column:orders.status"],
      sql: "SELECT 1",
      requestedMetrics: ["doanh thu thuần"],
      retrievedChunkIds: RETRIEVED,
      catalogIds: CATALOG,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issue.code).toBe("citation_missing_metric");
  });

  it("repairs invalid IDs from retrieved context within <= 2 retries", () => {
    const out = repairCitations(
      {
        citations: ["metric:nps", "metric:made_up"],
        sql: "SELECT 1",
        requestedMetrics: ["doanh thu thuần"],
        retrievedChunkIds: RETRIEVED,
        catalogIds: CATALOG,
      },
      2,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.citations).toContain("metric:net_revenue");
  });

  it("derives metric-preferring citations from retrieval", () => {
    expect(deriveCitations(RETRIEVED)).toContain("metric:net_revenue");
    expect(deriveCitations(["column:orders.status"])).toEqual(["column:orders.status"]);
  });

  it("replaces an existing header instead of stacking", () => {
    const once = ensureCitationHeader("SELECT 1", ["metric:net_revenue"]);
    const twice = ensureCitationHeader(once, ["metric:aov"]);
    expect(twice?.split("\n").filter((line) => line.startsWith("-- @citations:")).length).toBe(1);
    expect(twice).toMatch(/metric:aov/);
  });
});
