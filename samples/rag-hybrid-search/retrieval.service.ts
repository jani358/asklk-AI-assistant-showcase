/**
 * SHOWCASE EXCERPT — AskLK · apps/api/src/rag/retrieval.service.ts
 *
 * Demonstrates: the two search arms that feed the fusion, written as raw
 * parameterised SQL against pgvector and PostgreSQL full-text.
 *
 * The detail worth reading for: `"tenantId" = $1` lives INSIDE both queries.
 * Tenant isolation is a WHERE clause, never a filter applied afterwards in
 * TypeScript — and because the vectors live in the same database as the rows,
 * that pre-filter also shrinks the candidate set the index must consider. A
 * standalone vector database cannot do this: the filter would be in one system
 * and the data in another.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { GeminiService } from '../gemini/gemini.service';
import { PrismaService } from '../prisma/prisma.service';
import { FusedItem, RankedItem, reciprocalRankFusion } from './fusion';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  content: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  language: string;
  /** Cosine similarity in [-1,1]. Undefined when only full-text matched it. */
  similarity?: number;
  /** ts_rank. Undefined when only the vector search matched it. */
  lexicalScore?: number;
  fusedScore: number;
}

/** Raw row shape from the vector query. */
interface VectorRow {
  id: string;
  documentId: string;
  filename: string;
  content: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  language: string;
  similarity: number;
}

interface LexicalRow extends Omit<VectorRow, 'similarity'> {
  rank: number;
}

/**
 * Hybrid retrieval over one tenant's chunks.
 *
 * Two searches, fused:
 *
 *   VECTOR (pgvector, cosine) finds passages that MEAN the same thing. This is
 *   what makes a Sinhala question retrieve an English passage at all — the two
 *   land near each other in the embedding space even though they share no
 *   characters. It is also what handles paraphrase: "how much does it cost"
 *   finds "the fee is Rs. 2000".
 *
 *   FULL-TEXT (tsvector, ts_rank) finds passages that contain the same WORDS.
 *   Embeddings are systematically bad at rare exact tokens — a course code like
 *   "GCE A/L 2025", a phone number, a person's name — because those carry little
 *   semantic weight and get smoothed away. Lexical search nails them.
 *
 * Neither alone is good enough, and the failure modes are complementary, which
 * is exactly the condition under which fusing two rankers beats both.
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  /**
   * How many candidates each arm returns before fusion.
   *
   * Deliberately wider than the final k (5). Fusion can only promote a document
   * that at least one arm surfaced, so a narrow candidate set throws away the
   * "ranked 8th by vector, 2nd by keyword" results that hybrid search exists to
   * rescue. 20 each is cheap — both indexes are fast — and gives fusion
   * something to work with.
   */
  private static readonly CANDIDATES_PER_ARM = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gemini: GeminiService,
    private readonly config: ConfigService,
  ) {}

  async retrieve(tenantId: string, question: string, topK?: number): Promise<RetrievedChunk[]> {
    const k = topK ?? this.config.get<number>('retrieval.topK', 5);

    // RETRIEVAL_QUERY, not RETRIEVAL_DOCUMENT — see GeminiService.embed.
    const queryVector = await this.gemini.embed(question, 'RETRIEVAL_QUERY');

    // Both arms run concurrently: they touch different indexes and neither
    // depends on the other's result, so serialising them would just add latency.
    const [vectorRows, lexicalRows] = await Promise.all([
      this.vectorSearch(tenantId, queryVector),
      this.lexicalSearch(tenantId, question),
    ]);

    const fused = reciprocalRankFusion({
      vector: vectorRows.map<RankedItem>((r) => ({ id: r.id, score: r.similarity })),
      lexical: lexicalRows.map<RankedItem>((r) => ({ id: r.id, score: r.rank })),
    });

    return this.hydrate(fused.slice(0, k), vectorRows, lexicalRows);
  }

  /**
   * Vector arm.
   *
   * Written as raw SQL because Prisma has no vector type. Three details matter:
   *
   * 1. `<=>` is pgvector's COSINE DISTANCE operator, and it must match the
   *    `vector_cosine_ops` the index was built with. Using `<->` (L2) here would
   *    silently skip the index and sequential-scan the whole table.
   *
   * 2. Distance is converted to similarity as `1 - distance`, so callers work in
   *    the familiar [-1,1] similarity space where higher is better and the
   *    similarity floor is meaningful.
   *
   * 3. `"tenantId" = $1` is inside this query, not applied afterwards in TypeScript.
   *    That is the tenant isolation guarantee. Filtering after retrieval would
   *    mean the database had already read another tenant's rows, and a bug in the
   *    filter would leak them. It also means the pre-filter shrinks the candidate
   *    set the index must consider, which is the pgvector-in-Postgres advantage
   *    over a standalone vector DB where the filter lives in a different system.
   */
  private async vectorSearch(tenantId: string, queryVector: number[]): Promise<VectorRow[]> {
    // pgvector's text input format. Parameterised as a single string and cast,
    // rather than interpolated — a 768-element array built into SQL text would
    // be both an injection surface and a query-plan-cache buster.
    const literal = `[${queryVector.join(',')}]`;

    return this.prisma.$queryRaw<VectorRow[]>`
      SELECT
        c.id,
        c."documentId",
        d.filename,
        c.content,
        c."pageNumber",
        c."sectionTitle",
        c.language,
        1 - (c.embedding <=> ${literal}::vector) AS similarity
      FROM chunks c
      JOIN documents d ON d.id = c."documentId"
      WHERE c."tenantId" = ${tenantId}
        AND c.embedding IS NOT NULL
        -- Only finished documents are answerable. A half-ingested document has
        -- some chunks but not all, so citing it would give a confidently
        -- incomplete answer.
        AND d.status = 'READY'
      ORDER BY c.embedding <=> ${literal}::vector
      LIMIT ${RetrievalService.CANDIDATES_PER_ARM}
    `;
  }

  /**
   * Lexical arm.
   *
   * plainto_tsquery, not to_tsquery: it takes raw user input and produces a
   * valid query, where to_tsquery would throw a syntax error on any question
   * containing an apostrophe or a stray `&`. A crash on "what's the fee?" is not
   * an acceptable failure mode for a public chat box.
   *
   * 'simple' configuration matches the generated column — a mismatch between the
   * two makes the GIN index unusable and silently sequential-scans.
   */
  private async lexicalSearch(tenantId: string, question: string): Promise<LexicalRow[]> {
    return this.prisma.$queryRaw<LexicalRow[]>`
      SELECT
        c.id,
        c."documentId",
        d.filename,
        c.content,
        c."pageNumber",
        c."sectionTitle",
        c.language,
        ts_rank(c."searchVector", plainto_tsquery('simple', ${question})) AS rank
      FROM chunks c
      JOIN documents d ON d.id = c."documentId"
      WHERE c."tenantId" = ${tenantId}
        AND d.status = 'READY'
        AND c."searchVector" @@ plainto_tsquery('simple', ${question})
      ORDER BY rank DESC
      LIMIT ${RetrievalService.CANDIDATES_PER_ARM}
    `;
  }

  /**
   * Rebuilds full rows from the fused id list.
   *
   * No extra query: every fused id came from one of the two arms, and both arms
   * already selected the columns needed. Re-fetching by id would be a needless
   * round trip.
   */
  private hydrate(
    fused: FusedItem[],
    vectorRows: VectorRow[],
    lexicalRows: LexicalRow[],
  ): RetrievedChunk[] {
    const byId = new Map<string, VectorRow | LexicalRow>();
    for (const row of lexicalRows) byId.set(row.id, row);
    // Vector rows overwrite, so `similarity` is present wherever it exists.
    for (const row of vectorRows) byId.set(row.id, row);

    return fused.flatMap((item) => {
      const row = byId.get(item.id);
      if (!row) {
        this.logger.warn(`Fused id ${item.id} had no source row — dropping`);
        return [];
      }

      return [
        {
          chunkId: row.id,
          documentId: row.documentId,
          filename: row.filename,
          content: row.content,
          pageNumber: row.pageNumber,
          sectionTitle: row.sectionTitle,
          language: row.language,
          similarity: item.scores.vector,
          lexicalScore: item.scores.lexical,
          fusedScore: item.fusedScore,
        },
      ];
    });
  }

  /**
   * Writes a chunk's embedding.
   *
   * Separate from the Prisma create because the vector column is Unsupported():
   * Prisma can insert the row but cannot set that column, so it is a second
   * statement inside the same transaction as the insert.
   */
  async writeEmbedding(
    tx: Prisma.TransactionClient,
    chunkId: string,
    vector: number[],
  ): Promise<void> {
    const literal = `[${vector.join(',')}]`;
    await tx.$executeRaw`
      UPDATE chunks SET embedding = ${literal}::vector WHERE id = ${chunkId}
    `;
  }
}
