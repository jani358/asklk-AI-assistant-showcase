/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/chunking.ts
 *
 * Demonstrates: splitting extracted document text into retrievable passages,
 * and a bilingual token estimate (Sinhala is far denser per character in
 * byte-pair tokenisers, so it is counted at ~2 chars/token against English's 4).
 *
 * THIS FILE HAD A REAL BUG, and a unit test caught it before a single document
 * was ever ingested: the overlap tail was being prepended to a paragraph that
 * already filled the chunk on its own, pushing every chunk over target by the
 * whole overlap. The fix is the conditional near the end of chunkBlocks() —
 * keep the tail only if the incoming paragraph still leaves room for it. See
 * the corresponding test in chunking.spec.ts.
 */
import { analyseLanguage } from './language';

/**
 * Splitting extracted document text into retrievable passages.
 *
 * The size numbers, and why:
 *
 * TARGET 800 tokens. A chunk is the unit of retrieval, so its size is a trade
 * between two failure modes. Too small (100-200 tokens) and a chunk loses the
 * context that makes it answerable — "the fee is Rs. 2000" is useless without
 * the sentence naming the class. Too large (2000+) and the embedding becomes an
 * average of several unrelated topics, so it matches everything weakly and
 * nothing strongly, and the top-k prompt fills with irrelevant text. 800 holds
 * roughly 2-4 paragraphs, which is usually one complete idea.
 *
 * OVERLAP 100 tokens. Without overlap, a fact that straddles a boundary is in
 * neither chunk in full. 100 tokens is about one paragraph — enough that a
 * sentence split across the seam survives in one of the two copies. The cost is
 * ~12% more rows and embedding calls, which is cheap compared to a wrong answer.
 *
 * PARAGRAPH BOUNDARIES take priority over hitting 800 exactly. Cutting
 * mid-sentence produces a chunk that starts with half a thought, and an
 * embedding of half a thought points somewhere meaningless.
 */

export interface ChunkingOptions {
  targetTokens?: number;
  overlapTokens?: number;
  /**
   * A paragraph longer than this is force-split, because one 5000-token
   * paragraph (a table dumped as prose by the PDF extractor, typically) would
   * otherwise become a single unusable chunk.
   */
  maxTokens?: number;
}

export interface TextBlock {
  text: string;
  pageNumber?: number;
  sectionTitle?: string;
}

export interface Chunk {
  content: string;
  tokenCount: number;
  pageNumber?: number;
  sectionTitle?: string;
  language: string;
}

const DEFAULTS = {
  targetTokens: 800,
  overlapTokens: 100,
  maxTokens: 1200,
} as const;

/**
 * Token count estimate.
 *
 * Deliberately NOT a real tokeniser. Gemini's tokeniser is a remote call, and
 * running one locally means shipping a vocabulary file and a WASM build for an
 * approximation that is still not exactly Gemini's. This estimate only has to be
 * good enough to size chunks consistently and budget a prompt with headroom.
 *
 * ~4 characters per token for English. Sinhala is far denser per character in
 * byte-pair tokenisers — its glyphs are multi-byte and rarely appear in the
 * vocabulary as whole words — so Sinhala text is counted at ~2 chars/token.
 * Getting this wrong in the SAFE direction (over-counting) just makes chunks a
 * little smaller, which is harmless; under-counting could overflow the context
 * window, which is not.
 */
export const estimateTokens = (text: string): number => {
  const { sinhalaChars, latinChars } = analyseLanguage(text);
  const otherChars = Math.max(0, text.length - sinhalaChars - latinChars);

  return Math.ceil(sinhalaChars / 2 + latinChars / 4 + otherChars / 3);
};

/**
 * Splits text into paragraphs on blank lines.
 *
 * PDF extractors emit single newlines mid-paragraph for line wrapping, so only a
 * blank line (two or more newlines) is treated as a real break. Single newlines
 * are collapsed to spaces, which also removes the hard-wrap artefacts that would
 * otherwise pollute the embedding.
 */
export const splitParagraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);

/**
 * Splits one over-long paragraph at sentence boundaries.
 *
 * The sentence regex handles the Sinhala full stop (`।` is Devanagari; Sinhala
 * uses the Latin period) plus `.`, `?`, `!`. If a single "sentence" is still
 * over the cap — a table, or text with no punctuation at all — it is hard-cut on
 * whitespace, because an unsplittable blob is worse than an inelegant split.
 */
const splitLongParagraph = (paragraph: string, maxTokens: number): string[] => {
  const sentences = paragraph.match(/[^.!?।]+[.!?।]+\s*|[^.!?।]+$/g) ?? [paragraph];

  const pieces: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current + sentence;

    if (estimateTokens(candidate) > maxTokens && current) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) pieces.push(current.trim());

  // Still too big: one sentence exceeds the cap on its own. Hard-cut on words.
  return pieces.flatMap((piece) =>
    estimateTokens(piece) > maxTokens ? hardCut(piece, maxTokens) : [piece],
  );
};

const hardCut = (text: string, maxTokens: number): string[] => {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokens(current.join(' ')) >= maxTokens) {
      out.push(current.join(' '));
      current = [];
    }
  }

  if (current.length) out.push(current.join(' '));
  return out;
};

/**
 * Builds the overlap tail: the last ~overlapTokens of a chunk, cut at a sentence
 * boundary so the next chunk does not begin mid-word.
 */
const overlapTail = (content: string, overlapTokens: number): string => {
  if (overlapTokens <= 0) return '';

  const sentences = content.match(/[^.!?।]+[.!?।]+\s*|[^.!?।]+$/g) ?? [];
  const tail: string[] = [];

  // Walk backwards accumulating whole sentences until the budget is used.
  for (let i = sentences.length - 1; i >= 0; i--) {
    tail.unshift(sentences[i]);
    if (estimateTokens(tail.join('')) >= overlapTokens) break;
  }

  return tail.join('').trim();
};

/**
 * Chunks a sequence of text blocks.
 *
 * Blocks carry page numbers and headings from the extractor. A chunk never spans
 * two blocks with DIFFERENT page numbers, because a citation that says "page 3"
 * must be true — merging pages 3 and 4 into one chunk would make every citation
 * on it half wrong.
 */
export const chunkBlocks = (blocks: TextBlock[], options: ChunkingOptions = {}): Chunk[] => {
  const targetTokens = options.targetTokens ?? DEFAULTS.targetTokens;
  const overlapTokens = options.overlapTokens ?? DEFAULTS.overlapTokens;
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;

  const chunks: Chunk[] = [];

  for (const block of blocks) {
    const paragraphs = splitParagraphs(block.text).flatMap((paragraph) =>
      estimateTokens(paragraph) > maxTokens
        ? splitLongParagraph(paragraph, maxTokens)
        : [paragraph],
    );

    let current = '';

    const flush = (): void => {
      const content = current.trim();
      if (!content) return;

      chunks.push({
        content,
        tokenCount: estimateTokens(content),
        pageNumber: block.pageNumber,
        sectionTitle: block.sectionTitle,
        language: analyseLanguage(content).language,
      });

      // Seed the next chunk with the overlap tail of this one.
      current = overlapTail(content, overlapTokens);
      if (current) current += ' ';
    };

    for (const paragraph of paragraphs) {
      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

      // Flush BEFORE adding the paragraph that would overshoot, so chunks stay
      // at or under target rather than one paragraph over it.
      if (estimateTokens(candidate) > targetTokens && current.trim()) {
        flush();

        /**
         * `flush()` seeded `current` with the previous chunk's overlap tail.
         * Keep that tail only if the incoming paragraph still leaves room for
         * it — otherwise the chunk would be tail + a full-size paragraph, which
         * overshoots the target by the whole overlap.
         *
         * Dropping the tail here costs nothing: overlap exists to stop a fact
         * being split across a boundary, and a paragraph that fills a chunk on
         * its own was never split in the first place.
         */
        current =
          current && estimateTokens(`${current}${paragraph}`) <= targetTokens
            ? `${current}${paragraph}`
            : paragraph;
      } else {
        current = candidate;
      }
    }

    flush();
    // The tail left in `current` belongs to the block that just ended; do not
    // carry it into the next block, whose page number would be different.
    current = '';
  }

  return chunks;
};
