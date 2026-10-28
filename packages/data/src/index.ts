export const DATA_SHELL =
  "Data shell: Olist download/transform/load lands in 01-07";

// 01-07 owns all real loader code under packages/data/src (download,
// vietnamize, chunked COPY, seeds, verify) plus its live tests.
export * from "./download.js";
export * from "./transform.js";
export * from "./copy.js";
export * from "./load.js";
export * from "./manifest.js";
export * from "./seeds.js";
// verify.js also exports a `main` CLI entry like load.js does, so it joins
// the barrel by name instead of by star.
export { runChecks, type VerifyReport } from "./verify.js";
