// Reciprocal Rank Fusion (D-18): merges pgvector cosine hits with Postgres
// FTS hits at k=60. Pure function — no DB, no network.
import { RRF_K } from "../constants.js";

export { DEFAULT_RRF_WEIGHTS, RRF_K, W_ALIAS, W_BM25, W_DENSE } from "../constants.js";

export interface FusedHit<T> {
  item: T;
  score: number;
}

// Score of one fused id from its 1-based per-side ranks (undefined when a
// side missed). Exported so callers that fuse ids can report the same
// number the fusion itself used.
export function rrfScore(
  ranks: (number | undefined)[],
  k: number = RRF_K,
  weights?: readonly number[],
): number {
  return ranks.reduce<number>(
    (sum, rank, index) =>
      sum +
      (rank === undefined ? 0 : (weights?.[index] ?? 1) / (k + rank)),
    0,
  );
}

export function fuseRRF<T>(
  lists: T[][],
  options: {
    k?: number;
    topK?: number;
    idOf?: (item: T) => string;
    weights?: readonly number[];
  } = {},
): T[] {
  const k = options.k ?? RRF_K;
  const idOf = options.idOf ?? ((item: T) => JSON.stringify(item));
  const scores = new Map<string, { score: number; firstSeen: number; item: T }>();
  let seen = 0;
  for (let listIndex = 0; listIndex < lists.length; listIndex++) {
    const list = lists[listIndex] as T[];
    const weight = options.weights?.[listIndex] ?? 1;
    list.forEach((item, index) => {
      const rank = index + 1;
      const id = idOf(item);
      const entry = scores.get(id);
      const contribution = weight / (k + rank);
      if (entry === undefined) {
        scores.set(id, { score: contribution, firstSeen: seen, item });
        seen += 1;
      } else {
        entry.score += contribution;
      }
    });
  }
  const fused = [...scores.values()];
  // Score first, first-seen order for ties: deterministic and stable.
  fused.sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen);
  const topK = options.topK ?? fused.length;
  return fused.slice(0, topK).map((entry) => entry.item);
}
