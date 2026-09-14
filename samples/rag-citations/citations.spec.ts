/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/citations.spec.ts
 *
 * Demonstrates: testing an anti-hallucination guard against the ways a model
 * actually misbehaves — an invented index, a mixed group like [1, 9] where half
 * is real, index 0, and the same thing in Sinhala.
 */
import { passesSimilarityFloor, validateCitations } from './citations';

describe('validateCitations', () => {
  it('keeps citations that refer to a retrieved passage', () => {
    const result = validateCitations('The fee is Rs. 2000 [1] per month [2].', 5);

    expect(result.text).toBe('The fee is Rs. 2000 [1] per month [2].');
    expect(result.usedIndices).toEqual([1, 2]);
    expect(result.invalidMarkers).toEqual([]);
  });

  it('strips a citation to a passage that was never retrieved', () => {
    // The model invented [7] when only 3 passages were supplied.
    const result = validateCitations('The class is on Saturday [7].', 3);

    expect(result.text).toBe('The class is on Saturday.');
    expect(result.invalidMarkers).toEqual([7]);
    expect(result.usedIndices).toEqual([]);
  });

  it('keeps the valid half of a mixed group and drops the invented half', () => {
    const result = validateCitations('The fee is Rs. 2000 [1, 9].', 3);

    expect(result.text).toBe('The fee is Rs. 2000 [1].');
    expect(result.usedIndices).toEqual([1]);
    expect(result.invalidMarkers).toEqual([9]);
  });

  it('expands comma groups so an invented index cannot hide inside a valid one', () => {
    const result = validateCitations('Both apply [1, 2, 3].', 3);

    expect(result.text).toBe('Both apply [1][2][3].');
    expect(result.usedIndices).toEqual([1, 2, 3]);
  });

  it('handles adjacent markers', () => {
    const result = validateCitations('See here [1][2].', 2);
    expect(result.usedIndices).toEqual([1, 2]);
    expect(result.invalidMarkers).toEqual([]);
  });

  it('rejects index 0 — passages are 1-based', () => {
    const result = validateCitations('Something [0].', 3);
    expect(result.invalidMarkers).toEqual([0]);
    expect(result.text).toBe('Something.');
  });

  it('tidies the whitespace a stripped marker leaves behind', () => {
    // The user must not be able to tell that anything was removed.
    const result = validateCitations('The class is on Saturday [9] , at 3pm.', 2);

    expect(result.text).not.toContain('  ');
    expect(result.text).not.toContain(' ,');
  });

  it('leaves an answer with no citations alone', () => {
    const text = 'I could not find this in the documents I have.';
    expect(validateCitations(text, 0).text).toBe(text);
  });

  it('strips every marker when no passages were supplied at all', () => {
    const result = validateCitations('The fee is Rs. 2000 [1].', 0);

    expect(result.text).toBe('The fee is Rs. 2000.');
    expect(result.invalidMarkers).toEqual([1]);
  });

  it('works on Sinhala answers', () => {
    const result = validateCitations('මාසික ගාස්තුව රුපියල් 2000කි [1]. පන්තිය සෙනසුරාදා [8].', 2);

    expect(result.usedIndices).toEqual([1]);
    expect(result.invalidMarkers).toEqual([8]);
    expect(result.text).toContain('රුපියල් 2000කි [1]');
    expect(result.text).not.toContain('[8]');
  });

  it('does not treat a bracketed non-number as a citation', () => {
    const text = 'The syllabus [see appendix] covers three units.';
    expect(validateCitations(text, 3).text).toBe(text);
  });
});

describe('passesSimilarityFloor', () => {
  it('passes when the best match is at or above the floor', () => {
    expect(passesSimilarityFloor(0.6, 0.45)).toBe(true);
    expect(passesSimilarityFloor(0.45, 0.45)).toBe(true);
  });

  it('fails when the best match is below the floor', () => {
    expect(passesSimilarityFloor(0.3, 0.45)).toBe(false);
  });

  it('fails when nothing was retrieved at all', () => {
    // An empty corpus, or a question that matched no chunk. Answering here would
    // be pure invention, which is the exact failure this floor exists to stop.
    expect(passesSimilarityFloor(undefined, 0.45)).toBe(false);
  });

  it('fails on a negative similarity', () => {
    expect(passesSimilarityFloor(-0.2, 0.45)).toBe(false);
  });
});
