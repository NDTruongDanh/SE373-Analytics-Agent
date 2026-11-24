import { z } from "zod";

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
