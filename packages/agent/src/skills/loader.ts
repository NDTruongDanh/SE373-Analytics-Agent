// Skill loader (AGENT-06, 01-12): reads skills/<name>/SKILL.md, parses front
// matter plus body with zod, validates the eight D-14 canonical sections
// case-insensitively, returns the contract text for prompt injection, and
// emits a skill_call span through the injected emitter. Section semantics
// mirror scripts/skills-check.ts (same D-14 gate, programmatic form).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import type { SpanEmitter } from "../state.js";

export interface SkillSectionRule {
  id: string;
  label: string;
  test: (heading: string) => boolean;
}

/**
 * Canonical D-14 section list. Each rule must match at least one ATX
 * heading (case-insensitive); labels match the skills-check gate.
 */
export const SKILL_SECTIONS: SkillSectionRule[] = [
  {
    id: "name",
    label: "name/metadata",
    test: (h) => /skill\s*name|^name\b|metadata/.test(h),
  },
  {
    id: "description",
    label: "description",
    test: (h) => /description/.test(h),
  },
  {
    id: "triggers",
    label: "when-to-use/triggers",
    test: (h) => /when to use|trigger/.test(h),
  },
  {
    id: "io",
    label: "inputs/outputs",
    test: (h) => /input/.test(h) && /output/.test(h),
  },
  {
    id: "steps",
    label: "steps",
    test: (h) => /\bsteps?\b/.test(h),
  },
  {
    id: "guardrails",
    label: "constraints/guardrails",
    test: (h) => /constraint|guardrail/.test(h),
  },
  {
    id: "examples",
    label: "examples",
    test: (h) => /example/.test(h),
  },
  {
    id: "final-check",
    label: "final-check",
    test: (h) => /final check/.test(h),
  },
];

const SkillFrontMatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

type SkillFrontMatter = z.infer<typeof SkillFrontMatterSchema>;

function defaultSkillsDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../skills",
  );
}

function splitFrontMatter(content: string): {
  front: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { front: {}, body: content };
  }
  const closing = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (closing < 0) {
    return { front: {}, body: content };
  }
  const front: Record<string, unknown> = {};
  for (const line of lines.slice(1, closing)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (match) {
      front[match[1]] = match[2].trim();
    }
  }
  return { front, body: lines.slice(closing + 1).join("\n") };
}

function headingsOf(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s*/, "").trim().toLowerCase());
}

export interface LoadedSkill {
  name: string;
  description?: string;
  /** Body text for prompt injection (front matter stripped). */
  contract: string;
}

export interface LoadSkillOptions {
  skillsDir?: string;
  emit?: SpanEmitter;
}

/**
 * Load and validate a skill. Throws when the skill is missing, the front
 * matter is invalid, or any D-14 section is absent. Emits one skill_call
 * span on success only.
 */
export function loadSkill(name: string, opts: LoadSkillOptions = {}): LoadedSkill {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  }
  const dir = opts.skillsDir ?? defaultSkillsDir();
  let content: string;
  try {
    content = readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
  } catch {
    throw new Error(`skill not found: ${name} (looked in ${dir})`);
  }
  const { front, body } = splitFrontMatter(content);
  const meta: SkillFrontMatter = SkillFrontMatterSchema.parse({
    ...front,
    name:
      typeof front["name"] === "string" && front["name"].length > 0
        ? front["name"]
        : name,
  });
  const headings = headingsOf(body);
  const missing = SKILL_SECTIONS.filter(({ test }) =>
    headings.every((heading) => !test(heading)),
  ).map(({ label }) => label);
  if (missing.length > 0) {
    throw new Error(
      `skill ${name} missing D-14 sections: ${missing.join(", ")}`,
    );
  }
  opts.emit?.({
    node: "skills",
    type: "skill_call",
    durationMs: 0,
    payload: { skill: name },
  });
  return { name: meta.name, description: meta.description, contract: body.trim() };
}
