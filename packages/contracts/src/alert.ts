import * as z from "zod";

// ==========================================
// 1. Enums & Subscriptions Config Schema
// ==========================================

export const AlertSeveritySchema = z.enum(["info", "warning", "critical"]);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertDirectionSchema = z.enum(["spike", "drop"]);
export type AlertDirection = z.infer<typeof AlertDirectionSchema>;

export const AlertChannelSchema = z.enum(["webhook", "email", "telegram", "slack"]);
export type AlertChannel = z.infer<typeof AlertChannelSchema>;

export const AbsoluteThresholdSchema = z.object({
  operator: z.enum(["above", "below"]),
  value: z.number().finite(),
  unit: z.string().min(1).max(50).optional(),
});
export type AbsoluteThreshold = z.infer<typeof AbsoluteThresholdSchema>;

export const MinSupportConfigSchema = z.object({
  minOrders: z.number().int().min(15).default(15),
  minMetricTrimmedMean: z.number().nonnegative().optional(),
});
export type MinSupportConfig = z.infer<typeof MinSupportConfigSchema>;

export const MinSupportSchema = z.union([
  z.number().int().min(15),
  MinSupportConfigSchema,
]);
export type MinSupport = z.infer<typeof MinSupportSchema>;

// Preprocesses input objects to map snake_case keys to canonical camelCase.
function preprocessSubscription(val: unknown): unknown {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    return val;
  }
  const obj = val as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  if ("metric_id" in obj && !("metricId" in obj)) {
    out.metricId = obj.metric_id;
  }
  if ("primary_dimension" in obj && !("primaryDimension" in obj)) {
    out.primaryDimension = obj.primary_dimension;
  }
  if ("suggested_secondary_dimensions" in obj && !("suggestedSecondaryDimensions" in obj)) {
    out.suggestedSecondaryDimensions = obj.suggested_secondary_dimensions;
  }
  if ("recipient_id" in obj && !("recipientId" in obj)) {
    out.recipientId = obj.recipient_id;
  }
  if ("recipient_role" in obj && !("recipientRole" in obj)) {
    out.recipientRole = obj.recipient_role;
  }
  if ("digest_preference" in obj && !("digestPreference" in obj)) {
    out.digestPreference = obj.digest_preference;
  }
  if ("absolute_threshold" in obj && !("absoluteThreshold" in obj)) {
    out.absoluteThreshold = obj.absolute_threshold;
  }
  if ("min_support" in obj && !("minSupport" in obj)) {
    out.minSupport = obj.min_support;
  }
  return out;
}

export const RawSubscriptionSchema = z.object({
  id: z.string().min(1),
  metricId: z.string().min(1),
  primaryDimension: z.string().min(1),
  suggestedSecondaryDimensions: z.array(z.string()).default([]),
  recipientId: z.string().min(1),
  recipientRole: z.string().min(1),
  channel: AlertChannelSchema.default("webhook"),
  digestPreference: z.enum(["realtime", "digest"]).default("digest"),
  absoluteThreshold: AbsoluteThresholdSchema.optional(),
  minSupport: MinSupportSchema.default(15),
});

export const SubscriptionSchema = z.preprocess(
  preprocessSubscription,
  RawSubscriptionSchema,
);
export type Subscription = z.infer<typeof RawSubscriptionSchema>;

export const SubscriptionsConfigSchema = z.object({
  version: z.number().int().default(1),
  subscriptions: z.array(SubscriptionSchema).min(1),
});
export type SubscriptionsConfig = z.infer<typeof SubscriptionsConfigSchema>;

// ==========================================
// 2. Core Anomaly & Governed Alert Schemas
// ==========================================

// Six mandatory fields required by PRD UC-10 Criterion #2 and UC10 section 5.
export const CoreAnomalyFieldsSchema = z.object({
  metric: z.string().min(1),
  currentValue: z.number(),
  expectedValue: z.number(),
  deviation: z.string().min(1),
  drilldownSegment: z.string().min(1),
  evidenceSql: z.string().min(1),
});
export type CoreAnomalyFields = z.infer<typeof CoreAnomalyFieldsSchema>;

// Strict AnomalyAlert schema with mandatory routing and deduplication fields.
// Deduplication fingerprint: SHA256(recipient_id|metric|dimension_key|date|direction).
export const AnomalyAlertSchema = CoreAnomalyFieldsSchema.extend({
  dimensionKey: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be formatted as YYYY-MM-DD"),
  direction: AlertDirectionSchema,
  recipientId: z.string().min(1),
  severity: AlertSeveritySchema,
  subscriptionId: z.string().min(1).optional(),
  recipientRole: z.string().min(1).optional(),
  fingerprint: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});
export type AnomalyAlert = z.infer<typeof AnomalyAlertSchema>;

// ==========================================
// 3. SendAlert (Tool I/O surface for delivery)
// ==========================================

export const SendAlertInputSchema = CoreAnomalyFieldsSchema.extend({
  recipientId: z.string().min(1),
  recipientRole: z.string().min(1).optional(),
  severity: AlertSeveritySchema,
  message: z.string().min(1),
});
export type SendAlertInput = z.infer<typeof SendAlertInputSchema>;

export const SendAlertOutputSchema = z.object({
  sent: z.boolean(),
  fingerprint: z.string().min(1),
  queued: z.boolean().optional(),
});
export type SendAlertOutput = z.infer<typeof SendAlertOutputSchema>;
