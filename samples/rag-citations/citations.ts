/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/citations.ts
 *
 * Demonstrates: two of the four anti-hallucination layers.
 *
 * Layer 1, the similarity floor, refuses to answer BEFORE the model is called —
 * which both prevents the wrong answer and skips the most expensive call in the
 * pipeline. Layer 3, citation validation, strips any marker pointing at a
 * passage that was never retrieved.
 *
 * The design point behind both: source cards shown to the user are rendered
 * from the retrieved ROWS, never parsed out of the model's text, so an invented
 * citation can never manufacture a source.
 */

/**
 * Citation validation — anti-hallucination layer 3.
 *
 * The model is instructed to cite retrieved passages as [1], [2] where the
 * number is the position in the context block it was given. It mostly complies.
 * It sometimes does not: it invents [7] when only 5 passages were supplied, or
 * cites [3] for a claim that came from its own pretraining rather than the
 * context.
 *
 * We cannot detect the second case cheaply — that needs a second model call to
 * check entailment, which doubles cost and latency. We CAN detect the first
 * case with certainty, and that is what this module does: every marker is
 * checked against the set of passages actually retrieved, and out-of-range ones
 * are stripped from the text.
 *
 * Stripping rather than rejecting the whole answer is deliberate. A good answer
 * with one bogus marker is still a good answer; throwing it away to punish a
 * formatting slip makes the product worse. The marker disappears, the prose
 * stays, and the SOURCE CARDS the user sees are rendered from the retrieved rows
 * — never parsed out of the model's text — so an invented citation can never
 * produce a source card for a document that was not retrieved.
 */

export interface CitationValidationResult {
  /** Answer text with invalid markers removed and valid ones renumbered. */
  text: string;
  /** 1-based indices into the supplied context that the model actually used. */
  usedIndices: number[];
  /** Markers that referenced a passage that was never retrieved. */
  invalidMarkers: number[];
}

/**
 * Matches [1], [2][3] and [1, 2]. Comma-separated groups are common in model
 * output and must be expanded, or a valid [1, 9] would be kept whole with its
 * invented half intact.
 */
const CITATION_PATTERN = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export const validateCitations = (
  answer: string,
  contextLength: number,
): CitationValidationResult => {
  const usedIndices = new Set<number>();
  const invalidMarkers = new Set<number>();

  const text = answer.replace(CITATION_PATTERN, (_match, group: string) => {
    const indices = group
      .split(',')
      .map((part) => parseInt(part.trim(), 10))
      .filter((n) => Number.isFinite(n));

    const valid = indices.filter((n) => {
      const inRange = n >= 1 && n <= contextLength;
      if (!inRange) invalidMarkers.add(n);
      return inRange;
    });

    valid.forEach((n) => usedIndices.add(n));

    // Every index in the group was invented — drop the marker entirely.
    if (valid.length === 0) return '';

    return valid.map((n) => `[${n}]`).join('');
  });

  return {
    // Stripping a marker can leave " ." or a double space. Tidy it, because the
    // user should not be able to tell that anything was removed.
    text: text.replace(/\s+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim(),
    usedIndices: [...usedIndices].sort((a, b) => a - b),
    invalidMarkers: [...invalidMarkers].sort((a, b) => a - b),
  };
};

/**
 * Anti-hallucination layer 1: the similarity floor.
 *
 * If the best retrieved passage is not similar enough to the question, the
 * honest answer is "I could not find this", not a fluent paragraph assembled
 * from the five least-bad passages in the corpus. This is the single highest
 * value check in the system — without it, an empty or irrelevant corpus produces
 * confident nonsense, which is precisely what destroys trust in a product a
 * tuition teacher is putting in front of students.
 *
 * Applied to the raw cosine similarity, NOT the fused score: the fused score is
 * a rank artefact with no absolute meaning, so a threshold on it would be
 * arbitrary. Cosine similarity in [-1,1] does have absolute meaning.
 */
export const passesSimilarityFloor = (
  bestCosineSimilarity: number | undefined,
  floor: number,
): boolean => bestCosineSimilarity !== undefined && bestCosineSimilarity >= floor;

export const NO_ANSWER_TEXT: Record<'si' | 'en', string> = {
  en: 'I could not find this in the documents I have. Please ask about something covered in them, or contact the organisation directly.',
  si: 'මා සතුව ඇති ලේඛනවල මෙය සොයාගත නොහැකි විය. කරුණාකර ඒවායේ ඇතුළත් වන දෙයක් ගැන අසන්න, නැතහොත් සෘජුවම ආයතනය අමතන්න.',
};
