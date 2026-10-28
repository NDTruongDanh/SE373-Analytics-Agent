// skills:check (EVAL-04, D-14): gate behind `pnpm skills:check`, run in CI
// before any loadSkill consumer (01-12). Scans skills/**/*.md only (so
// .gitkeep files never trip it), fails on executable extensions plus
// key-block, URL connection-string, and DSN content, and validates the
// eight canonical D-14 section headings case-insensitively. Exits zero
// with a no-skills-yet message while no SKILL.md exists (01-12 seeds land
// in wave five). Pure node — no dependencies.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const EXECUTABLE_EXTENSIONS = new Set([".js", ".ts", ".sh", ".py"]);

// One matcher per canonical D-14 section (name/metadata, description,
// when-to-use/triggers, inputs/outputs, steps, constraints/guardrails,
// examples, final check). Each must match at least one ATX heading.
const SECTION_MATCHERS: { label: string; test: (heading: string) => boolean }[] = [
  { label: "name/metadata", test: (h) => /skill\s*name|^name\b|metadata/.test(h) },
  { label: "description", test: (h) => /description/.test(h) },
  { label: "when-to-use/triggers", test: (h) => /when to use|trigger/.test(h) },
  { label: "inputs/outputs", test: (h) => /input/.test(h) && /output/.test(h) },
  { label: "steps", test: (h) => /\bsteps?\b/.test(h) },
  { label: "constraints/guardrails", test: (h) => /constraint|guardrail/.test(h) },
  { label: "examples", test: (h) => /example/.test(h) },
  { label: "final-check", test: (h) => /final check/.test(h) },
];

const KEY_BLOCK_RE = /-----BEGIN [A-Z0-9 ]+-----/;
const URL_RE = /https?:\/\//;
const DSN_RE = /postgres(ql)?:\/\//i;

function collectMarkdown(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // skills/ absent — treated as no-skills-yet by the caller.
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectMarkdown(full, out);
    } else if (full.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function collectAllFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectAllFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function headingsOf(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s*/, "").trim().toLowerCase());
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const skillsDir = path.join(repoRoot, "skills");

  const executables = collectAllFiles(skillsDir).filter((file) =>
    EXECUTABLE_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );
  if (executables.length > 0) {
    console.error("skills:check FAILED — executable files under skills/:");
    for (const file of executables) console.error(`  ${file}`);
    process.exit(1);
  }

  const docs = collectMarkdown(skillsDir);
  if (docs.length === 0) {
    console.log("skills:check: no SKILL.md files yet (01-12 seeds land in wave 5)");
    process.exit(0);
  }

  let failed = false;
  for (const file of docs.sort()) {
    const content = readFileSync(file, "utf8");
    const problems: string[] = [];
    if (KEY_BLOCK_RE.test(content)) problems.push("key block (-----BEGIN ...-----)");
    if (URL_RE.test(content)) problems.push("URL connection string (http(s)://)");
    if (DSN_RE.test(content)) problems.push("DSN literal (postgres://)");
    const headings = headingsOf(content);
    const missing = SECTION_MATCHERS.filter(({ test }) =>
      headings.every((h) => !test(h)),
    ).map(({ label }) => label);
    if (missing.length > 0) problems.push(`missing sections: ${missing.join(", ")}`);
    if (problems.length > 0) {
      failed = true;
      console.error(`skills:check FAILED — ${file}: ${problems.join("; ")}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`skills:check: ${docs.length} skill file(s) pass D-14 gate`);
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("skills-check.ts");
if (invokedDirectly) {
  await main();
}
