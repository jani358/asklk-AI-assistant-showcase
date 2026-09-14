/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/fusion.ts
 *
 * Demonstrates: how two ranked result lists with incomparable score scales are
 * merged into one. This is the heart of hybrid search — the reason a Sinhala
 * question can retrieve an English passage AND an exact course code still wins
 * on keyword match. See fusion.spec.ts alongside for the property tests.
 */

/**
 * Reciprocal Rank Fusion — merging the vector and full-text result lists.
 *
 * The problem RRF solves: cosine similarity returns scores in [-1, 1] and
 * Postgres ts_rank returns an unbounded positive number whose scale depends on
 * document length and term frequency. There is no principled way to add them.
 * Normalising each list to [0,1] does not fix it either — min-max normalisation
 * makes the best result in a list of terrible results look perfect.
 *
 * RRF throws the scores away and uses only RANK, which both lists agree on the
 * meaning of. A document's fused score is the sum over lists of 1/(k + rank).
 *
 * The k constant (60, from Cormack et al. 2009, and still the field default)
 * flattens the curve near the top: without it, rank 1 would score 1.0 and rank 2
 * only 0.5, so whichever list happened to rank something first would dominate.
 * With k=60 the gap between rank 1 and rank 2 is about 1.6%, which means a
 * document appearing at rank 3 in BOTH lists beats one at rank 1 in only one —
 * exactly the behaviour that makes hybrid search better than either half.
 */

export interface RankedItem {
  id: string;
  /** The list's own score. Carried through for display and the similarity floor,
   *  never used in the fusion arithmetic itself. */
  score: number;
}

export interface FusedItem {
  id: string;
  fusedScore: number;
  /** Rank in each contributing list, 1-based. Absent where the list missed it. */
  ranks: Record<string, number>;
  /** Original scores by list name, so the caller can still apply a similarity
   *  floor to the vector score after fusion. */
  scores: Record<string, number>;
}

export const RRF_K = 60;

/**
 * @param lists named result lists, each already sorted best-first
 * @param k rank-smoothing constant
 */
export const reciprocalRankFusion = (
  lists: Record<string, RankedItem[]>,
  k: number = RRF_K,
): FusedItem[] => {
  const merged = new Map<string, FusedItem>();

  for (const [listName, items] of Object.entries(lists)) {
    items.forEach((item, index) => {
      const rank = index + 1;

      let entry = merged.get(item.id);
      if (!entry) {
        entry = { id: item.id, fusedScore: 0, ranks: {}, scores: {} };
        merged.set(item.id, entry);
      }

      // Guard against a list containing the same id twice (a bug upstream, but
      // it would otherwise double-count and silently promote that document).
      if (entry.ranks[listName] !== undefined) return;

      entry.ranks[listName] = rank;
      entry.scores[listName] = item.score;
      entry.fusedScore += 1 / (k + rank);
    });
  }

  return [...merged.values()].sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    // Deterministic tie-break. Without it, two documents with identical fused
    // scores can swap places between requests, which makes retrieval
    // irreproducible and the integration tests flaky.
    return a.id.localeCompare(b.id);
  });
};
