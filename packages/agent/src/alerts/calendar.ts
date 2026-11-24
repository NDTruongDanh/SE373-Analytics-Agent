import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CalendarEventTypeSchema = z.enum(["public_holiday", "mega_sale"]);
export type CalendarEventType = z.infer<typeof CalendarEventTypeSchema>;

export const CalendarEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: CalendarEventTypeSchema,
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const CalendarConfigSchema = z.object({
  version: z.number().int().default(1),
  events: z.array(CalendarEventSchema).default([]),
});
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;

export const DEFAULT_CALENDAR_PATH = fileURLToPath(
  new URL("../../../../config/calendar.yaml", import.meta.url),
);

let cachedDefaultConfig: CalendarConfig | undefined;

export function loadCalendarConfig(yamlText: string): CalendarConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new Error(
      `Invalid calendar YAML syntax: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return CalendarConfigSchema.parse(raw);
}

export function loadCalendarConfigFile(
  filePath?: string,
  envOverride: string | undefined = process.env["CALENDAR_PATH"],
): CalendarConfig {
  const resolved = filePath ?? envOverride ?? DEFAULT_CALENDAR_PATH;
  if (!existsSync(resolved)) {
    return { version: 1, events: [] };
  }
  const content = readFileSync(resolved, "utf8");
  return loadCalendarConfig(content);
}

export function getDefaultCalendarConfig(): CalendarConfig {
  if (!cachedDefaultConfig) {
    cachedDefaultConfig = loadCalendarConfigFile();
  }
  return cachedDefaultConfig;
}

/**
 * Finds all calendar events covering the target date (inclusive: startDate <= date <= endDate).
 */
export function getCalendarEventsForDate(
  date: string,
  config?: CalendarConfig,
): CalendarEvent[] {
  const cfg = config ?? getDefaultCalendarConfig();
  return cfg.events.filter(
    (event) => event.startDate <= date && date <= event.endDate,
  );
}

/**
 * Returns the primary matching calendar event for the target date, if any.
 */
export function getCalendarEvent(
  date: string,
  config?: CalendarConfig,
): CalendarEvent | undefined {
  const events = getCalendarEventsForDate(date, config);
  return events[0];
}

/**
 * Checks if target date falls into a public holiday (Tết, Giỗ tổ, 30/4, 2/9, etc.).
 * Public holidays are excluded from historical baseline, and alerts are downgraded
 * to "info" unless reaching Critical severity.
 */
export function isPublicHoliday(
  date: string,
  config?: CalendarConfig,
): boolean {
  return getCalendarEventsForDate(date, config).some(
    (e) => e.type === "public_holiday",
  );
}

/**
 * Checks if target date falls into a mega sale event (9.9, 11.11, Black Friday, 12.12).
 * Mega sales are excluded from historical baseline, but alerts MAINTAIN severity (NO DOWNGRADE).
 */
export function isMegaSale(
  date: string,
  config?: CalendarConfig,
): boolean {
  return getCalendarEventsForDate(date, config).some(
    (e) => e.type === "mega_sale",
  );
}

/**
 * Checks if target date should be excluded from historical same-weekday baseline.
 * Both public holidays and mega sales distort historical trends and must be excluded.
 */
export function isExcludedFromBaseline(
  date: string,
  config?: CalendarConfig,
): boolean {
  return isPublicHoliday(date, config) || isMegaSale(date, config);
}
