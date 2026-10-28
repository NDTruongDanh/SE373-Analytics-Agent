// Reciprocal Rank Fusion (D-18): merges pgvector cosine hits with Postgres
// FTS hits at k=60. Pure function — no DB, no network.
export interface FusedHit<T> {
  item: T;
  score: number;
}

export const RRF_K = 60;

// Score of one fused id from its 1-based per-side ranks (undefined when a
// side missed). Exported so callers that fuse ids can report the same
// number the fusion itself used.
export function rrfScore(
  ranks: (number | undefined)[],
  k: number = RRF_K,
): number {
  return ranks.reduce<number>(
    (sum, rank) => sum + (rank === undefined ? 0 : 1 / (k + rank)),
    0,
  );
}

export function fuseRRF<T>(
  lists: T[][],
  options: {
    k?: number;
    topK?: number;
    idOf?: (item: T) => string;
  } = {},
): T[] {
  const k = options.k ?? RRF_K;
  const idOf = options.idOf ?? ((item: T) => JSON.stringify(item));
  const scores = new Map<string, { score: number; firstSeen: number; item: T }>();
  let seen = 0;
  for (const list of lists) {
    list.forEach((item, index) => {
      const rank = index + 1;
      const id = idOf(item);
      const entry = scores.get(id);
      const contribution = 1 / (k + rank);
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
