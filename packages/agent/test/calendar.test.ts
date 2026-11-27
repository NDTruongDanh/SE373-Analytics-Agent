import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCalendarEvent,
  getCalendarEventsForDate,
  getDefaultCalendarConfig,
  isExcludedFromBaseline,
  isMegaSale,
  isPublicHoliday,
  loadCalendarConfig,
  loadCalendarConfigFile,
  resetCalendarConfigCacheForTests,
} from "../src/alerts/calendar.js";

describe("Vietnam Retail Calendar & Event Classifier (UC-10 #134)", () => {
  const config = getDefaultCalendarConfig();

  it("loads default config/calendar.yaml with valid events", () => {
    expect(config.events.length).toBeGreaterThanOrEqual(10);
    expect(config.events.some((e) => e.type === "public_holiday")).toBe(true);
    expect(config.events.some((e) => e.type === "mega_sale")).toBe(true);
    expect(getCalendarEventsForDate("2026-02-14", config).length).toBeGreaterThanOrEqual(1);
  });

  it("handles inclusive dates for public holidays (Tết 2026: 2026-02-14 .. 2026-02-22)", () => {
    // Start date (inclusive)
    expect(isPublicHoliday("2026-02-14", config)).toBe(true);
    // Middle date
    expect(isPublicHoliday("2026-02-18", config)).toBe(true);
    // End date (inclusive)
    expect(isPublicHoliday("2026-02-22", config)).toBe(true);
    // Day before start
    expect(isPublicHoliday("2026-02-13", config)).toBe(false);
    // Day after end
    expect(isPublicHoliday("2026-02-23", config)).toBe(false);
  });

  it("handles inclusive dates for Quốc khánh 2/9 (2026-09-01 .. 2026-09-03)", () => {
    expect(isPublicHoliday("2026-09-01", config)).toBe(true);
    expect(isPublicHoliday("2026-09-02", config)).toBe(true);
    expect(isPublicHoliday("2026-09-03", config)).toBe(true);
    expect(isPublicHoliday("2026-09-04", config)).toBe(false);
  });

  it("identifies single-day and multi-day mega sales (9.9, 11.11, Black Friday)", () => {
    // 9.9
    expect(isMegaSale("2026-09-09", config)).toBe(true);
    expect(isPublicHoliday("2026-09-09", config)).toBe(false);

    // 11.11 (2026-11-11 .. 2026-11-12)
    expect(isMegaSale("2026-11-11", config)).toBe(true);
    expect(isMegaSale("2026-11-12", config)).toBe(true);
    expect(isMegaSale("2026-11-13", config)).toBe(false);

    // Black Friday (2026-11-27 .. 2026-11-29)
    expect(isMegaSale("2026-11-27", config)).toBe(true);
    expect(isMegaSale("2026-11-28", config)).toBe(true);
    expect(isMegaSale("2026-11-29", config)).toBe(true);
    expect(isMegaSale("2026-11-30", config)).toBe(false);
  });

  it("excludes both public holidays and mega sales from baseline, but not normal days", () => {
    // Public holiday -> excluded
    expect(isExcludedFromBaseline("2026-04-30", config)).toBe(true);
    expect(isExcludedFromBaseline("2026-05-01", config)).toBe(true);

    // Mega sale -> excluded
    expect(isExcludedFromBaseline("2026-12-12", config)).toBe(true);

    // Normal business day -> NOT excluded
    expect(isExcludedFromBaseline("2026-08-15", config)).toBe(false);
    expect(isExcludedFromBaseline("2026-10-15", config)).toBe(false);
  });

  it("parses custom calendar YAML text correctly", () => {
    const customYaml = `
version: 1
events:
  - id: custom-promo
    name: "Khuyến mãi đặc biệt"
    startDate: "2026-07-01"
    endDate: "2026-07-05"
    type: "mega_sale"
`;
    const parsed = loadCalendarConfig(customYaml);
    expect(parsed.events).toHaveLength(1);
    expect(isMegaSale("2026-07-03", parsed)).toBe(true);
    expect(isMegaSale("2026-07-06", parsed)).toBe(false);
  });

  it("returns event details with getCalendarEvent", () => {
    const event = getCalendarEvent("2026-09-02", config);
    expect(event).toBeDefined();
    expect(event?.id).toBe("national-day-2026");
    expect(event?.name).toContain("Quốc khánh");
    expect(event?.type).toBe("public_holiday");
  });

  it("rejects inverted calendar event date ranges (endDate < startDate)", () => {
    const badYaml = `
version: 1
events:
  - id: bad-range
    name: "Inverted"
    startDate: "2026-09-10"
    endDate: "2026-09-05"
    type: "mega_sale"
`;
    expect(() => loadCalendarConfig(badYaml)).toThrow(/endDate must be on or after startDate/);
  });

  it("throws when an explicit calendar file path or CALENDAR_PATH does not exist", () => {
    expect(() => loadCalendarConfigFile("/nonexistent/path/calendar.yaml")).toThrow(
      /Calendar config file not found/,
    );
    expect(() => loadCalendarConfigFile(undefined, "/nonexistent/env/calendar.yaml")).toThrow(
      /Calendar config file not found/,
    );
  });

  it("reloads default calendar cache when CALENDAR_PATH or file mtime changes", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cal-cache-"));
    const calPath = path.join(tmpDir, "calendar.yaml");
    const prevEnv = process.env["CALENDAR_PATH"];
    try {
      writeFileSync(
        calPath,
        `version: 1
events:
  - id: ev1
    name: "First"
    startDate: "2026-06-01"
    endDate: "2026-06-01"
    type: "mega_sale"
`,
        "utf8",
      );
      process.env["CALENDAR_PATH"] = calPath;
      resetCalendarConfigCacheForTests();
      const first = getDefaultCalendarConfig();
      expect(first.events[0]?.id).toBe("ev1");

      writeFileSync(
        calPath,
        `version: 1
events:
  - id: ev2
    name: "Second"
    startDate: "2026-06-02"
    endDate: "2026-06-02"
    type: "public_holiday"
`,
        "utf8",
      );
      const future = new Date(Date.now() + 5_000);
      utimesSync(calPath, future, future);
      const second = getDefaultCalendarConfig();
      expect(second.events[0]?.id).toBe("ev2");
    } finally {
      if (prevEnv === undefined) delete process.env["CALENDAR_PATH"];
      else process.env["CALENDAR_PATH"] = prevEnv;
      resetCalendarConfigCacheForTests();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
