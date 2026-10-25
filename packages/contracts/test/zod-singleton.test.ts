import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the single-zod-copy invariant: the whole workspace must resolve
// exactly one zod 4.x line (zod duplication breaks schema identity).
describe("zod singleton", () => {
  it("lockfile holds exactly one distinct zod@4 version key", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const lockText = readFileSync(join(here, "../../../pnpm-lock.yaml"), "utf8");
    const keys = lockText
      .split("\n")
      .map((line) => /^  (zod@\S+)/.exec(line)?.[1])
      .filter((key) => key !== undefined);
    const distinct = [...new Set(keys)];
    expect(distinct).toHaveLength(1);
    expect(distinct[0]?.startsWith("zod@4")).toBe(true);
  });
});
