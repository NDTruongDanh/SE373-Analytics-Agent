import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CalendarEventTypeSchema = z.enum(["public_holiday", "mega_sale"]);
export type CalendarEventType = z.infer<typeof CalendarEventTypeSchema>;

export const CalendarEventSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: CalendarEventTypeSchema,
  })
  .refine((event) => event.endDate >= event.startDate, {
    message: "endDate must be on or after startDate",
    path: ["endDate"],
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

let cachedDefaultConfig:
  | { path: string; mtimeMs: number | null; config: CalendarConfig }
  | undefined;

export function resetCalendarConfigCacheForTests(): void {
  cachedDefaultConfig = undefined;
}

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

function resolveCalendarPath(
  filePath?: string,
  envOverride: string | undefined = process.env["CALENDAR_PATH"],
): { explicitPath: string | undefined; resolved: string } {
  const trimmedEnv =
    envOverride !== undefined && envOverride.trim().length > 0 ? envOverride : undefined;
  const explicitPath = filePath ?? trimmedEnv;
  return { explicitPath, resolved: explicitPath ?? DEFAULT_CALENDAR_PATH };
}

export function loadCalendarConfigFile(
  filePath?: string,
  envOverride: string | undefined = process.env["CALENDAR_PATH"],
): CalendarConfig {
  const { explicitPath, resolved } = resolveCalendarPath(filePath, envOverride);
  if (!existsSync(resolved)) {
    if (explicitPath !== undefined) {
      throw new Error(`Calendar config file not found: ${resolved}`);
    }
    return { version: 1, events: [] };
  }
  const content = readFileSync(resolved, "utf8");
  return loadCalendarConfig(content);
}

export function getDefaultCalendarConfig(): CalendarConfig {
  const { explicitPath, resolved } = resolveCalendarPath();
  const exists = existsSync(resolved);
  if (!exists && explicitPath !== undefined) {
    throw new Error(`Calendar config file not found: ${resolved}`);
  }
  const mtimeMs = exists ? statSync(resolved).mtimeMs : null;
  if (
    cachedDefaultConfig &&
    cachedDefaultConfig.path === resolved &&
    cachedDefaultConfig.mtimeMs === mtimeMs
  ) {
    return cachedDefaultConfig.config;
  }
  const config = exists
    ? loadCalendarConfig(readFileSync(resolved, "utf8"))
    : { version: 1, events: [] };
  cachedDefaultConfig = { path: resolved, mtimeMs, config };
  return config;
}

export function getCalendarEventsForDate(
  date: string,
  config?: CalendarConfig,
): CalendarEvent[] {
  const cfg = config ?? getDefaultCalendarConfig();
  return cfg.events.filter(
    (event) => event.startDate <= date && date <= event.endDate,
  );
}

export function getCalendarEvent(
  date: string,
  config?: CalendarConfig,
): CalendarEvent | undefined {
  const events = getCalendarEventsForDate(date, config);
  return events[0];
}

export function isPublicHoliday(
  date: string,
  config?: CalendarConfig,
): boolean {
  return getCalendarEventsForDate(date, config).some(
    (e) => e.type === "public_holiday",
  );
}

export function isMegaSale(
  date: string,
  config?: CalendarConfig,
): boolean {
  return getCalendarEventsForDate(date, config).some(
    (e) => e.type === "mega_sale",
  );
}

export function isExcludedFromBaseline(
  date: string,
  config?: CalendarConfig,
): boolean {
  return isPublicHoliday(date, config) || isMegaSale(date, config);
}
