import * as z from "zod";

// SendAlert contract (CONT-04, UC-10 delivery surface). Carries the six
// mandatory UC-10 alert fields: recipient, severity, metric, current and
// expected values, deviation, drilldown segment, evidence SQL, message.
// Delivery (channels, retry, dedup) is owned by apps/api + UC-10.

export const SendAlertInputSchema = z.object({
  recipientId: z.string().min(1),
  recipientRole: z.string().min(1).optional(),
  severity: z.enum(["info", "warning", "critical"]),
  metric: z.string().min(1),
  currentValue: z.number(),
  expectedValue: z.number(),
  deviation: z.string().min(1),
  drilldownSegment: z.string().min(1),
  evidenceSql: z.string().min(1),
  message: z.string().min(1),
});

export type SendAlertInput = z.infer<typeof SendAlertInputSchema>;

export const SendAlertOutputSchema = z.object({
  sent: z.boolean(),
  fingerprint: z.string().min(1),
  queued: z.boolean().optional(),
});

export type SendAlertOutput = z.infer<typeof SendAlertOutputSchema>;
