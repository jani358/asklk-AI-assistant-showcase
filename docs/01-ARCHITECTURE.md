# 01 — Architecture

AskLK is a white-label, multi-tenant RAG chatbot. An organisation uploads its own
documents; the people it serves ask questions in Sinhala or English and get answers in
**the same language they asked in**, grounded only in those documents, with citations
back to the file and page the answer came from.

This document explains what each piece is, why it exists, exactly what happens on one
question and one upload, and what was rejected along the way.

---

## 1. What AskLK is, and who it is for

The product in one sentence: **point it at your files, embed one `<script>` tag, and your
website can answer questions about them.**

The three customers it was designed around, all Sri Lankan, all small:

| Customer | What they upload | What people ask |
|---|---|---|
| A tuition class | Syllabi, timetables, fee structures, past-paper notes | "ICT පන්තියේ ගාස්තුව කීයද?" · "When is the A/L revision class?" |
| A private clinic | Service lists, opening hours, preparation instructions, insurance notes | "Do I need to fast before a lipid profile?" · "සෙනසුරාදා විවෘතද?" |
| A small company | HR policy, leave rules, onboarding handbooks, product sheets | "How many casual leave days do I get?" · "Warranty period එක කොච්චරද?" |

Three facts about that customer set drive nearly every decision in this document:

1. **They are bilingual, and inconsistently so.** A question comes in Sinhala; the answer
   may only exist in an English PDF. The system has to bridge that, not dodge it.
2. **They are small.** One tuition class has twenty documents and maybe two hundred
   questions a month. A design that needs a vector database cluster, a worker fleet and a
   Kafka broker to answer twenty questions a day is not a product, it is a hobby with a
   bill attached.
3. **They are staking their reputation on the answers.** A teacher putting this in front
   of students cannot have it confidently invent a fee. "I could not find that" is a good
   answer. A fluent, wrong, confident answer is a product-killing answer. Everything in
   §6 exists because of this.

"White-label" means the tenant's name, logo, colour and greeting are theirs, and the
widget looks like part of their site. "Multi-tenant" means one deployment, one database,
one process serves all of them, with isolation enforced in the `WHERE` clause of every
query rather than by separate deployments.

---

## 2. System overview

Nine boxes. This is the whole thing, and it should take about two minutes on a whiteboard.

```
   ┌──────────────────────────┐        ┌──────────────────────────┐
   │  Widget (vanilla TS)     │        │  Browser — admin + chat  │
   │  <script> on any site    │        │                          │
   └───────────┬──────────────┘        └────────────┬─────────────┘
               │                                    │
               │  POST /chat/public/ask             │  HTTPS
               │  (SSE stream back)                 │
               │                       ┌────────────▼─────────────┐
               │                       │   apps/web — Next.js 14  │
               │                       │   admin dashboard        │
               │                       │   public chat page       │
               │                       └────────────┬─────────────┘
               │                                    │
               └──────────────┬─────────────────────┘
                              │  JSON + SSE
                 ┌────────────▼─────────────────────────────┐
                 │           apps/api — NestJS 10           │
                 │                                          │
                 │  auth · tenants · documents · chat       │
                 │  rag (chunk · embed · retrieve · fuse)   │
                 │  conversations · usage · health          │
                 │                                          │
                 │  ┌────────────────────────────────────┐  │
                 │  │  Ingestion worker (same process)   │  │
                 │  │  BRPOP loop on a Redis list        │  │
                 │  └────────────────────────────────────┘  │
                 └──┬──────────────┬───────────────┬────────┘
                    │              │               │
        Prisma /    │      ioredis │               │  HTTPS
        $queryRaw   │              │               │
      ┌─────────────▼────┐  ┌──────▼────────┐  ┌───▼─────────────────┐
      │  PostgreSQL 16   │  │   Redis 7     │  │   Gemini API        │
      │  + pgvector      │  │               │  │                     │
      │                  │  │ ingest queue  │  │ gemini-2.5-flash    │
      │ tenants, users   │  │ quota counters│  │   (generation, SSE) │
      │ documents        │  │ embed cache   │  │ gemini-embedding-001│
      │ chunks +         │  │ rate limits   │  │   (768-d vectors)   │
      │   vector(768)    │  └───────────────┘  └─────────────────────┘
      │   tsvector       │
      │ conversations    │       ┌──────────────────────────┐
      │ messages         │       │  File storage            │
      │ usage_counters   │       │  STORAGE_DIR/<tenant>/   │
      └──────────────────┘       │  <uuid>.pdf              │
                                 └──────────────────────────┘
```

The one structural rule worth stating up front, because it is the thing that makes this
design defensible rather than merely small: **the vectors live in the same database as the
rows they belong to.** There is no second data store to keep in sync, no dual-write, no
"the vector DB says this chunk exists but Postgres deleted it last Tuesday". One
`DELETE FROM documents` cascades the chunks and their embeddings together, in one
transaction, for free.

---

## 3. Why each component exists

### apps/api — NestJS 10 + Prisma

The system of record and the only thing that talks to Postgres, Redis or Gemini. Modules
map to the whiteboard boxes:

| Module | Responsibility | Why it is its own module |
|---|---|---|
| `auth` | Register, login, JWT access + refresh rotation, RBAC guards | The security surface concentrated in one reviewable place |
| `tenants` | Tenant settings, branding, allowed origins | Tenant root — every other row hangs off `tenantId` |
| `documents` | Upload, list, re-ingest, delete, plus the ingestion worker | The write path for the corpus |
| `rag` | Chunking, language detection, retrieval, fusion, prompt building, citation validation | Pure logic with almost no I/O — the part that is unit-testable and the part most worth getting right |
| `chat` | The pipeline itself, as an SSE generator | The read path; where quota, retrieval and generation meet |
| `conversations` | History for the admin's review screen | Different access pattern (paginated reads) from the live chat |
| `usage` | Quota reporting | Billing-adjacent; kept separate from the hot path that increments it |
| `gemini` | The only place that calls Google | One retry policy, one cache, one timeout, one error mapping |
| `health` | Liveness/readiness with real dependency checks | A load balancer needs a true answer, not `200 OK` from a process that lost Postgres |

NestJS earns its place here for the same reason it does in any project whose selling point
is that the structure is defensible: guards, interceptors and DI are first-class, so
"authentication is global and endpoints opt out with `@Public()`" is one provider
registration in `app.module.ts` rather than a discipline everyone has to remember. That
ordering is deliberate and fail-closed — a new endpoint is protected unless someone
explicitly opens it, so forgetting a decorator can never silently expose one tenant's
documents to another.

### apps/web — Next.js 14

Two audiences in one app. The **admin dashboard** (behind auth: upload documents, watch
ingestion status, read conversations, see unanswered questions, set branding and allowed
domains) and the **public chat page** (a hosted `/{slug}` chat for tenants who want a link
rather than an embed).

Next.js for the boring correct reasons: the admin side is highly interactive and behind
auth so it is client-rendered, the public chat page benefits from server rendering for the
first paint and for being linkable, and one framework gives both without a second build
pipeline.

### The widget — vanilla TypeScript

The embeddable `<script>` tag. Deliberately **not** React.

A widget is injected into someone else's page — a WordPress site, a Wix page, a school's
hand-written HTML from 2014. Shipping React means shipping ~45KB gzipped of framework into
a page that may already have a different React on it, and version conflicts in someone
else's DOM are a support nightmare you cannot debug remotely. Vanilla TS with a shadow
root gives style isolation, a bundle measured in single-digit KB, and no opinion about
what the host page is running. The cost is that the widget's UI code is more verbose than
the dashboard's. That is the right trade for code that runs on machines I will never see.

### PostgreSQL 16 + pgvector

The whole reason there is no vector database in this diagram. pgvector gives a
`vector(768)` column, a cosine-distance operator (`<=>`), and an HNSW index — which means
one SQL statement can combine a structured pre-filter (`tenantId`, `status = 'READY'`)
with vector similarity. That combination is the killer feature; see §7.

It also holds the generated `tsvector` column that powers the lexical half of hybrid
search, so **both halves of retrieval run on the same rows in the same database**, and
fusion is pure in-process arithmetic on two id lists.

### Redis 7

Four jobs, all of them things Redis is genuinely better at than Postgres:

| Use | Why Redis |
|---|---|
| Ingestion queue (`asklk:ingest`) | `BRPOP` is a blocking pop with a timeout — an idle worker costs nothing and wakes instantly. Polling Postgres every second for a table that is empty 99% of the time is a self-inflicted load. |
| Quota counters | Read on every single message. A Postgres round trip per message for a number that changes by one is a needless cost. Postgres remains the durable record. |
| Embedding cache | A 30-day cache keyed on `model:dim:taskType:sha256(text)`. Re-ingesting a document that changed in one section re-embeds almost nothing; popular questions asked in the same words are free. |
| Rate-limit counters | Sliding-window `INCR` with a TTL. Expiry is free. |

Nothing in Redis is the source of truth. Flush it and the system loses a cache, a queue
position and some hot counters — all reconstructible from Postgres, which is exactly the
property that makes it safe to treat Redis as disposable.

### Gemini API

`gemini-2.5-flash` for generation and `gemini-embedding-001` for embeddings, both on the
free tier. The embedding model is requested at **768 dimensions** rather than its native
3072 — the model is trained with Matryoshka Representation Learning, so a 768-dimension
prefix is a genuinely usable vector, not a truncation that loses the plot. §7 covers why
768 and not 3072 in full; the short version is that pgvector's indexes cap at 2000
dimensions, so 3072 could be stored but never indexed.

Note the API is asked for the reduced dimension (`outputDimensionality: 768`) rather than
the vector being sliced client-side. The server returns a correctly renormalised prefix;
slicing 3072 floats to 768 without renormalising produces vectors of the wrong magnitude,
and cosine distance over those is subtly, silently wrong.

### The ingestion worker

Runs **inside** the API process, consuming the Redis list. This is a deliberate v1 choice
with a clear upgrade path, and §8 argues it properly.

### File storage

`STORAGE_DIR/<tenantId>/<uuid>.<ext>`. The database stores a **relative** `storageKey`, so
the storage root can move from local disk to a mounted volume to an S3 prefix without
rewriting every row. The filename on disk is a UUID and never the user's — a user-supplied
name reaches the filesystem as a path, and `../../etc/passwd` or a name with a null byte
is a path-traversal write. The real name lives in a database column where it is just data.

---

## 4. Request lifecycle — one question, end to end

This is the walkthrough to be able to give from memory. Follow the numbers.

```
 Widget/Web        API (NestJS)           Redis          Postgres        Gemini
     │                  │                   │               │              │
  1  │ POST /chat/ ────►│                   │               │              │
     │ public/ask       │                   │               │              │
     │ {tenantSlug, q}  │                   │               │              │
     │                  │                   │               │              │
  2  │        Origin allow-list check ──────────────────────►│  (tenant row)│
     │        403 if not allow-listed                        │              │
  3  │        RateLimitGuard ──────────────►│ INCR ip window│              │
     │                                       │               │              │
  4  │        ★ QUOTA CHECK ───────────────►│ GET quota:… ──┼─ seed from ──►│
     │        403 if used >= monthlyQuota   │  (miss→PG)    │  usage_counters│
     │                                       │               │              │
  5  │        detectQuestionLanguage(q)  [pure, local]       │              │
  6  │        resolve/create conversation ───────────────────►│              │
     │◄─ event: meta ───│                   │               │              │
  7  │        INSERT user message ──────────────────────────►│              │
     │                  │                   │               │              │
  8  │        embed(q, RETRIEVAL_QUERY) ───►│ cache? ───────┼─ miss ───────►│
     │                  │◄──── 768 floats ──┴───────────────┴──────────────┘
     │                  │                                   │
  9  │        ┌─ vectorSearch  (HNSW, <=>, LIMIT 20) ───────►│  } in
     │        └─ lexicalSearch (GIN, ts_rank, LIMIT 20) ────►│  } parallel
     │                  │                                   │
 10  │        reciprocalRankFusion({vector, lexical}, k=60)  │   [pure]
     │        take top 5                                    │
     │                  │                                   │
 11  │        ★ SIMILARITY FLOOR: best cosine >= 0.45 ?      │   [pure]
     │             NO ──► emit NO_ANSWER_TEXT[lang],         │
     │                    persist unanswered=true, STOP ─────┼───► (no Gemini call)
     │             YES ──► continue                          │
     │                  │                                   │
     │◄─ event: sources │  (source cards built from ROWS)    │
 12  │        buildSystemInstruction + buildUserPrompt       │
 13  │        streamGenerateContent ────────────────────────────────────────►│
     │◄─ event: delta ──│◄──────────────── SSE token deltas ─────────────────┤
     │◄─ event: delta ──│                                   │              │
     │◄─ event: delta ──│◄──────────── usageMetadata on final frame ────────┤
     │                  │                                   │              │
 14  │        validateCitations(raw, chunks.length)          │   [pure]
     │        strip out-of-range [n] markers                 │
 15  │        INSERT assistant message + sources JSON ───────►│              │
 16  │        INCR quota ──────────────────►│               │              │
     │        UPSERT usage_counters ────────────────────────►│              │
     │◄─ event: done ───│                   │               │              │
```

### Why the quota check is step 4 and not step 12

Because every step after it costs money or quota.

If the quota check ran after retrieval, an over-quota tenant would still burn one
embedding call per question — and an over-quota tenant is, by definition, the one most
likely to be receiving a flood of questions. The failure mode is precisely backwards: the
tenant who has exhausted their allowance generates the most upstream cost. A scraper
hammering a public widget for a tenant that hit its cap on the 3rd of the month would
spend 28 days making free-tier embedding calls that are thrown away.

Checking first means an over-quota request costs one Redis `GET` and a 403. That is the
cheapest possible way to say no, and "the cheapest possible way to say no" is the correct
design target for any limit that exists to stop abuse.

The check reads Redis, not Postgres, because it runs on every message. When Redis is cold
— a restart, an eviction — the counter is **seeded from `usage_counters`**, not assumed to
be zero. Assuming zero would hand every tenant a free quota reset every time Redis
blinked, which is the kind of bug that is invisible until the bill arrives.

### Why the similarity floor is step 11, before the model call

Two separate reasons, and both matter.

**The correctness reason.** If the best retrieved passage is not similar enough to the
question, there is no evidence. Handing the model five irrelevant passages and asking it
to answer does not produce "I don't know" — it produces a fluent paragraph assembled from
the five least-bad passages in the corpus. That is exactly the failure that destroys trust
in a product a tuition teacher is putting in front of students. Refusing to call the model
at all makes the refusal structural rather than something we asked the model nicely to do.

**The cost reason.** Generation is the most expensive call in the pipeline — more tokens,
more latency, more of the daily free-tier budget than an embedding by a wide margin. The
floor skips that call in exactly the case where it could only produce a wrong answer. The
saving and the correctness improvement point the same way, which is the comfortable
situation to be in.

The floor is applied to the **raw cosine similarity**, not the fused score. The fused
score is a rank artefact — a sum of `1/(60+rank)` terms — with no absolute meaning, so any
threshold on it would be arbitrary. Cosine similarity lives in `[-1, 1]` and means
something on its own.

The default is `0.45`, and it is deliberately conservative for a bilingual corpus:
cross-language matches (Sinhala question, English passage) score measurably lower than
same-language ones, so a floor tuned on English-only data would reject valid hits. See
`02-RAG-EXPLAINED.md` §7.

### Other details worth narrating

- **The user's message is persisted before the answer exists** (step 7). If generation
  then fails, the question is still in history. That is what makes the "unanswered
  questions" report — the list of things the owner should add to their documents —
  complete rather than survivorship-biased.
- **Sources are sent before the answer streams** (step 11→12 boundary). The UI can render
  "reading from `fees-2025.pdf`, page 3" while the first token is still in flight, which
  is a real chunk of the perceived-latency story.
- **Both retrieval arms run in parallel** (step 9). They touch different indexes and
  neither depends on the other's output; serialising them would just add latency for
  nothing.
- **Citation validation runs on the assembled text, not per-delta** (step 14). A marker
  can be split across two network chunks — `[` arrives, then `2]` — and validating a
  partial marker would strip a valid one. The user has already seen the raw text; what is
  persisted and re-rendered on reload is the validated version. The alternative, buffering
  the whole answer before showing anything, costs the streaming UX that is the entire
  point.
- **Cancellation is wired through.** Express's `close` event becomes an `AbortSignal` that
  is combined with the generation timeout. A visitor closing the tab mid-answer aborts the
  in-flight Gemini request instead of letting it run to completion and bill quota for
  tokens nobody will read.
- **`X-Accel-Buffering: no`** on the SSE response. Without it, nginx buffers the whole
  response until its buffer fills, turning a streaming answer back into a single delayed
  blob and silently undoing the entire streaming design. This is the single most common
  "streaming works locally, not in production" cause, and it is one header.

---

## 5. Ingestion lifecycle — one upload, end to end

```
 Admin UI          API                Disk           Redis          Worker         Gemini      Postgres
    │               │                  │               │              │              │            │
 1  │ POST ────────►│                  │               │              │              │            │
    │ multipart     │                  │               │              │              │            │
    │               │ size/kind check  │               │              │              │            │
 2  │               │ write file ─────►│ <tenant>/     │              │              │            │
    │               │                  │ <uuid>.pdf    │              │              │            │
 3  │               │ INSERT document (status=QUEUED) ─────────────────────────────────────────────►│
 4  │               │ LPUSH asklk:ingest ─────────────►│              │              │            │
    │◄─ 201 {id,    │                  │               │              │              │            │
    │    QUEUED} ───│                  │               │              │              │            │
    │               │                  │               │              │              │            │
 5  │               │                  │               │◄─ BRPOP ─────┤              │            │
 6  │               │                  │               │              │ UPDATE status=PROCESSING ─►│
 7  │               │                  │◄─ readFile ───┼──────────────┤              │            │
 8  │               │                  │               │              │ extractText()│            │
    │               │                  │               │              │ → blocks     │            │
    │               │                  │               │              │   (+page no, │            │
    │               │                  │               │              │    heading)  │            │
 9  │               │                  │               │              │ chunkBlocks()│            │
    │               │                  │               │              │ 800 tok / 100 overlap     │
10  │               │                  │               │◄ cache? ─────┤              │            │
    │               │                  │               │              │ embedBatch(RETRIEVAL_     │
    │               │                  │               │              │   DOCUMENT) ►│            │
    │               │                  │               │              │◄─ 768-d ─────┤            │
    │               │                  │               │              │  (sequential, not parallel)│
    │               │                  │               │              │              │            │
11  │               │                  │               │              │ ┌── BEGIN ─────────────────►│
    │               │                  │               │              │ │ DELETE old chunks        │
    │               │                  │               │              │ │ INSERT chunk rows        │
    │               │                  │               │              │ │ UPDATE embedding=vector  │
    │               │                  │               │              │ │ UPDATE document READY    │
    │               │                  │               │              │ │ UPSERT usage_counters    │
    │               │                  │               │              │ └── COMMIT ───────────────►│
12  │ (polls) ─────►│ GET /documents ──────────────────────────────────────────────────────────────►│
    │◄─ READY,      │                  │               │              │              │            │
    │   142 chunks  │                  │               │              │              │            │
```

### The orderings that matter

**File to disk before the database row, row committed before the queue push.** A queued
job whose file does not exist yet fails on a race. A file with no row is merely an orphan
that a cleanup sweep removes. The rule is *fail toward garbage, not toward a broken job* —
garbage is cheap and invisible, a job that fails on a race is a support ticket.

**Everything from step 11 is one transaction, with a 120-second timeout.** Re-ingest
deletes the old chunks first. If that committed separately and the insert then failed, the
document would be left with **no chunks while still marked READY** — answerable in the UI
and silently empty in retrieval. That is the worst state the system can be in, strictly
worse than FAILED, because FAILED is visible. One transaction makes re-ingest
all-or-nothing. The default Prisma 5-second timeout does not survive several hundred chunk
inserts plus their vector updates on a modest database, hence the explicit raise.

**Two statements per chunk, inside that transaction.** Prisma creates the row; a separate
`$executeRaw` sets the `embedding` column, because Prisma cannot write an `Unsupported()`
column. Both are in the same transaction, so a chunk never exists without its vector.

**Embeddings are generated sequentially, not with `Promise.all`.** Firing 200 embedding
calls in parallel at a free-tier key returns 429 for most of them, and the retries then
stampede. Serialising is slower in wall-clock terms but it *finishes*. This runs in a
background job where nobody is watching a spinner, so throughput matters less than
completion — a different trade from the retrieval path, where a user is waiting and the
two arms are deliberately parallel.

**Retries distinguish transient from permanent.** Three attempts, and the requeue only
happens if the error looks transient. A Gemini 429 is worth retrying; "unsupported file
type" or "no usable text" (a scanned PDF with no text layer) will fail identically every
time, so it goes straight to `FAILED` with the message shown verbatim in the admin UI.
"Ingestion failed" with no reason gives the person who has to fix the file nothing to act
on.

**Re-ingest does not delete old chunks up front.** They stay queryable until the new ones
replace them inside the worker's transaction, so re-ingesting a working document never
leaves the assistant unable to answer in the meantime.

---

## 6. The anti-hallucination architecture, in one place

Covered in depth in `02-RAG-EXPLAINED.md` §6, but it is an architectural property, not
a prompt trick, so it belongs on the diagram too:

| Layer | Where it lives | What it catches | What it cannot catch |
|---|---|---|---|
| 1. Similarity floor | `chat.service.ts`, before the model call | The whole class of "no evidence exists, answer anyway" | A confidently wrong answer built from passages that *are* relevant |
| 2. Prompt constraints | `rag/prompt.ts`, `systemInstruction` | Most casual drift into general knowledge | A determined injection, or a model that simply ignores rule 1. **This is the weakest layer and I will say so.** |
| 3. Citation validation | `rag/citations.ts`, after streaming | Invented passage numbers, with certainty | A *valid* number attached to a claim the passage does not support |
| 4. Source cards from rows | `chat.service.ts` `toSourceCards` | Fabricated sources, structurally — cards come from retrieved rows, never from parsing model text | Nothing; this one is airtight because it does not trust the model at all |

Layer 4 is the pattern worth internalising: **the UI's trust surface is the database, not
the model's output.** An invented citation can at worst produce a marker that gets
stripped. It can never produce a source card for a document that was not retrieved,
because no code path exists that would build one.

---

## 7. Trade-offs consciously rejected

### A separate vector database (Pinecone / Qdrant / Weaviate)

The default assumption for anything RAG-shaped, and the wrong call here.

**What it would cost:** every chunk written twice, to two systems, with no shared
transaction. Delete a document in Postgres and the vector store has to be told separately —
and if that call fails, the deleted document's content is still retrievable and citable.
For a product that stores a clinic's patient-facing documents, "we deleted it but it can
still be quoted back at you" is a data-protection incident, not an untidiness.

**What it would buy:** better recall at scale, richer filter syntax, managed operations.
All real, all irrelevant at ten thousand chunks per tenant.

**The specific thing pgvector does better here:** the filter and the search are one query.

```sql
WHERE c."tenantId" = $1 AND d.status = 'READY'
ORDER BY c.embedding <=> $2::vector
```

In a standalone vector DB the tenant filter is either metadata filtering inside the vector
engine (a second-class feature in most of them, with its own recall cliffs) or a
post-filter in application code — which means the engine already read another tenant's
rows and a bug in the filter leaks them. Here the pre-filter shrinks the candidate set the
index has to consider *and* is the isolation guarantee, in the same clause.

**When I would switch:** when a single tenant's chunk count makes HNSW recall in Postgres
measurably worse than a dedicated engine, or when vector search needs to scale
independently of the transactional database. Neither is close.

### Fine-tuning a model instead of RAG

Argued properly in `02-RAG-EXPLAINED.md` §2. The architectural summary: fine-tuning
bakes knowledge into weights, and this product's knowledge changes when a teacher uploads
a new timetable on a Tuesday. A fine-tuned model cannot cite, cannot be updated in
seconds, and — decisively — **would need one model per tenant**. A hundred tenants means a
hundred fine-tunes, a hundred re-trains every time a document changes, and a hundred
model-hosting bills. It is not a close call; it is absurd.

### BullMQ instead of a plain Redis list

BullMQ is a good library. `BRPOP` is the entire feature set actually needed.

BullMQ's value is retries, scheduling, priorities, concurrency control, and a dashboard.
Retries are implemented in about ten lines in `ingestion.worker.ts` with the one policy
this domain needs (transient vs permanent error classification, which BullMQ would not
know how to do for us anyway). Scheduling, priorities and the dashboard are not needed for
a queue that is empty most of the time.

**What the plain list gives up, honestly:** `BRPOP` removes the job before the work
starts, so a job popped and then lost to a process crash is gone. The mitigation is that
the document's own `status` row is the real source of truth for "what still needs doing" —
a document stuck in `PROCESSING` past a timeout is detectable and re-queueable from the
admin UI. The proper fix is `BRPOPLPUSH` into a processing list with a reaper, and it is
the first thing to change when this matters. Naming the gap and the fix is the point;
pretending the simple version has no gap is not.

### A separate worker process

The worker runs inside the API process. One deployable, one set of environment variables,
one log stream, one health check.

The standard objection is that ingestion will block the event loop. It will not, in any
meaningful way: the work is **I/O-bound** — file reads, network calls to Gemini, database
writes — not CPU-bound. The one genuinely CPU-heavy step, PDF text extraction, is the
thing I would move first if extraction time ever showed up in API latency percentiles.

The honest cost is **coupled scaling**: more API instances means more ingestion consumers,
whether or not that is what was needed. And a memory spike from a 20MB PDF extraction sits
in the same heap as the request handlers. At current scale neither has bitten. The
extraction path is already a pure function taking a buffer and returning blocks, so
lifting it into `apps/worker` is a `main.ts` and a Dockerfile, not a refactor. **Designing
so that the extraction stays cheap is the part I would defend; having not done it yet is
the part I would concede.**

### LangChain / LlamaIndex instead of hand-written RAG

The one I would push back hardest on in an interview, because "you reinvented LangChain"
is the obvious critique and it misses what was actually built.

The entire RAG layer is five files: `chunking.ts` (223 lines), `fusion.ts` (77),
`citations.ts` (98), `language.ts` (87), `prompt.ts` (112). That is the whole thing. A
framework would replace it with a dependency tree, an abstraction layer over the Gemini
API that lags the Gemini API, and a set of defaults tuned for English.

And the defaults are the actual problem. Every number in this system is wrong for this
corpus by default:

| Decision | Framework default | What AskLK needs | Why the default fails |
|---|---|---|---|
| Token estimation | ~4 chars/token | 4 for Latin, **2 for Sinhala** | Sinhala glyphs are multi-byte and rare in BPE vocabularies; the English heuristic under-counts badly, and under-counting overflows the context window |
| Language detection | `franc`/`cld3`, hundreds of KB | 30 lines counting Unicode blocks | The problem is exactly two languages in disjoint blocks. Character counting is *more* accurate here than a general classifier, and loads no model |
| Retrieval filtering | Filter candidates by detected language | **Explicitly do not filter** | A Sinhala question must be able to match an English passage. Language filtering would break the single most important use case in the product |
| Similarity floor | Usually absent, or 0.7-ish English-tuned | 0.45, tuned for cross-language | Cross-language cosine scores run lower; an English-tuned floor rejects valid Sinhala→English hits |
| Sentence splitting | English punctuation | `.!?।` plus Sinhala conventions | Wrong splits produce chunks that start mid-thought, and an embedding of half a thought points nowhere useful |

Writing it by hand means every one of those numbers has a reason I can defend, and the
comments in the source say what the reason is. A framework would mean discovering these as
bugs, then fighting the abstraction to fix them.

**Where a framework genuinely wins, and I would use one:** multi-step agentic pipelines,
tool calling, swapping between four LLM providers, or a team that needs to move fast
without everyone understanding retrieval. None of those describe this project.

### OpenAI instead of Gemini

Three reasons, in order of honesty:

1. **Cost.** Gemini's free tier is genuinely usable for a product serving a Sri Lankan
   tuition class. `text-embedding-3-small` plus `gpt-4o-mini` is cheap but not free, and
   "free" is the difference between a product a small business can trial and one it
   cannot. When the customer is price-sensitive enough that LKR 2,000/month is a real
   decision, the upstream cost floor matters.
2. **Matryoshka embeddings.** `gemini-embedding-001` supports `outputDimensionality`,
   returning a correctly-normalised 768-dimension vector. OpenAI's `dimensions` parameter
   does the same, so this is a tie — but it is a requirement, not a nice-to-have, given the
   2000-dimension index cap, and it is worth knowing which models satisfy it.
3. **Sinhala quality.** Gemini's multilingual coverage of Sinhala is, in testing, at least
   as good as the alternatives. This is the reason I would state with the least confidence:
   I ran informal comparisons, not a benchmark, and "it seemed better" is not evidence.

**What it costs:** a single-vendor dependency with a free tier that can change terms.
Mitigated by the fact that the Gemini-specific surface is one file (`gemini.service.ts`) —
one `embed`, one `generateStream`, one retry policy. Swapping providers is a day, not a
rewrite. That containment was deliberate.

### WebSockets instead of SSE

SSE is the right tool and WebSockets would be the fashionable wrong one.

| | SSE | WebSocket |
|---|---|---|
| Direction | Server → client only | Full duplex |
| Protocol | Plain HTTP | Upgrade handshake |
| Reconnect | Built into `EventSource` | Hand-rolled |
| Proxies / corporate networks | Ordinary HTTP response | Sometimes blocked |
| Auth | Normal headers and cookies | Awkward; often a token in the query string |
| Server state | None — it is a long response | A connection registry to manage |

The data flow here is strictly one-directional: the client sends one question over an
ordinary `POST` and receives a stream of tokens back. There is no client-to-server traffic
during the stream. A WebSocket's full-duplex capability would be entirely unused, paid for
with a connection registry, a heartbeat, a reconnect implementation and an auth story that
does not fit headers.

The one real SSE limitation — six concurrent connections per domain under HTTP/1.1 — does
not bite, because the stream is a single `POST` per question that ends when the answer
ends, not a persistent subscription.

The relevant scar is the `X-Accel-Buffering: no` header. SSE's weakness is that
intermediaries can buffer it and nothing errors; it just silently stops streaming. That is
a known and fixable weakness, which I prefer to an unknown one.

---

## 8. What I would do differently, and what breaks first at scale

### What breaks first, in order

**1. Ingestion throughput, at roughly 500 documents.** Embeddings are serialised, one
network round trip each, and a 200-page PDF is several hundred chunks. Call it 300ms per
embedding: 300 chunks is 90 seconds of wall-clock for one document, and the queue is FIFO
with one consumer. A tenant uploading their whole archive on day one waits hours, and
every other tenant's uploads queue behind them.

*The fix, in order of effort:* batch the embedding endpoint (Gemini supports
`batchEmbedContents`; this alone is most of the win), then a small bounded concurrency (4-8
in flight rather than 1 or 200), then a per-tenant fair-share queue so one tenant's bulk
upload cannot starve everyone else's. That last one is the real architectural gap — a
single FIFO list has no notion of fairness, and fairness is a multi-tenant requirement, not
an optimisation.

**2. HNSW index memory, at roughly 500k chunks.** HNSW is a graph, and it wants to be in
RAM. At 768 dimensions a chunk's vector is ~3KB, so 500k chunks is ~1.5GB of vectors plus
the graph structure on top. That does not fit comfortably on the cheap VPS this is designed
for, and once the index spills to disk, query latency stops being a nice flat curve.

*The fix:* partition `chunks` by `tenantId` so each tenant's index is independently sized,
or move the vector workload to a read replica. Partitioning is the better answer because it
matches how the data is actually queried — every single retrieval query is already
`WHERE tenantId = $1`, so partition pruning is free.

**3. The in-process worker, when a tenant uploads something pathological.** A 20MB PDF with
an image-heavy layout can spike memory during extraction, in the same heap as request
handlers. Extraction is the only genuinely CPU-bound step in the system and it is the one
sharing a process with the latency-sensitive path.

*The fix:* `apps/worker`. The extraction code is already a pure function; this is
packaging, not redesign.

**4. Conversation history, silently, whenever someone gets popular.** `messages` has no
retention policy. It grows forever, the `unanswered` report scans a growing table, and
nobody notices until a query plan flips.

*The fix:* a retention window per plan tier, and moving the unanswered report to a
materialised view refreshed on a schedule.

### What I would do differently

**Re-ingest should be a new document version, not an in-place replace.** Right now
re-ingesting deletes and recreates chunks inside one transaction, which is correct but
destructive: the `chunkId` in an old message's `sources` JSON points at a row that no
longer exists. The snapshot in the JSON is why this is survivable — the admin can still
see what was cited — but a `documentVersion` column with the old version retired rather
than deleted would make citation history genuinely stable, and would make "what changed
between versions" answerable.

**I would add a reranker before the model call.** Retrieval returns 5 chunks by fused rank.
A cross-encoder reranker over the top 20 candidates is the single highest-value quality
improvement available, and it is not in v1 because it needs either a second model call
(cost, latency) or a local model (deployment weight). The architecture already leaves room
for it — the candidate set is deliberately 20 per arm, wider than the final 5 — so it slots
between fusion and the floor without disturbing anything else. I would not ship it without
an evaluation set to prove it helps, which brings me to:

**The biggest gap is that there is no evaluation harness.** Every retrieval number in this
system — 800 tokens, 100 overlap, k=60, floor 0.45, top-5, 20 candidates per arm — is
reasoned from first principles and sanity-checked by hand. Not one of them is validated
against a labelled set of questions with known-correct answers. That is the honest weakness
of the whole design, and it is the thing I would build first if this were a commercial
product rather than a portfolio piece, because **without it, every future tuning change is
a guess wearing a confident face.** A hundred question/answer pairs per language with the
expected source chunk, plus recall@5 and a citation-accuracy score in CI, would turn all of
those constants from defensible opinions into measured facts.

**I would reconsider the in-process worker earlier than I did.** Not because it is wrong
today, but because the migration gets more expensive the longer the worker and the API
share a `PrismaService`, a `ConfigService` and a module graph. The discipline that keeps it
cheap — extraction as a pure function, the job payload as a plain serialisable object — is
in place, but discipline decays and a process boundary does not.

**What I would keep without hesitation:** vectors in Postgres, the similarity floor before
the model call, source cards built from rows, and hand-written RAG. Those four are the
decisions that this product's correctness actually rests on, and each of them is
structural — they work because of where they sit in the architecture, not because someone
remembered to be careful.

---

## 9. Related documents

- `02-RAG-EXPLAINED.md` — what RAG is, embeddings, chunking, hybrid search, RRF with
  worked numbers, the anti-hallucination layers, bilingual answering.
- `03-DATABASE.md` — every table and column, the `vector(768)` decision, HNSW vs
  IVFFlat, tenant isolation, every index and the query it serves.
