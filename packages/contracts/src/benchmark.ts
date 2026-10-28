import * as z from "zod";

// One row of the benchmark question set (PRD 2.2).
// The full 30-question set is authored by UC-01 in a later phase; this
// schema freezes the row shape so the eval runner can build against it.

export const BenchmarkRowSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  goldSql: z.string().min(1),
  goldResultPath: z.string().min(1),
  ordered: z.boolean().optional(),
  tags: z.array(z.string()).default([]),
});

export type BenchmarkRow = z.infer<typeof BenchmarkRowSchema>;
