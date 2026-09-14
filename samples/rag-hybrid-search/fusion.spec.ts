/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/fusion.spec.ts
 *
 * Demonstrates: testing an algorithm by its PROPERTIES rather than by golden
 * outputs. The central case — "a document ranked 3rd in both lists beats one
 * ranked 1st in only one" — is the behaviour that justifies hybrid search, and
 * the last test pins down what the k constant is actually for.
 */
import { RRF_K, reciprocalRankFusion } from './fusion';

const ids = (items: { id: string }[]): string[] => items.map((item) => item.id);

describe('reciprocalRankFusion', () => {
  it('returns a single list unchanged in order', () => {
    const fused = reciprocalRankFusion({
      vector: [
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0.8 },
        { id: 'c', score: 0.7 },
      ],
    });

    expect(ids(fused)).toEqual(['a', 'b', 'c']);
  });

  it('promotes a document that both lists rank well over one only one list loves', () => {
    // THE central property of RRF, and the reason hybrid search beats either arm.
    //
    // 'consensus' is 3rd in both lists:  1/63 + 1/63 = 0.03175
    // 'vectoronly' is 1st in one only:   1/61       = 0.01639
    //
    // Consensus wins, even though it was never anyone's top result.
    const fused = reciprocalRankFusion({
      vector: [
        { id: 'vectoronly', score: 0.95 },
        { id: 'filler1', score: 0.9 },
        { id: 'consensus', score: 0.85 },
      ],
      lexical: [
        { id: 'lexonly', score: 0.5 },
        { id: 'filler2', score: 0.4 },
        { id: 'consensus', score: 0.3 },
      ],
    });

    expect(fused[0].id).toBe('consensus');
    expect(fused[0].fusedScore).toBeCloseTo(1 / (RRF_K + 3) + 1 / (RRF_K + 3), 6);
  });

  it('computes fused scores as the sum of 1/(k + rank)', () => {
    const fused = reciprocalRankFusion({
      vector: [{ id: 'a', score: 0.9 }],
      lexical: [{ id: 'a', score: 0.4 }],
    });

    expect(fused[0].fusedScore).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it('records the rank and original score from each contributing list', () => {
    const fused = reciprocalRankFusion({
      vector: [
        { id: 'x', score: 0.91 },
        { id: 'y', score: 0.72 },
      ],
      lexical: [{ id: 'y', score: 0.33 }],
    });

    const y = fused.find((item) => item.id === 'y');

    expect(y?.ranks).toEqual({ vector: 2, lexical: 1 });
    expect(y?.scores).toEqual({ vector: 0.72, lexical: 0.33 });
  });

  it('keeps documents found by only one arm', () => {
    // An exact course code that embeddings miss entirely must still survive.
    const fused = reciprocalRankFusion({
      vector: [{ id: 'semantic', score: 0.8 }],
      lexical: [{ id: 'exactmatch', score: 0.9 }],
    });

    expect(ids(fused).sort()).toEqual(['exactmatch', 'semantic']);
  });

  it('ignores empty lists', () => {
    const fused = reciprocalRankFusion({
      vector: [{ id: 'a', score: 0.9 }],
      lexical: [],
    });

    expect(ids(fused)).toEqual(['a']);
  });

  it('returns an empty array when every list is empty', () => {
    expect(reciprocalRankFusion({ vector: [], lexical: [] })).toEqual([]);
  });

  it('does not double-count a duplicate id within one list', () => {
    // An upstream bug, but it must not silently promote that document.
    const fused = reciprocalRankFusion({
      vector: [
        { id: 'a', score: 0.9 },
        { id: 'a', score: 0.8 },
      ],
    });

    expect(fused).toHaveLength(1);
    expect(fused[0].fusedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it('breaks ties deterministically so retrieval is reproducible', () => {
    const run = () =>
      ids(
        reciprocalRankFusion({
          vector: [{ id: 'bbb', score: 0.5 }],
          lexical: [{ id: 'aaa', score: 0.5 }],
        }),
      );

    // Identical fused scores; without a tie-break these could swap between runs
    // and make the integration tests flaky.
    expect(run()).toEqual(run());
    expect(run()).toEqual(['aaa', 'bbb']);
  });

  it('flattens the rank curve so rank 1 does not dominate — that is what k is for', () => {
    const withK = reciprocalRankFusion(
      { vector: [{ id: 'first', score: 1 }, { id: 'second', score: 0.9 }] },
      RRF_K,
    );

    const gapWithK = withK[0].fusedScore - withK[1].fusedScore;

    const withoutK = reciprocalRankFusion(
      { vector: [{ id: 'first', score: 1 }, { id: 'second', score: 0.9 }] },
      0,
    );

    const gapWithoutK = withoutK[0].fusedScore - withoutK[1].fusedScore;

    // k=0 gives 1.0 vs 0.5 — a 50% gap. k=60 gives about 1.6%.
    expect(gapWithK).toBeLessThan(gapWithoutK / 10);
  });
});
