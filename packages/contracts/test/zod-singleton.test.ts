import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the single-zod-copy invariant for first-party schemas: the whole
// workspace must resolve exactly one zod 4.x line (zod duplication breaks
// schema identity across our contracts) and no zod 3.x line at all. The UC-03
// web stack pulls @ag-ui/core via @openuidev/react-headless; it is pinned to
// 1.0.4 (see pnpm-workspace.yaml overrides), which dropped the zod ^3
// dependency older releases needed for protocol validation. Any new zod@3
// line fails this test and forces review.
describe("zod singleton", () => {
  it("lockfile holds exactly one distinct zod@4 version key", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const lockText = readFileSync(join(here, "../../../pnpm-lock.yaml"), "utf8");
    const keys = lockText
      .split(/\r?\n/)
      .map((line) => /^  (zod@\S+?):?$/.exec(line)?.[1])
      .filter((key) => key !== undefined);
    const distinct = [...new Set(keys)];
    const fours = distinct.filter((key) => key.startsWith("zod@4"));
    expect(fours).toHaveLength(1);
    const threes = distinct.filter((key) => key.startsWith("zod@3"));
    expect(threes).toEqual([]);
  });
});
