// UC-10 eval entrypoint (docs/UC-plan/UC10.md §9): runs via
// `pnpm eval --uc uc10` or `pnpm exec tsx evals/uc10/runUc10.ts`.

import { pathToFileURL } from "node:url";
import { gradeUc10, printUc10Report } from "./grader.js";

export * from "./grader.js";

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const results = await gradeUc10(process.cwd());
  printUc10Report(results);
  const allPassed = results.cases.every((c) => c.exPass) && results.gatesPassed;
  process.exit(allPassed ? 0 : 1);
}
