/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/chunking.spec.ts
 *
 * Demonstrates: the tests that caught the overlap bug described in chunking.ts,
 * plus the boundary cases that matter for retrieval quality — paragraph
 * boundaries respected, a page number never spanning two chunks, and an
 * unsplittable blob hard-cut rather than left unusable.
 */
import { chunkBlocks, estimateTokens, splitParagraphs } from './chunking';

describe('estimateTokens', () => {
  it('counts English at roughly 4 characters per token', () => {
    // 40 Latin characters -> ~10 tokens.
    const text = 'a'.repeat(40);
    expect(estimateTokens(text)).toBe(10);
  });

  it('counts Sinhala denser than English, because BPE tokenisers split it harder', () => {
    const sinhala = 'ගණිතය'.repeat(8); // 40 Sinhala characters
    const english = 'a'.repeat(40);

    expect(estimateTokens(sinhala)).toBeGreaterThan(estimateTokens(english));
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('hi')).toBeGreaterThan(0);
  });
});

describe('splitParagraphs', () => {
  it('splits on blank lines', () => {
    expect(splitParagraphs('One.\n\nTwo.\n\nThree.')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('treats a single newline as a wrap, not a paragraph break', () => {
    // This is the PDF hard-wrap case: pdf-parse emits a newline at every visual
    // line end, and treating those as paragraph breaks would shatter the text.
    expect(splitParagraphs('The fee for\nGrade 11 is\nRs. 2000.')).toEqual([
      'The fee for Grade 11 is Rs. 2000.',
    ]);
  });

  it('drops empty paragraphs', () => {
    expect(splitParagraphs('One.\n\n\n\n\nTwo.')).toEqual(['One.', 'Two.']);
  });
});

describe('chunkBlocks', () => {
  const paragraph = (words: number, word = 'lorem'): string =>
    Array.from({ length: words }, () => word).join(' ');

  it('keeps a short document as one chunk', () => {
    const chunks = chunkBlocks([{ text: 'The class starts at 3pm.', pageNumber: 1 }]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('The class starts at 3pm.');
    expect(chunks[0].pageNumber).toBe(1);
  });

  it('splits a long document into multiple chunks near the target size', () => {
    // 6 paragraphs of ~500 tokens each -> well past the 800 target.
    const text = Array.from({ length: 6 }, () => paragraph(400)).join('\n\n');
    const chunks = chunkBlocks([{ text }]);

    expect(chunks.length).toBeGreaterThan(1);

    // The real contract: a chunk is at most the target plus one paragraph, and
    // a paragraph is itself capped at maxTokens (1200) by the force-split. So
    // no chunk can exceed 800 + 1200 even in the worst case.
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(2000);
    }

    // And most chunks should actually land near the target, not at the cap —
    // otherwise the overlap logic is silently inflating every chunk.
    const median = [...chunks.map((c) => c.tokenCount)].sort((a, b) => a - b)[
      Math.floor(chunks.length / 2)
    ];
    expect(median).toBeLessThanOrEqual(1300);
  });

  it('overlaps consecutive chunks so a fact on a boundary survives', () => {
    // Many SMALL paragraphs, which is the normal shape of a real document and
    // the case overlap exists for: several paragraphs fit in one chunk, so the
    // boundary falls between two of them and the tail carries context forward.
    const sentences = Array.from(
      { length: 120 },
      (_, i) => `Paragraph number ${i} states that the value of item ${i} is ${i * 7} rupees.`,
    );

    const chunks = chunkBlocks([{ text: sentences.join('\n\n') }]);
    expect(chunks.length).toBeGreaterThan(1);

    // The second chunk must open with text that also appears in the first.
    const secondStart = chunks[1].content.split(/\s+/).slice(0, 6).join(' ');
    expect(chunks[0].content).toContain(secondStart);
  });

  it('drops the overlap when one paragraph would already fill the chunk', () => {
    // The other case: each paragraph nearly fills a chunk on its own. Keeping an
    // overlap tail here would push every chunk over the target for no benefit —
    // a paragraph that was never split cannot have a fact split across it.
    const text = [
      paragraph(300, 'alpha'),
      paragraph(300, 'beta'),
      paragraph(300, 'gamma'),
    ].join('\n\n');

    const chunks = chunkBlocks([{ text }]);

    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk is one clean paragraph, not a paragraph plus a foreign tail.
    for (const chunk of chunks) {
      const distinctWords = new Set(chunk.content.split(/\s+/));
      expect(distinctWords.size).toBe(1);
    }
  });

  it('never merges two different pages into one chunk', () => {
    // A citation saying "page 3" must be true, so a chunk may not span pages.
    const chunks = chunkBlocks([
      { text: 'Page one content.', pageNumber: 1 },
      { text: 'Page two content.', pageNumber: 2 },
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].pageNumber).toBe(1);
    expect(chunks[1].pageNumber).toBe(2);
    expect(chunks[0].content).not.toContain('Page two');
  });

  it('force-splits a single paragraph that exceeds the hard cap', () => {
    // A table flattened into one run-on paragraph by the PDF extractor.
    const giant = Array.from({ length: 60 }, (_, i) => `Row ${i} has a value of ${i * 10}.`).join(
      ' ',
    );

    const chunks = chunkBlocks([{ text: giant }], { targetTokens: 100, maxTokens: 150 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(400);
    }
  });

  it('carries the section title onto every chunk from that block', () => {
    const chunks = chunkBlocks([
      { text: paragraph(500), sectionTitle: 'Fees' },
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.sectionTitle).toBe('Fees');
    }
  });

  it('tags each chunk with its own language', () => {
    const chunks = chunkBlocks([
      { text: 'The class starts at three in the afternoon on Saturday.' },
      { text: 'පන්තිය සෙනසුරාදා දින සවස තුනට ආරම්භ වේ. සියලුම සිසුන් පැමිණිය යුතුය.' },
    ]);

    expect(chunks[0].language).toBe('en');
    expect(chunks[1].language).toBe('si');
  });

  it('returns no chunks for empty input', () => {
    expect(chunkBlocks([{ text: '   \n\n  ' }])).toEqual([]);
    expect(chunkBlocks([])).toEqual([]);
  });
});
