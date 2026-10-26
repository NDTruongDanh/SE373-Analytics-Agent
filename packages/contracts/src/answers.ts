import * as z from "zod";

// Single answer contract shared by UC-01 and UC-02 (UC-01 section 3.1/3.2,
// UC-02 Feature 5). camelCase is the canonical shape; UC-02's snake_case
// variants are not added — one shape per the freeze (see README).

export const SqlAttemptSchema = z.object({
  attemptNo: z.number().int(),
  sql: z.string().nullable(),
  schemaRefs: z.array(z.string()),
  validation: z.string(),
  explainSummary: z.string().optional(),
  execution: z.unknown().optional(),
  diagnostic: z.string().optional(),
  repairReason: z.string().optional(),
  durationMs: z.number().nonnegative(),
});

export type SqlAttempt = z.infer<typeof SqlAttemptSchema>;

const IntentFilterSchema = z.object({
  field: z.string(),
  operator: z.string(),
  value: z.unknown(),
});

export const SQLAnswerStatusSchema = z.enum([
  "ok",
  "no_data",
  "cannot_answer",
  "error",
]);

export const SQLAnswerSchema = z.object({
  intent: z.object({
    metric: z.string().nullable(),
    dimensions: z.array(z.string()),
    filters: z.array(IntentFilterSchema),
    timeRange: z.string().nullable(),
  }),
  sql: z.string().nullable(),
  tablesUsed: z.array(z.string()),
  citations: z.array(z.string()).default([]),
  attempts: z.array(SqlAttemptSchema).max(3),
  resultPreview: z.array(z.record(z.string(), z.unknown())).max(50),
  answerText: z.string().min(1),
  status: SQLAnswerStatusSchema,
  telemetry: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    embeddingTokens: z.number().int().nonnegative().default(0),
    estimatedCostUsd: z.number().nonnegative(),
    latencyMs: z.number().nonnegative(),
  }),
});

export type SQLAnswer = z.infer<typeof SQLAnswerSchema>;
