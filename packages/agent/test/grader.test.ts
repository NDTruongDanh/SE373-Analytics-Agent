import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gradeExecution } from "../../../evals/exGrader.js";
import { compareRuns } from "../../../evals/regression.js";

// Grader suite (EVAL-02/EVAL-03/EVAL-04): PRD 2.2 rules with D-19 coercion,
// the comparator version gate and delta math, and safety-suite presence.

function rows(list: Record<string, unknown>[]) {
  return list;
}

describe("gradeExecution", () => {
  it("passes numbers within half a percent and fails beyond it", () => {
    const gold = rows([{ n: 100 }]);
    expect(gradeExecution({ status: "ok", rows: rows([{ n: 100.5 }]) }, { rows: gold }).pass).toBe(true);
    const over = gradeExecution({ status: "ok", rows: rows([{ n: 100.51 }]) }, { rows: gold });
    expect(over.pass).toBe(false);
    expect(over.mismatches).toHaveLength(1);
  });

  it("coerces numeric-looking strings before comparing", () => {
    expect(
      gradeExecution({ status: "ok", rows: rows([{ n: "12" }]) }, { rows: rows([{ n: 12 }]) }).pass,
    ).toBe(true);
  });

  it("compares multisets unless ordered is true", () => {
    const gold = rows([{ s: "a" }, { s: "b" }]);
    const shuffled = rows([{ s: "b" }, { s: "a" }]);
    expect(gradeExecution({ status: "ok", rows: shuffled }, { rows: gold }).pass).toBe(true);
    expect(
      gradeExecution({ status: "ok", rows: shuffled }, { rows: gold, ordered: true }).pass,
    ).toBe(false);
  });

  it("ignores column names after canonical key sort", () => {
    expect(
      gradeExecution(
        { status: "ok", rows: rows([{ x: 1, y: 2 }]) },
        { rows: rows([{ a: 1, b: 2 }]) },
      ).pass,
    ).toBe(true);
  });

  it("treats NULL as equal only to NULL", () => {
    expect(
      gradeExecution({ status: "ok", rows: rows([{ v: null }]) }, { rows: rows([{ v: null }]) }).pass,
    ).toBe(true);
    expect(
      gradeExecution({ status: "ok", rows: rows([{ v: null }]) }, { rows: rows([{ v: 0 }]) }).pass,
    ).toBe(false);
  });

  it("normalizes ISO timestamps before comparing", () => {
    expect(
      gradeExecution(
        { status: "ok", rows: rows([{ d: "2026-09-01" }]) },
        { rows: rows([{ d: "2026-09-01T00:00:00.000Z" }]) },
      ).pass,
    ).toBe(true);
  });

  it("flags row-count drift as a mismatch", () => {
    const result = gradeExecution(
      { status: "ok", rows: rows([{ n: 1 }]) },
      { rows: rows([{ n: 1 }, { n: 2 }]) },
    );
    expect(result.pass).toBe(false);
    expect(result.mismatches.join(" ")).toContain("row count");
  });

  it("grades cannot_answer on status plus reason, never rows", () => {
    expect(
      gradeExecution(
        { status: "cannot_answer", reason: "no ads table in scope" },
        { status: "cannot_answer" },
      ).pass,
    ).toBe(true);
    expect(
      gradeExecution({ status: "ok", rows: [] }, { status: "cannot_answer" }).pass,
    ).toBe(false);
    expect(
      gradeExecution({ status: "cannot_answer", reason: "  " }, { status: "cannot_answer" }).pass,
    ).toBe(false);
  });
});

describe("compareRuns", () => {
  function file(version: string, rate: number, ms: number[], tokens: number[]) {
    return {
      datasetVersion: version,
      cases: ms.map((m, i) => ({
        id: `c${i}`,
        status: "ok",
        exPass: i < rate * ms.length,
        ms: m,
        tokens: tokens[i],
      })),
      summary: { total: ms.length, passed: rate * ms.length, exRate: rate, avgMs: 0, avgTokens: 0 },
    };
  }

  it("refuses to compare across datasetVersions", () => {
    expect(() =>
      compareRuns(file("v1", 1, [10], [5]), file("v2", 1, [10], [5])),
    ).toThrow(/datasetVersion mismatch/);
  });

  it("reports EX, latency, and token deltas with per-case moves", () => {
    const before = file("same", 0.5, [10, 20], [5, 15]);
    const after = file("same", 1, [20, 40], [10, 30]);
    const delta = compareRuns(before, after);
    expect(delta.datasetVersion).toBe("same");
    expect(delta.exDelta).toBeCloseTo(0.5);
    expect(delta.avgMsDelta).toBeCloseTo(15);
    expect(delta.avgTokensDelta).toBeCloseTo(10);
    expect(delta.improved).toEqual(["c1"]);
    expect(delta.regressed).toEqual([]);
  });
});

describe("safety suite presence", () => {
  it("holds six layered attack cases", () => {
    const url = new URL("../../../evals/safety/cases.jsonl", import.meta.url);
    const lines = readFileSync(url, "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    const layers = new Set([
      "sqlGuard",
      "ColumnScopePolicy",
      "untrusted-data-synthesis",
      "denylist-safety-gate",
      "unknown-term-gate",
      "scope-check",
    ]);
    const ids = new Set<string>();
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      for (const field of ["id", "attack", "question", "role", "expectedBlockingLayer", "notes"]) {
        expect(typeof record[field]).toBe("string");
      }
      ids.add(record["id"] as string);
      expect(layers.has(record["expectedBlockingLayer"] as string)).toBe(true);
    }
    expect(ids.size).toBe(6);
  });
});
