// Eval fixture routing (#96): every committed UC fixture loads through the
// loader that matches its schema. UC-09 gateway records live in
// GATEWAY_CASES_FILE (never `cases.jsonl`), benchmark `cases.jsonl` files
// (UC-01) go through the EX loader, and the DB-free suites keep their own
// graders. Pure file reads, no DB or gateway.
//
// Imports the eval entry from source, same precedent as evalGuard.test.ts.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATEWAY_CASES_FILE,
  isPureUc,
  loadGatewayCases,
  loadUcCases,
} from "../../../evals/run.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const ucDirs = readdirSync(path.join(repoRoot, "evals"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^uc\d+$/.test(entry.name))
  .map((entry) => entry.name);

describe("eval fixture routing (#96)", () => {
  it("loads the UC-01 benchmark cases.jsonl as EX cases", () => {
    const cases = loadUcCases(repoRoot, "uc01");
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.every((c) => typeof c.goldSql === "string")).toBe(true);
  });

  it("keeps UC-09 gateway records out of the EX loader", () => {
    const ex = loadUcCases(repoRoot, "uc09");
    expect(ex.map((c) => c.id)).toEqual(["tracer-01"]);
    const gateway = loadGatewayCases(repoRoot, "uc09");
    expect(gateway.length).toBeGreaterThanOrEqual(24);
  });

  it("no UC dir uses cases.jsonl for gateway records", () => {
    expect(GATEWAY_CASES_FILE).not.toBe("cases.jsonl");
    expect(existsSync(path.join(repoRoot, "evals", "uc09", "cases.jsonl"))).toBe(false);
  });

  it.each(ucDirs)("%s loads through its own runner without throwing", (uc) => {
    if (isPureUc(uc)) return; // graded by its own DB-free grader
    expect(() => loadUcCases(repoRoot, uc)).not.toThrow();
    if (existsSync(path.join(repoRoot, "evals", uc, GATEWAY_CASES_FILE))) {
      expect(() => loadGatewayCases(repoRoot, uc)).not.toThrow();
    }
  });
});
