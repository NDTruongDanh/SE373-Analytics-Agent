import * as z from "zod";

// ==========================================
// 1. Enums & Subscriptions Config Schema
// ==========================================

export const AlertSeveritySchema = z.enum(["info", "warning", "critical"]);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertDirectionSchema = z.enum(["spike", "drop"]);
export type AlertDirection = z.infer<typeof AlertDirectionSchema>;

export const AbsoluteThresholdSchema = z.object({
  operator: z.enum(["above", "below"]),
  value: z.number(),
  unit: z.string().optional(),
});
export type AbsoluteThreshold = z.infer<typeof AbsoluteThresholdSchema>;

// Preprocess hỗ trợ cả camelCase và snake_case từ file YAML
export const SubscriptionSchema = z.object({
  id: z.string().min(1),
  metricId: z.string().min(1),
  primaryDimension: z.string().min(1),
  suggestedSecondaryDimensions: z.array(z.string()).default([]),
  recipientId: z.string().min(1),
  recipientRole: z.string().min(1),
  channel: z.enum(["webhook", "email"]).default("webhook"),
  digestPreference: z.enum(["realtime", "digest"]).default("digest"),
  absoluteThreshold: AbsoluteThresholdSchema.optional(),
  minSupport: z.number().int().nonnegative().default(15),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SubscriptionsConfigSchema = z.object({
  version: z.number().int().default(1),
  subscriptions: z.array(SubscriptionSchema).min(1),
});
export type SubscriptionsConfig = z.infer<typeof SubscriptionsConfigSchema>;

// ==========================================
// 2. Strict AnomalyAlert Schema (6 trường bắt buộc theo PRD UC-10)
// ==========================================

export const AnomalyAlertSchema = z.object({
  // 6 trường bắt buộc của PRD UC-10 Tiêu chí #2:
  metric: z.string().min(1),            // 1. Chỉ số (vd: metric:return_rate)
  currentValue: z.number(),             // 2. Giá trị hiện tại
  expectedValue: z.number(),            // 3. Giá trị kỳ vọng
  deviation: z.string().min(1),         // 4. Mức lệch (z-score, WoW%)
  drilldownSegment: z.string().min(1),  // 5. Vùng khoanh được (vd: province = 'Da Nang')
  evidenceSql: z.string().min(1),       // 6. SQL dẫn chứng kiểm chứng được

  // Các trường định danh & routing phục vụ harness và dedup:
  subscriptionId: z.string().min(1).optional(),
  recipientId: z.string().min(1),
  recipientRole: z.string().min(1).optional(),
  severity: AlertSeveritySchema,
  direction: AlertDirectionSchema.optional(),
  date: z.string().optional(),          // YYYY-MM-DD
  fingerprint: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});
export type AnomalyAlert = z.infer<typeof AnomalyAlertSchema>;

// ==========================================
// 3. SendAlert (Tool I/O giữ nguyên tính tương thích)
// ==========================================

export const SendAlertInputSchema = z.object({
  recipientId: z.string().min(1),
  recipientRole: z.string().min(1).optional(),
  severity: AlertSeveritySchema,
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