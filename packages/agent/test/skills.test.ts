// Skills tests (AGENT-06, 01-12): loading both seeds, D-14 validation,
// malformed-fixture rejection in the OS temp dir, skill_call emission, and
// name safety. No network, no database.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSkill, SKILL_SECTIONS } from "../src/skills/loader.js";
import type { SpanEvent } from "../src/state.js";

const SKILLS_DIR = fileURLToPath(new URL("../../../skills", import.meta.url));

describe("skill loader", () => {
  it("exposes the eight canonical D-14 sections", () => {
    expect(SKILL_SECTIONS).toHaveLength(8);
  });

  it("loads the text-to-sql seed with its contract", () => {
    const skill = loadSkill("text-to-sql", { skillsDir: SKILLS_DIR });
    expect(skill.name).toBe("text-to-sql");
    expect(skill.description).toContain("read-only SQL");
    expect(skill.contract).toContain("LIMIT 200");
    expect(skill.contract).not.toContain("---\nname:");
  });

  it("loads the answer-synthesis seed with its guardrails", () => {
    const skill = loadSkill("answer-synthesis", { skillsDir: SKILLS_DIR });
    expect(skill.name).toBe("answer-synthesis");
    expect(skill.contract).toContain("cannot_answer");
    expect(skill.contract).toContain("Zero tools");
  });

  it("rejects a malformed skill created under the OS temp dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skills-bad-"));
    const skillDir = path.join(dir, "broken");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: broken",
        "---",
        "",
        "# broken",
        "",
        "## Description",
        "",
        "Only a description, nothing else.",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(() => loadSkill("broken", { skillsDir: dir })).toThrow(
      /missing D-14 sections/,
    );
  });

  it("throws for unknown skills without emitting", () => {
    const seen: SpanEvent[] = [];
    expect(() =>
      loadSkill("no-such-skill", {
        skillsDir: SKILLS_DIR,
        emit: (event) => {
          seen.push(event);
          return "stub-span";
        },
      }),
    ).toThrow(/skill not found/);
    expect(seen).toHaveLength(0);
  });

  it("rejects unsafe skill names", () => {
    expect(() => loadSkill("../escape", { skillsDir: SKILLS_DIR })).toThrow(
      /invalid skill name/,
    );
    expect(() => loadSkill("", { skillsDir: SKILLS_DIR })).toThrow(
      /invalid skill name/,
    );
  });

  it("emits one skill_call span on success through a stub emitter", () => {
    const seen: SpanEvent[] = [];
    const skill = loadSkill("text-to-sql", {
      skillsDir: SKILLS_DIR,
      emit: (event) => {
        seen.push(event);
        return "stub-span-id";
      },
    });
    expect(skill.name).toBe("text-to-sql");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      node: "skills",
      type: "skill_call",
      payload: { skill: "text-to-sql" },
    });
  });
});
