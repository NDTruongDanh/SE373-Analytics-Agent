import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactPII } from "@shared/access-policy";
import { TraceEventSchema } from "@shared/contracts";
import {
  compareRuns,
  summarizeCases,
  type EvalResultsFile,
} from "../../../evals/regression.js";
import {
  evaluateUc10Gates,
  gradeUc10,
} from "../../../evals/uc10/grader.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("UC-10 eval grader, trace & regression gates (#45)", () => {
  it("passes all >= 5 eval cases covering A1-A5, FP <= 3/week, min_support, 24h dedup, and 0 PII leaks", async () => {
    const res = await gradeUc10(repoRoot);
    expect(res.cases.length).toBeGreaterThanOrEqual(5);
    expect(res.cases.every((c) => c.exPass)).toBe(true);
    expect(res.gatesPassed).toBe(true);
    expect(res.summary.seededTotal).toBe(5);
    expect(res.summary.seededDetected).toBe(5);
    expect(res.summary.detectionRate).toBe(1);
    expect(res.summary.falsePositivesPerNormalWeek).toBeLessThanOrEqual(3);
    expect(res.summary.falsePositivesPerNormalWeek).toBe(0);
    expect(res.summary.minSupportSkipped).toBe(true);
    expect(res.summary.sixFieldCompleteness).toBe(1);
    expect(res.summary.dedupPass).toBe(true);
    expect(res.summary.retryQueuePass).toBe(true);
    expect(res.summary.piiLeaks).toBe(0);
  });

  it("rejects summaries that breach UC-10 acceptance gates", () => {
    const base = {
      seededDetected: 5,
      seededTotal: 5,
      falsePositivesPerNormalWeek: 0,
      minSupportSkipped: true,
      sixFieldCompleteness: 1,
      dedupPass: true,
      retryQueuePass: true,
      piiLeaks: 0,
    };
    expect(evaluateUc10Gates(base).gatesPassed).toBe(true);

    const lowDetect = evaluateUc10Gates({ ...base, seededDetected: 3 });
    expect(lowDetect.gatesPassed).toBe(false);
    expect(lowDetect.gateFailures.join(" ")).toContain("detection rate");

    const highFp = evaluateUc10Gates({ ...base, falsePositivesPerNormalWeek: 4 });
    expect(highFp.gatesPassed).toBe(false);
    expect(highFp.gateFailures.join(" ")).toContain("false positives");

    const noSupportSkip = evaluateUc10Gates({ ...base, minSupportSkipped: false });
    expect(noSupportSkip.gatesPassed).toBe(false);
    expect(noSupportSkip.gateFailures.join(" ")).toContain("min_support");

    const missingFields = evaluateUc10Gates({ ...base, sixFieldCompleteness: 0.8 });
    expect(missingFields.gatesPassed).toBe(false);
    expect(missingFields.gateFailures.join(" ")).toContain("6-field");

    const badDedup = evaluateUc10Gates({ ...base, dedupPass: false });
    expect(badDedup.gatesPassed).toBe(false);
    expect(badDedup.gateFailures.join(" ")).toContain("24h deduplication");

    const badRetry = evaluateUc10Gates({ ...base, retryQueuePass: false });
    expect(badRetry.gatesPassed).toBe(false);
    expect(badRetry.gateFailures.join(" ")).toContain("retry/queue");

    const piiLeak = evaluateUc10Gates({ ...base, piiLeaks: 1 });
    expect(piiLeak.gatesPassed).toBe(false);
    expect(piiLeak.gateFailures.join(" ")).toContain("PII leak");
  });

  it("commits a valid PII-redacted UC-10 trace with reconciling run_done", () => {
    const tracePath = path.join(
      repoRoot,
      "traces",
      "uc10",
      "a10a5f1e-7b2d-4c8e-9f0a-1b2c3d4e5f60.jsonl",
    );
    const raw = readFileSync(tracePath, "utf8");
    expect(redactPII(raw).hit).toBe(false);

    const lines = raw.trim().split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(10);

    const events = lines.map((line) => TraceEventSchema.parse(JSON.parse(line)));
    expect(
      events.some(
        (e) =>
          e.type === "skill_call" &&
          (e.payload as { skill?: string } | undefined)?.skill === "anomaly-alert",
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.node === "anomaly_detector" && e.type === "node_done"),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.node === "dedup_check" &&
          e.type === "node_done" &&
          (e.payload as { alertsSkippedDuplicate?: number } | undefined)
            ?.alertsSkippedDuplicate === 1,
      ),
    ).toBe(true);

    const runDone = events.find((e) => e.type === "run_done");
    expect(runDone).toBeDefined();
    const toolCalls = events.filter((e) => e.type === "tool_call").length;
    const sqlAttempts = events.filter(
      (e) =>
        e.type === "tool_call" &&
        (e.payload as { tool?: string } | undefined)?.tool === "run_query",
    ).length;
    expect(runDone?.payload).toMatchObject({
      status: "ok",
      toolCalls,
      sqlAttempts,
      sqlFailures: 0,
      repairs: 0,
    });
  });

  it("reports positive exDelta with zero regressions between Run #1 and Run #2", async () => {
    const live = await gradeUc10(repoRoot);
    const baselineCases = live.cases.map((c) => {
      const baselineFailed = c.id === "uc10-03" || c.id === "uc10-06" || c.id === "uc10-07";
      return {
        ...c,
        status: baselineFailed ? "fail" : "pass",
        exPass: !baselineFailed,
      };
    });
    const baseline: EvalResultsFile = {
      uc: "uc10",
      datasetVersion: "uc10-1",
      cases: baselineCases,
      summary: summarizeCases(baselineCases),
    };
    const current: EvalResultsFile = {
      uc: "uc10",
      datasetVersion: "uc10-1",
      cases: live.cases,
      summary: summarizeCases(live.cases),
    };

    const delta = compareRuns(baseline, current);
    expect(delta.datasetVersion).toBe("uc10-1");
    expect(delta.exDelta).toBeCloseTo(0.375);
    expect(delta.improved).toEqual(["uc10-03", "uc10-06", "uc10-07"]);
    expect(delta.regressed).toEqual([]);

    const run1Path = path.join(repoRoot, "results", "uc10.run1.json");
    const run2Path = path.join(repoRoot, "results", "uc10.run2.json");
    if (existsSync(run1Path) && existsSync(run2Path)) {
      const diskRun1 = JSON.parse(readFileSync(run1Path, "utf8")) as EvalResultsFile;
      const diskRun2 = JSON.parse(readFileSync(run2Path, "utf8")) as EvalResultsFile;
      const diskDelta = compareRuns(diskRun1, diskRun2);
      expect(diskDelta.exDelta).toBeCloseTo(0.375);
      expect(diskDelta.improved).toEqual(["uc10-03", "uc10-06", "uc10-07"]);
      expect(diskDelta.regressed).toEqual([]);
    }
  });
});
