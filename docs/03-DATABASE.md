# 03 — Database

PostgreSQL 16 with the `vector` and `pg_trgm` extensions, accessed through Prisma — except
for the three things Prisma cannot express, which are hand-written SQL in the initial
migration.

This document covers every table, every column and why it is shaped that way; the
`vector(768)` decision in full; the generated `tsvector` column; HNSW versus IVFFlat; the
tenant isolation rule; every index and the query it serves; and what changes at 10× and
100× the data.

---

## 1. Two rules that run through the whole schema

Before any table, the two invariants stated at the top of `schema.prisma`, because
everything else follows from them:

> **1. Every tenant-owned row carries `tenantId`, and every index that serves a query
> starts with `tenantId`.** Isolation is enforced in the `WHERE` clause of each query,
> never by application logic alone.
>
> **2. The embedding vector lives in Postgres via pgvector, not a separate vector
> database.** That lets one SQL statement combine a structured pre-filter (tenant, document
> status) with vector similarity, and keeps chunks transactionally consistent with the
> documents they came from.

Rule 1 is a security property and §8 covers how it is actually enforced. Rule 2 is an
architecture property and §4 and §6 cover what it buys.

---

## 2. ER diagram

```
 ┌──────────────────────────────────┐
 │            tenants               │   the tenant root — everything cascades from here
 │──────────────────────────────────│
 │ id                   text  PK    │
 │ slug                 text  U     │ ← public, in the widget <script> tag
 │ name                 text        │
 │ logoUrl              text?       │
 │ primaryColor         text        │
 │ greetingEn           text        │
 │ greetingSi           text        │
 │ allowedDomains       text[]      │ ← empty = fail closed
 │ monthlyMessageQuota  int         │
 │ createdAt/updatedAt  ts          │
 └──┬────────┬────────┬────────┬────┘
    │1       │1       │1       │1
    │N       │N       │N       │N
    │        │        │        └──────────────────────────────────┐
    │        │        │                                           │
    │        │        └─────────────────┐                         │
    │        │                          │                         │
    │   ┌────▼──────────────────────┐   │                   ┌─────▼──────────────────────┐
    │   │        documents          │   │                   │      usage_counters        │
    │   │───────────────────────────│   │                   │────────────────────────────│
    │   │ id            text  PK    │   │                   │ id              text PK    │
    │   │ tenantId      text  FK    │   │                   │ tenantId        text FK    │
    │   │ filename      text        │   │                   │ period          text       │ 'YYYY-MM'
    │   │ kind          enum        │   │                   │ messageCount    int        │
    │   │ sizeBytes     int         │   │                   │ promptTokens    int        │
    │   │ storageKey    text        │   │                   │ completionTokens int       │
    │   │ status        enum        │   │                   │ documentsIngested int      │
    │   │ errorMessage  text?       │   │                   │ updatedAt       ts         │
    │   │ language      text?       │   │                   │  U(tenantId, period)       │
    │   │ pageCount     int?        │   │                   └────────────────────────────┘
    │   │ chunkCount    int         │   │
    │   │ createdAt/updatedAt ts    │   │
    │   │ ingestedAt    ts?         │   │
    │   └────┬──────────────────────┘   │
    │        │1                          │
    │        │N                          │
    │   ┌────▼────────────────────────┐ │
    │   │          chunks             │ │  ← the row a RAG answer cites
    │   │─────────────────────────────│ │
    │   │ id            text  PK      │ │
    │   │ tenantId      text  FK ─────┼─┘
    │   │ documentId    text  FK      │
    │   │ ordinal       int           │
    │   │ content       text          │
    │   │ pageNumber    int?          │
    │   │ sectionTitle  text?         │
    │   │ language      text          │ ← NOT a retrieval filter
    │   │ tokenCount    int           │
    │   │ embedding     vector(768)?  │ ← hand-written SQL; HNSW index
    │   │ searchVector  tsvector      │ ← GENERATED ALWAYS … STORED; GIN index
    │   │ createdAt     ts            │
    │   └─────────────────────────────┘
    │
    │        ┌──────────────────────────┐
    │        │      conversations       │
    │        │──────────────────────────│
    ├───────►│ id           text  PK    │
    │        │ tenantId     text  FK    │
    │        │ visitorId    text?       │ ← anonymous localStorage id
    │        │ title        text?       │ ← first question, truncated
    │        │ createdAt/updatedAt ts   │
    │        └────┬─────────────────────┘
    │             │1
    │             │N
    │        ┌────▼─────────────────────┐
    │        │        messages          │
    │        │──────────────────────────│
    │        │ id            text  PK   │
    │        │ conversationId text FK   │
    │        │ role          enum       │  USER | ASSISTANT
    │        │ content       text       │
    │        │ language      text?      │
    │        │ sources       jsonb?     │ ← denormalised citation snapshot
    │        │ unanswered    bool       │ ← powers the gap report
    │        │ helpful       bool?      │
    │        │ promptTokens  int?       │
    │        │ completionTokens int?    │
    │        │ latencyMs     int?       │
    │        │ createdAt     ts         │
    │        └──────────────────────────┘
    │
    │   ┌───────────────────────────┐        ┌────────────────────────────┐
    │   │          users            │        │      refresh_tokens        │
    │   │───────────────────────────│        │────────────────────────────│
    └──►│ id           text  PK     │        │ id          text  PK       │
        │ tenantId     text  FK     │        │ userId      text  FK ──────┼──┐
        │ email        text         │        │ tokenHash   text  U        │  │
        │ passwordHash text         │        │ expiresAt   ts             │  │
        │ name         text         │        │ revokedAt   ts?            │  │
        │ role         enum         │        │ createdAt   ts             │  │
        │ createdAt/updatedAt ts    │◄───────┴────────────────────────────┘  │
        │  U(tenantId, email)       │                                        │
        └───────────────────────────┘◄───────────────────────────────────────┘

  U = UNIQUE      ts = TIMESTAMP(3)      ? = nullable
  Every FK to tenants is ON DELETE CASCADE.
```

---

## 3. Tables, column by column

### `tenants`

An organisation. The tenant root: every other business row hangs off `tenantId`, which is
what makes both data isolation (§8) and any future partitioning (§10) possible.

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | UUID, not an autoincrement. IDs appear in API responses; sequential integers leak business volume and make enumeration trivial. |
| `slug` | `text` UNIQUE | URL-safe public identifier. **Deliberately not a secret** — the widget embeds it in a `<script>` tag on a public page, so treating it as a credential would be self-deception. What actually stops abuse is the origin allow-list, per-IP rate limiting and the monthly quota, not the obscurity of this string. |
| `name` | `text` | Shown in the widget header and injected into the system instruction (`You are the assistant for "…"`). |
| `logoUrl` | `text?` | Branding. Nullable — a tenant without a logo is normal, not an error. |
| `primaryColor` | `text` DEFAULT `'#2563eb'` | Widget accent colour. A default means a tenant is embeddable the moment they sign up, with no branding step. |
| `greetingEn`, `greetingSi` | `text` | Greeting before the first message, **stored per language** so the widget can switch without a round trip. Two columns rather than a JSON blob because there are exactly two languages and both are always needed — a `jsonb` here would buy flexibility nobody has asked for and lose column-level defaults. |
| `allowedDomains` | `text[]` DEFAULT `'{}'` | Origins allowed to embed the widget. **An empty array means "not configured" and the widget is refused** — fail-closed, so a half-set-up tenant cannot be embedded anywhere. A Postgres array rather than a join table because it is read on every public request, is never queried *by* domain, and never grows past a handful of entries. |
| `monthlyMessageQuota` | `int` DEFAULT `1000` | Messages per calendar month. Per-tenant so a paid plan is a column update, not a schema change. Enforced in Redis with `usage_counters` as the durable backstop. |
| `createdAt`, `updatedAt` | `TIMESTAMP(3)` | Prisma's `@updatedAt` maintains the second. |

### `users`

Admin accounts — the people who log in to the dashboard. **Not** the people who ask
questions; most askers never sign in and are tracked only as an anonymous `visitorId`.

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | As above. |
| `tenantId` | `text` FK | Which organisation this account belongs to. |
| `email` | `text` | Not globally unique — see the composite key below. |
| `passwordHash` | `text` | bcrypt output. Named `_hash` so nobody ever writes a plaintext password into it by accident. |
| `name` | `text` | Display name in the dashboard. |
| `role` | `enum Role` | `OWNER \| ADMIN \| MEMBER`. An enum, not a string: the database refuses a typo'd role, so an RBAC check can never silently fail open on `'admni'`. |
| `createdAt`, `updatedAt` | `TIMESTAMP(3)` | |

**`@@unique([tenantId, email])`, not `@@unique([email])`.** The same person can legitimately
hold an account at two organisations using one email address — a freelance administrator
working for two tuition classes is a completely ordinary case. Making email globally unique
would force them to invent a second address, which is a product bug dressed as a constraint.

**`@@index([email])` as well.** Login happens *before* a tenant is known — the user types an
email and a password, not an organisation. So email needs its own index even though it is
not unique on its own; the composite unique index cannot serve a lookup that does not know
`tenantId`, because `tenantId` is its leading column.

### `refresh_tokens`

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `userId` | `text` FK | Cascades from `users`. |
| `tokenHash` | `text` UNIQUE | **SHA-256 of the token; the raw token is never stored.** A database dump therefore does not hand an attacker live sessions. SHA-256 rather than bcrypt because the token is already 256+ bits of CSPRNG entropy — there is nothing to brute force — and this is looked up on *every* refresh, where bcrypt's deliberate cost would be a per-request tax for no security gain. Hashing a high-entropy secret is a different problem from hashing a human-chosen password, and using the password tool for it is a common and expensive mistake. |
| `expiresAt` | `TIMESTAMP(3)` | Absolute expiry, independent of the JWT's own claim. |
| `revokedAt` | `TIMESTAMP(3)?` | Set on rotation. **Presenting a revoked token means it was replayed**, which triggers family-wide revocation — the standard refresh-token-rotation theft detection. Null means live. |
| `createdAt` | `TIMESTAMP(3)` | |

### `documents`

A file the tenant uploaded. The file itself lives on disk; this row is the metadata **and
the ingestion state machine**.

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `tenantId` | `text` FK | |
| `filename` | `text` | The **display** name, capped at 200 chars. Rendered in the admin UI and in public source cards. It is deliberately not the name on disk — see `storageKey`. |
| `kind` | `enum DocumentKind` | `PDF \| DOCX \| TXT`. An enum because the extractor dispatches on it; a free-text MIME string would let an unhandled value reach a `switch` with no case. |
| `sizeBytes` | `int` | Shown in the UI, and checked against `MAX_UPLOAD_MB`. |
| `storageKey` | `text` | Path **relative** to `STORAGE_DIR`, shaped `<tenantId>/<uuid>.<ext>`. Relative so the storage root can move (local disk → mounted volume → S3 prefix) without rewriting every row. The filename is a UUID and **never the user's**: a user-supplied name reaches the filesystem as a path, so `../../etc/passwd` or a name containing a null byte is a path-traversal write. A UUID removes the entire bug class; the real name lives in `filename`, where it is just data. |
| `status` | `enum DocumentStatus` | `QUEUED \| PROCESSING \| READY \| FAILED`. The state machine below. |
| `errorMessage` | `text?` | Populated only when `FAILED`, capped at 500 chars, **surfaced verbatim in the admin UI**. "Ingestion failed" with no reason gives the person who has to fix the file nothing to act on. |
| `language` | `text?` | `'si' \| 'en' \| 'mixed'`, filled in after extraction. Descriptive metadata for the UI, not a filter. |
| `pageCount` | `int?` | From the extractor. Nullable because `.txt` has no pages. |
| `chunkCount` | `int` DEFAULT `0` | Denormalised from `chunks`. The admin list shows it for every row; a `COUNT(*)` subquery per row on every page load would be a needless N+1 on a number that changes only at ingestion. |
| `createdAt`, `updatedAt` | `TIMESTAMP(3)` | |
| `ingestedAt` | `TIMESTAMP(3)?` | When it last became `READY`. Distinct from `updatedAt`, which moves on any change including a failed attempt. |

**The status state machine:**

```
              upload
                │
                ▼
           ┌─────────┐   worker BRPOPs the job
           │ QUEUED  │──────────────────┐
           └─────────┘                  ▼
                ▲                 ┌────────────┐
                │                 │ PROCESSING │
      re-ingest │                 └─────┬──────┘
      (or a     │          success      │      failure
       retryable│      ┌────────────────┴───────────────┐
       error    │      ▼                                ▼
       requeue) │  ┌───────┐                       ┌────────┐
                └──┤ READY │                       │ FAILED │
                   └───────┘                       └────────┘
                       ▲                                │
                       └──── re-ingest ─────────────────┘

  Only READY documents are retrievable:  AND d.status = 'READY'  in both arms.
```

`READY` is the only answerable state, and both retrieval queries enforce it. A
half-ingested document has *some* chunks but not all, so citing it would give a confidently
incomplete answer — which is worse than no answer, because the user cannot tell it is
incomplete.

### `chunks`

One retrievable passage. **This is the row a RAG answer cites**, and it is the table
everything in `02-RAG-EXPLAINED.md` operates on.

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | Referenced from `messages.sources` as a snapshot. |
| `tenantId` | `text` FK | Denormalised from `documents` deliberately. Retrieval filters by tenant, and going through `documents` would mean a join before the vector index could be pruned. This column is what lets `chunks_tenantId_idx` and the HNSW index be used together on the chunk table alone. **Denormalisation for isolation, which is the one kind of denormalisation always worth taking.** |
| `documentId` | `text` FK | Which file it came from. Cascade-deletes with the document. |
| `ordinal` | `int` | Position within the document. Used to fetch neighbouring chunks when an answer needs slightly more context than the matched passage alone. |
| `content` | `text` | The passage. ~800 tokens by construction. Also the input to the generated `searchVector`. |
| `pageNumber` | `int?` | So the UI can say "notes.pdf, page 3". Nullable for formats without pages. Chunks never span pages, which is what makes this citation true rather than approximately true. |
| `sectionTitle` | `text?` | The heading the chunk sat under, when the extractor could find one. Improves citations and gives the model a little orientation. |
| `language` | `text` DEFAULT `'en'` | `'si' \| 'en' \| 'mixed'`. **Retrieval does not filter on this.** A Sinhala question must still be able to match English source text — that is the core use case, not an edge case. The column exists to tell the model what language the evidence is in, and for admin display. |
| `tokenCount` | `int` | Cached at ingestion so the prompt builder can budget the context window without re-tokenising every candidate on every request. |
| `embedding` | `vector(768)?` | §4. Added by migration SQL; Prisma declares it `Unsupported()` and only ever reads/writes it through `$queryRaw`. Nullable because the row is inserted by Prisma and the vector is set by a second statement in the same transaction. |
| `searchVector` | `tsvector` GENERATED STORED | §5. Also `Unsupported()` — Prisma needs to know it exists only so it does not try to drop it. |
| `createdAt` | `TIMESTAMP(3)` | |

### `conversations`

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | The widget stores this to continue a thread. |
| `tenantId` | `text` FK | |
| `visitorId` | `text?` | An anonymous browser identity — a random id the widget keeps in `localStorage`, truncated to 64 chars on write. **Not a user account.** Most askers never sign in, and the product would be much worse if they had to. Nullable because a conversation from the dashboard's test console has no visitor. |
| `title` | `text?` | The first question, truncated to 120 chars. Pure denormalisation: it saves a join (and an ordered subquery) when listing conversations in the admin UI, and the first question is a genuinely good title. |
| `createdAt`, `updatedAt` | `TIMESTAMP(3)` | `updatedAt` is explicitly touched on every new message so the admin's list orders by real activity rather than creation time. |

### `messages`

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `conversationId` | `text` FK | Cascades. |
| `role` | `enum MessageRole` | `USER \| ASSISTANT`. |
| `content` | `text` | For an assistant message this is the **validated** text — markers stripped and whitespace tidied — not the raw stream the user saw. What is re-rendered on reload is the corrected version. |
| `language` | `text?` | The detected language of a `USER` message, or the language an `ASSISTANT` message was instructed to answer in. Makes "how many Sinhala questions do we get?" a `GROUP BY`. |
| `sources` | `jsonb?` | Snapshot of the cited chunks: `[{chunkId, documentId, filename, pageNumber, snippet, similarity}]`. **Denormalised deliberately.** The admin must be able to see what the bot cited even after the document has been re-ingested or deleted — and at that point the live `chunks` rows no longer exist. A foreign key here would either block document deletion or cascade the history away; neither is acceptable. `jsonb` rather than `json` because it is occasionally queried, and rather than a `message_sources` table because it is only ever read whole, alongside its message. |
| `unanswered` | `bool` DEFAULT `false` | True when retrieval fell below the similarity floor and the bot declined. Powers the **"unanswered questions" report** — the list of things the owner should add to their documents. This turns a refusal from a dead end into the most useful product feedback in the system. |
| `helpful` | `bool?` | Admin feedback on an assistant answer. `null` = not reviewed, which is why it is a nullable boolean rather than a boolean with a default: "not reviewed" and "reviewed and not helpful" are different facts. |
| `promptTokens`, `completionTokens` | `int?` | From Gemini's `usageMetadata`. Cost attribution per message. |
| `latencyMs` | `int?` | Wall clock from request start to persist. Kept **per message** so a slow tenant can be diagnosed from the database without external tracing — a deliberate choice for a product that will be self-hosted by people with no observability stack. |
| `createdAt` | `TIMESTAMP(3)` | |

### `usage_counters`

Durable monthly usage, one row per tenant per month. Redis holds the hot counter the quota
guard reads on every message; **this table is the record that survives a Redis flush** and
backs the usage page and any future invoice.

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `tenantId` | `text` FK | |
| `period` | `text` | `'YYYY-MM'` in UTC. A **string**, not a date, because it is only ever compared for equality and grouped on — and because it makes the composite unique key obvious to anyone reading the schema. A `date` column would invite range queries that would then need a `date_trunc`, and would raise a "which day of the month is this?" question that has no answer. |
| `messageCount` | `int` DEFAULT `0` | What the quota is actually checked against. |
| `promptTokens`, `completionTokens` | `int` DEFAULT `0` | Embedding + generation tokens, for cost attribution. |
| `documentsIngested` | `int` DEFAULT `0` | Incremented inside the ingestion transaction, so it is exactly consistent with the documents that actually became `READY`. |
| `updatedAt` | `TIMESTAMP(3)` | |

**`@@unique([tenantId, period])`** is what makes the whole thing work: it is the target of
the `upsert` on every message, so concurrent messages from the same tenant cannot create
two rows for the same month. Without it, two simultaneous requests both find no row and
both insert, and the quota silently doubles.

---

## 4. The `vector(768)` column

```sql
ALTER TABLE "chunks" ADD COLUMN "embedding" vector(768);
```

One line, and it is the most consequential line in the schema. Four things to justify:
why pgvector at all, why 768, why not 3072, and why the dimension is validated at boot.

### Why the vector lives here at all

Covered in `01-ARCHITECTURE.md` §7, but the database-level version: because the filter
and the search become one query.

```sql
WHERE c."tenantId" = $1 AND c.embedding IS NOT NULL AND d.status = 'READY'
ORDER BY c.embedding <=> $2::vector
LIMIT 20
```

The tenant filter runs **before** the ranking, in the same statement, on the same rows. In a
standalone vector database the tenant filter is either a second-class metadata feature
inside the engine or a post-filter in application code — and a post-filter means the engine
already read another tenant's rows, so a bug in the filter leaks them. Here it cannot: the
database never selected them.

It also means `DELETE FROM documents WHERE id = $1` removes the chunks *and* their vectors
in one transaction, via the cascade. There is no second system to tell, no dual-write to
get wrong, and no state in which a deleted document's content is still retrievable.

### Why 768 and not 3072 — the hard reason

`gemini-embedding-001` natively produces **3072** dimensions. AskLK asks it for 768.

**Reason 1, and it is disqualifying on its own: pgvector's HNSW and IVFFlat indexes cap at
2000 dimensions.**

A `vector(3072)` column is perfectly legal. Postgres will store it. Queries will return
correct results. And `CREATE INDEX … USING hnsw` will **fail**, because the index access
method refuses anything over 2000 dimensions. Which means every single retrieval query
becomes:

```
Seq Scan on chunks
  → read every chunk row for this tenant
  → compute 3072-dimension cosine distance for each one
  → sort
  → LIMIT 20
```

An exact k-NN scan over the whole table. Correct, and unusable — linear in the number of
chunks, with a 3072-float distance computation per row. At ten thousand chunks it is
noticeably slow; at a hundred thousand it is a timeout. **3072 dimensions can be stored but
never indexed**, and an unindexed vector column is not a retrieval system.

**Reason 2: the storage arithmetic.** A pgvector `vector` is 4 bytes per dimension plus a
small header.

| Dimensions | Bytes per vector | 10k chunks | 50k chunks | 500k chunks |
|---|---|---|---|---|
| 3072 | ~12 KB | ~120 MB | ~600 MB | ~6 GB |
| **768** | **~3 KB** | **~30 MB** | **~150 MB** | **~1.5 GB** |
| 1536 | ~6 KB | ~60 MB | ~300 MB | ~3 GB |

For a tuition class with 50k chunks that is **150 MB versus 600 MB** — and the HNSW index
wants to live in RAM. That 4× difference is what decides whether the index fits in the
memory of a cheap VPS or starts spilling to disk, and once it spills, latency stops being a
flat curve. The product is aimed at customers for whom a €5/month VPS is the right hosting
answer, so this is not a theoretical concern.

### Why truncating is safe: Matryoshka Representation Learning

The obvious objection: surely throwing away 2304 of 3072 dimensions destroys the embedding?

Normally yes. Here no, because `gemini-embedding-001` is trained with **Matryoshka
Representation Learning**. MRL adds a training objective that forces the *most important
information into the earliest dimensions* — the model is trained so that the first 768
dimensions are themselves a usable embedding, the first 1536 a better one, and the full
3072 the best.

```
   A normal embedding:              An MRL embedding:
   ┌──────────────────────┐         ┌────┬────┬──────────────┐
   │ information spread    │         │ 768│1536│    3072      │
   │ evenly across all     │         │most│more│  finest      │
   │ 3072 dimensions       │         │sig.│det.│  detail      │
   └──────────────────────┘         └────┴────┴──────────────┘
   Truncate → nonsense              Truncate at a trained
                                     boundary → still valid,
                                     slightly less precise
```

The practical effect is that a 768-dimension prefix retains the large majority of retrieval
quality at a quarter of the storage. For a corpus of tens of thousands of chunks — where the
task is "find the 5 most relevant of 20,000 passages", not "distinguish the 1st from the
2nd most similar of 50 million" — the difference is not measurable in answer quality.

**One critical implementation detail.** AskLK asks the *API* for 768 dimensions rather than
slicing the response:

```typescript
{
  model: `models/${model}`,
  content: { parts: [{ text }] },
  taskType,
  outputDimensionality: dim,   // 768 — not a client-side slice
}
```

The server returns a prefix that is **already correctly renormalised** for that dimension.
Slicing 3072 floats down to 768 in client code without renormalising produces vectors of
the wrong magnitude — and cosine distance computed over wrongly-normalised vectors is
subtly, silently wrong. It would not error. It would just retrieve slightly worse, forever,
with no symptom. This is the kind of bug that takes a week to find because nothing about it
looks broken.

### Why the dimension is validated at boot

```typescript
GEMINI_EMBEDDING_DIM: Joi.number().valid(768, 1536).default(768),
```

`valid(768, 1536)` — an enum, not a range. Those are the two values that are both
MRL-supported and under pgvector's 2000-dimension index cap. Someone setting `3072` in
`.env` gets a boot failure with a readable message, not a database that stores vectors it
can never index.

And `GeminiService.embed` checks the returned length against the configured dimension:

```typescript
if (values.length !== dim) {
  throw new ServiceUnavailableException(
    `Embedding dimension mismatch: expected ${dim}, got ${values.length}. ` +
    `GEMINI_EMBEDDING_DIM and the vector(N) column must agree.`,
  );
}
```

Without that check, a mismatch surfaces as a Postgres type error **one row at a time, deep
inside an ingestion transaction**, with an error message about vector dimensions that says
nothing about which config value is wrong. Catching it at the API boundary names the actual
problem.

**If quality ever measurably suffers, 1536 is the next step up and is still indexable.** It
is a migration (`ALTER TABLE … ALTER COLUMN`, plus a full re-embed of every chunk), not a
redesign.

---

## 5. The generated `tsvector` column

```sql
ALTER TABLE "chunks"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED;

CREATE INDEX "chunks_searchVector_idx" ON "chunks" USING GIN ("searchVector");
```

This is the lexical half of hybrid search (`02-RAG-EXPLAINED.md` §5).

### Why `GENERATED … STORED` and not an expression index

An expression index (`CREATE INDEX … ON chunks USING GIN (to_tsvector('simple', content))`)
would work for *matching*. But the query also needs `ts_rank` for scoring:

```sql
ts_rank(c."searchVector", plainto_tsquery('simple', $2)) AS rank
```

`ts_rank` needs the tsvector **as a value**, not as an index entry. With an expression index
Postgres would have to recompute `to_tsvector(content)` for every candidate row at query
time, just to rank it. A stored generated column computes it once on write and hands it to
both the index and `ts_rank`.

The cost is disk: the tsvector roughly doubles the storage of the `content` it derives from.
For a table already carrying a 3KB vector per row, that is not the binding constraint.

`GENERATED ALWAYS` also means it cannot drift. There is no code path that writes `content`
without updating `searchVector`, because Postgres does it. An application-maintained column
would eventually be written by some code path that forgot.

### Why `'simple'` and not `'english'`

The most questioned line in the migration, so it gets the full argument.

A Postgres text-search configuration does three things: tokenise, remove stopwords, and
stem. `'english'` does all three with English rules. `'simple'` only lowercases and splits
on non-word characters.

**The corpus is bilingual. There is no Sinhala stemmer in Postgres.** So consider what
`'english'` would do:

| Aspect | `'english'` on English text | `'english'` on Sinhala text |
|---|---|---|
| Tokenise | Correct | Splits on whitespace/punctuation — acceptable by accident |
| Stemming | Correct (`classes` → `class`) | **No stemmer exists** — Sinhala tokens pass through unstemmed |
| Stopwords | Removes `the`, `is`, `at`, `for`, `a` | Removes nothing (no Sinhala stopword list) |

So `'english'` would give a real benefit on the English half (stemming), no benefit on the
Sinhala half, and **one active harm on both**: stopword removal.

Stopword removal is dangerous here because the questions are short and factual. Consider:

```
  Question:  "is the fee for the ICT class"
  'english': fee, ict, class          ← "is", "the", "for" removed
  'simple':  is, the, fee, for, the, ict, class
```

Usually harmless. But short factual questions are exactly where a stopword can carry
meaning — and a query where *every* term is a stopword (`"how much is it"`) produces an
empty tsquery under `'english'`, so the lexical arm silently returns zero rows and the
hybrid quietly degrades to vector-only, with no error anywhere.

**And the decisive argument is a division of labour.** The vector arm carries the semantic
weight. It already handles paraphrase, morphology and synonymy far better than stemming
ever could — `"classes"` and `"class"` embed almost identically without any stemmer. What
the lexical arm is *for* is the thing vectors are bad at: **exact keyword and proper-noun
matches** — a course code, a phone number, an unusual branch name. That job wants literal
matching with nothing removed and nothing transformed, which is precisely what `'simple'`
does.

Using `'simple'` also has the property of treating both languages **identically**, which is
the right default for a bilingual corpus where a single chunk routinely contains both.

### The configuration must match on both sides

```sql
-- The column:
GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED

-- The query:
ts_rank(c."searchVector", plainto_tsquery('simple', ${question}))
  AND c."searchVector" @@ plainto_tsquery('simple', ${question})
```

Both say `'simple'`. If the query said `'english'`, the tsquery would be built with a
different configuration than the tsvector, the GIN index would be unusable, and Postgres
would **silently sequential-scan every chunk**. Correct results, no error, quietly getting
slower as the table grows. Same failure shape as the `<=>`/`vector_cosine_ops` mismatch in
§6, and worth internalising as a general pgvector/tsvector rule: **the index and the query
must agree, and when they do not, Postgres does not tell you.**

### `plainto_tsquery`, not `to_tsquery`

`to_tsquery` requires valid tsquery syntax and throws on an apostrophe or a stray `&`.
`plainto_tsquery` accepts raw user input and produces a valid query. A 500 on
*"what's the fee?"* is not an acceptable failure mode for a public chat box, and input
sanitising to make `to_tsquery` safe would be reimplementing `plainto_tsquery` badly.

---

## 6. HNSW vs IVFFlat

```sql
CREATE INDEX "chunks_embedding_hnsw_idx"
  ON "chunks"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

pgvector offers two approximate-nearest-neighbour index types. The choice is not close for
this product, but the reason is specific to it rather than general.

### What each one is

**IVFFlat** — *inverted file with flat compression*. It partitions the vector space into
`lists` clusters by running k-means over existing data, stores each vector in its nearest
cluster, and at query time searches only the `probes` nearest clusters.

```
    ┌───────────────────────────────────┐
    │   ·  ·     │   ·  ·   │  ·   ·    │   k-means centroids divide the space.
    │  · C1 ·    │  · C2 ·  │ · C3 ·    │   A query searches only the nearest
    │   ·  ·     │   ·  ·   │  ·   ·    │   `probes` cells and ignores the rest.
    └───────────────────────────────────┘
```

**HNSW** — *hierarchical navigable small world*. A multi-layer graph. The top layer is
sparse with long-range links; each layer down is denser. A search enters at the top, greedily
walks toward the query, drops a layer, and repeats.

```
    Layer 2:   A ────────────────────────── F          coarse, long hops
                │                            │
    Layer 1:   A ───── C ───── D ─────────── F         medium
                │       │       │             │
    Layer 0:   A─B─C─D─E─F─G─H─I─J─K─L─M─N─O─P        every vector, short hops
                            ▲
                     query lands here after descending
```

### Why HNSW, specifically for this product

| Property | IVFFlat | HNSW | Why it matters here |
|---|---|---|---|
| **Needs training data** | **Yes** — k-means over existing rows | **No** — builds incrementally | **The deciding factor. A brand-new tenant has zero chunks.** Creating an IVFFlat index on an empty or near-empty table trains its clusters on nothing, producing a partition that describes no real data. |
| **Behaviour as data grows** | Degrades as data drifts from what the clusters were trained on; needs periodic `REINDEX` | Stable; new vectors are linked into the graph on insert | Documents arrive gradually and unpredictably over a tenant's whole lifetime. There is no moment at which the data is "representative" and the index could be built once. |
| **Recall at equal latency** | Lower | Higher | Better answers for the same query time. |
| **Build time** | Faster | Slower | Irrelevant — no bulk build ever happens; the index grows with inserts. |
| **Memory** | Lower | **Higher** — the graph adds ~20-40% on top of the vectors | The real cost. §10 covers when it bites. |
| **Insert speed** | Faster | **Slower** — each insert walks the graph to find its neighbours | Acceptable: inserts happen in a background ingestion job nobody is waiting on. |

The training requirement is the whole argument, and it maps directly onto the product's
shape. **A multi-tenant SaaS creates new tenants continuously, and every new tenant starts
at zero rows.** With IVFFlat the honest workflow would be: create the tenant, let them
upload, wait until they have "enough" chunks, then build the index — and rebuild it
periodically as they add more. That is a background maintenance job, a "how many rows is
enough?" judgement call, and a window during which the tenant's queries are unindexed. HNSW
simply does not have that problem: the index exists from the first insert and is correct at
every size.

### The cost, stated plainly

**Memory.** HNSW is a graph and it wants to be resident. Vectors plus graph structure at
500k chunks is comfortably over 2GB. §10.

**Insert latency.** Each insert traverses the graph to find and link its `m` nearest
neighbours. Inserting a 300-chunk document is measurably slower than it would be with
IVFFlat. This is the right trade: ingestion is a background job, retrieval sits in front of
a user, and it is always correct to move cost from the synchronous path to the asynchronous
one.

### The `m` and `ef_construction` parameters

| Parameter | Value | What it controls | Effect of raising it |
|---|---|---|---|
| `m` | 16 | Max bidirectional links per node per layer — the graph's connectivity | Better recall, more memory (links are stored per node), slower build. The most memory-sensitive knob. |
| `ef_construction` | 64 | Size of the candidate list kept while *building* — how hard the index works to find good neighbours for each new node | Better graph quality → better recall at query time, at the cost of build/insert time. Costs **no extra memory at rest**. |

Both are pgvector's defaults, and defaults are the right starting point for a system with no
evaluation set to tune against (`01-ARCHITECTURE.md` §8).

If recall needed improving, the order I would try is:

1. **`ef_search`** (a query-time `SET`, default 40) — raise it first. Costs nothing at rest,
   needs no reindex, and trades query latency for recall. It is the only one of the three
   that can be tuned per query and rolled back instantly.
2. **`ef_construction`** to 128 — better graph, no memory cost at rest, but requires a
   rebuild.
3. **`m`** to 24 or 32 — the biggest recall gain and the biggest memory cost. Last resort,
   and the one to be careful with on a small VPS.

### `vector_cosine_ops` must match `<=>`

This is the pgvector footgun, and it is worth stating in the strongest available terms.

The index is built with an **operator class** that determines which distance function it
organises the graph around:

| Operator class | Operator | Distance |
|---|---|---|
| `vector_cosine_ops` | `<=>` | Cosine |
| `vector_l2_ops` | `<->` | Euclidean (L2) |
| `vector_ip_ops` | `<#>` | Negative inner product |

The index is built with `vector_cosine_ops`. The query uses `<=>`. **They match, and they
must.**

**What happens if they do not.** Suppose someone changes the `ORDER BY` to `<->` — an easy
mistake, since it looks like an equivalent distance operator and the query still compiles.
Postgres will:

1. Notice the index is organised for cosine distance.
2. Notice the query asks for L2 distance.
3. Conclude the index cannot answer this query.
4. **Silently fall back to a sequential scan.**

No error. No warning. No log line. The query returns *correct* results — it genuinely
computes L2 distance over every row — just by reading the entire table and sorting. And
because L2 and cosine rank similarly for near-normalised vectors, the results often look
right too.

The only symptom is latency, and the only way to catch it is to look:

```sql
EXPLAIN ANALYZE
SELECT c.id, 1 - (c.embedding <=> '[…]'::vector) AS similarity
FROM chunks c
WHERE c."tenantId" = 'some-uuid'
ORDER BY c.embedding <=> '[…]'::vector
LIMIT 20;
```

```
 Good:  Index Scan using chunks_embedding_hnsw_idx on chunks  (actual time=0.8..2.1 rows=20)
 Bad:   Seq Scan on chunks  (actual time=412..1180 rows=48000)
           Filter: (tenantId = '…')
        Sort  (Sort Method: top-N heapsort)
```

**`Seq Scan` on a vector query means the index is not being used**, and the cause is almost
always an operator/opclass mismatch. The same trap exists for the tsvector configuration
(§5). Any change to a vector or full-text query should be `EXPLAIN`-ed, because this class
of bug does not announce itself.

`vector_cosine_ops` is the right opclass here because embeddings are compared by
**direction, not magnitude** — a short passage and a long passage about the same topic
should be equally similar to a question about that topic. `02-RAG-EXPLAINED.md` §3.

---

## 7. Every index, and the query it serves

| Index | Table | Serves | Why it exists |
|---|---|---|---|
| `tenants_slug_key` | `tenants` | `WHERE slug = $1` | The public widget path resolves a tenant by slug on **every** unauthenticated request. UNIQUE gives the lookup *and* enforces that two tenants cannot claim one slug. |
| `users_tenantId_email_key` | `users` | `WHERE tenantId = $1 AND email = $2` | The business rule "one account per email per tenant", enforced by the database. Also serves a tenant-scoped user lookup. |
| `users_email_idx` | `users` | `WHERE email = $1` | **Login, before a tenant is known.** The composite unique index cannot serve this, because its leading column is `tenantId` and login does not have one. |
| `refresh_tokens_tokenHash_key` | `refresh_tokens` | `WHERE tokenHash = $1` | Every token refresh. UNIQUE because two rows with one hash would make revocation ambiguous. |
| `refresh_tokens_userId_idx` | `refresh_tokens` | `WHERE userId = $1` | Family-wide revocation on replay detection, and "log out everywhere". |
| `refresh_tokens_expiresAt_idx` | `refresh_tokens` | `WHERE expiresAt < now()` | The periodic prune of dead rows, without scanning a table that grows with every login. |
| `documents_tenantId_createdAt_idx` | `documents` | `WHERE tenantId = $1 ORDER BY createdAt DESC` | The admin document list, which is **always** "this tenant, newest first". The composite serves filter and sort together, so no sort step is needed. |
| `documents_tenantId_status_idx` | `documents` | `WHERE tenantId = $1 AND status = $2` | The filtered document list, and finding documents stuck in `PROCESSING` for the requeue path. |
| `documents_filename_trgm_idx` | `documents` | `WHERE filename ILIKE '%…%'` / `similarity()` | GIN + `gin_trgm_ops` for fuzzy filename search in the admin UI. A B-tree cannot serve a leading-wildcard `LIKE`; trigrams can. |
| `chunks_documentId_ordinal_idx` | `chunks` | `WHERE documentId = $1 ORDER BY ordinal` | Re-ingest deletes by `documentId`; neighbouring-chunk fetches read by ordinal. |
| `chunks_tenantId_idx` | `chunks` | `WHERE tenantId = $1` | **The pre-filter for every retrieval query.** Shrinks the candidate set before the vector or GIN index does its work, and is the physical mechanism behind tenant isolation on the hottest table. |
| `chunks_embedding_hnsw_idx` | `chunks` | `ORDER BY embedding <=> $1 LIMIT 20` | The vector arm. §6. |
| `chunks_searchVector_idx` | `chunks` | `WHERE searchVector @@ plainto_tsquery(…)` | The lexical arm. GIN is the correct index type for a tsvector — it inverts term → rows, which is exactly the lookup. §5. |
| `conversations_tenantId_updatedAt_idx` | `conversations` | `WHERE tenantId = $1 ORDER BY updatedAt DESC` | The admin conversation list, ordered by real activity. This is why `updatedAt` is explicitly touched on every new message. |
| `messages_conversationId_createdAt_idx` | `messages` | `WHERE conversationId = $1 ORDER BY createdAt` | Rendering a conversation thread in order. Filter + sort in one index. |
| `messages_unanswered_createdAt_idx` | `messages` | `WHERE unanswered = true ORDER BY createdAt DESC` | The "unanswered questions" report. **The one index that does not lead with a tenant column**, because `messages` has no `tenantId` — it reaches tenancy through `conversations`. §10 calls this out as the first thing to change at scale. |
| `usage_counters_tenantId_period_key` | `usage_counters` | `WHERE tenantId = $1 AND period = $2` | The `upsert` target on every message. UNIQUE is what makes the upsert atomic and stops concurrent messages creating two rows for one month. |

**The pattern:** every index that serves a tenant-facing query leads with `tenantId`, and
every list index carries its sort column as a trailing member so filter and order are one
index scan rather than a scan plus a sort. The one exception is
`messages_unanswered_createdAt_idx`, and it is a known and named weakness rather than an
oversight.

---

## 8. Tenant isolation — the rule, and the canonical bug

### The rule

> **Every query against a tenant-owned table includes `tenantId` in its `WHERE` clause.
> No exceptions. Not for internal callers, not for background jobs, not for admin
> endpoints.**

Not "the service layer checks ownership". Not "the guard already verified the JWT". The
`tenantId` goes in the query, so that the database never returns a row the caller is not
entitled to — which means a bug in the application layer cannot turn into a data leak,
because the data was never selected.

### The canonical bug

This is the single most common multi-tenant vulnerability, and it is two characters of
difference:

```typescript
// ❌ WRONG — leaks across tenants
async findOne(id: string) {
  return this.prisma.document.findUnique({ where: { id } });
}

// ✅ RIGHT
async findOne(tenantId: string, id: string) {
  const document = await this.prisma.document.findFirst({
    where: { id, tenantId },
  });
  if (!document) throw new NotFoundException('Document not found');
  return document;
}
```

**Why the wrong one is so attractive.** `findUnique` is the natural Prisma call for "get by
primary key". It is faster in principle, it is what every tutorial shows, and the
authentication guard has *already run* — the caller is definitely a logged-in user of some
tenant. It feels safe.

**Why it is not.** The guard proved *who* the caller is. It proved nothing about *which
document they asked for*. `GET /documents/<any uuid>` with a valid token for tenant A
returns tenant B's document, in full, including `storageKey` and `filename`. No guard
catches it because no guard knows what the id refers to. The only thing that can catch it is
the query itself.

`findFirst` with both columns cannot be exploited this way. The row simply is not returned.

**And 404, not 403.** Returning "403 Forbidden" would confirm that the id exists and belongs
to someone else — a small information leak that lets an attacker enumerate valid document
ids across the platform. "404 Not Found" tells them nothing, which is exactly what they
should learn.

### The same rule on writes

Writes are worse, because a write leak is destructive rather than merely disclosing:

```typescript
// From ingestion.worker.ts — updateMany with tenantId, not update by id:
await this.prisma.document.updateMany({
  where: { id: job.documentId, tenantId: job.tenantId },
  data: { status: DocumentStatus.FAILED, errorMessage: message.slice(0, 500) },
});
```

`updateMany` is used here specifically because `update` requires a unique selector and would
force `where: { id }` alone. The job payload came from our own queue and is trustworthy —
and the rule is applied anyway. **"Trusted caller" is how the rule erodes.** Once one call
site is exempt, the next one argues by precedent, and eventually an exempt call site takes
an id from a request body.

### And on reads inside the chat path

```typescript
const existing = await this.prisma.conversation.findFirst({
  where: { id: conversationId, tenantId },
  select: { id: true },
});
```

The widget supplies `conversationId` from `localStorage`. Without `tenantId` in that
`where`, a visitor on site A could append messages to — and read the history of — a
conversation belonging to site B, by supplying its id. The public endpoint is
unauthenticated, so this query *is* the access control. And when the id does not match, the
code starts a fresh conversation rather than erroring: a widget holding a stale id from a
deleted conversation should keep working, not show a failure to an end user who did nothing
wrong.

### Where the rule is enforced in retrieval

The two retrieval queries are raw SQL, so the rule is written out literally:

```sql
WHERE c."tenantId" = ${tenantId}
  AND c.embedding IS NOT NULL
  AND d.status = 'READY'
ORDER BY c.embedding <=> ${literal}::vector
LIMIT 20
```

`"tenantId" = $1` is **inside** the query, not applied afterwards in TypeScript. Filtering
after retrieval would mean the database had already read another tenant's rows, and a bug in
the filter would leak them. It also means the pre-filter shrinks the candidate set the HNSW
index has to consider — which is the pgvector-in-Postgres advantage over a standalone vector
DB where the filter lives in a different system (§4).

### What backs it up

| Mechanism | What it guarantees |
|---|---|
| `tenantId` in every `WHERE` | The database never returns a foreign row |
| `ON DELETE CASCADE` on every tenant FK | Deleting a tenant leaves **nothing** behind. For a product storing customer documents, an orphaned chunk is a data-protection problem, not untidiness. |
| Global `JwtAuthGuard`, opt out with `@Public()` | Fail-closed: a new endpoint is protected by default, so forgetting a decorator cannot silently expose data |
| `chunks.tenantId` denormalised | Isolation on the hottest table needs no join |
| 404 instead of 403 | No confirmation that a foreign id exists |

**What is deliberately not used: Postgres Row-Level Security.** RLS would enforce the rule
in the database itself, which is strictly stronger. It is not used because it requires a
per-request `SET LOCAL app.tenant_id`, which interacts badly with connection pooling (a
pooled connection carrying the previous request's setting is a serious failure mode, and the
wrong direction to fail in), and because Prisma has no first-class support for it. The
honest position: **the current approach depends on discipline at every call site, and RLS
would not.** It is the security improvement I would make first if this took payment data or
grew a team. The mitigation today is that the number of call sites is small and they are all
in service classes that follow one visible pattern.

---

## 9. Extensions, enums, and cascades

### Extensions

```sql
CREATE EXTENSION IF NOT EXISTS vector;    -- the whole reason there is no vector DB
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy filename search in the admin UI
```

Declared in `schema.prisma` as `extensions = [vector, pg_trgm]` under the
`postgresqlExtensions` preview feature, so migrations can create them. That preview flag
exists specifically because pgvector's `vector` type has no Prisma-native mapping — the
extension can be created, but the column must be `Unsupported()` and reached through
`$queryRaw`.

### Enums, not strings

`Role`, `DocumentStatus`, `DocumentKind`, `MessageRole` are all Postgres enums.

The argument is the same every time: **the database refuses a typo.** A `status` column of
type `text` accepts `'READYY'`, and the document then silently never matches
`d.status = 'READY'` in either retrieval query — it is ingested, it has chunks, and it is
invisible to the assistant with no error anywhere. An enum makes that a constraint
violation at write time.

The cost is that adding a value is a migration (`ALTER TYPE … ADD VALUE`). For four enums
whose values are the domain's actual vocabulary and change approximately never, that is the
correct trade.

`Chunk.language` and `Document.language` are **text, not enums**, and that is deliberate:
they hold `'si' | 'en' | 'mixed'` but are descriptive metadata rather than control flow, and
adding a third language is a product feature that should not require a type migration.

### Cascades

> Every tenant-owned table cascades from `tenants`. Deleting a tenant must leave nothing
> behind — for a product that stores customer documents, an orphaned chunk is a
> data-protection problem, not just untidiness.

```
  DELETE FROM tenants WHERE id = $1
    ├─► users            ──► refresh_tokens
    ├─► documents        ──► chunks
    ├─► chunks
    ├─► conversations    ──► messages
    └─► usage_counters
```

One statement, and the tenant's entire footprint in the database is gone. "Delete my data"
is a request this product will receive, and it should be one transaction rather than a
checklist.

**Files on disk are not cascaded**, because Postgres cannot delete files. Tenant deletion
must also remove `STORAGE_DIR/<tenantId>/`, and the fact that this is a separate step
outside the transaction is a real gap — a crash between the commit and the `rm` leaves
orphaned files. They are unreachable (no row references them) but they are still bytes on
disk containing customer content. The honest fix is a reconciliation sweep comparing
`STORAGE_DIR` subdirectories against `tenants.id`, and it is not built.

**`messages.sources` is deliberately outside the cascade graph.** It is a `jsonb` snapshot,
not a foreign key, so deleting a document does not erase the record of what the assistant
cited. That is the point: the admin must still be able to audit a past answer after the
source document is gone. A real FK would have forced a choice between blocking document
deletion and cascading away the conversation history, and both are worse.

---

## 10. What changes at 10× and 100×

Today's working assumption: a tenant with ~50 documents, ~10,000 chunks, a few thousand
messages a month. The whole platform fits comfortably on one small Postgres instance.

### At 10× — ~100k chunks per tenant, ~1M platform-wide

**Mostly fine.** HNSW at 100k vectors is ~300 MB of vectors plus graph, still resident. The
tenant pre-filter keeps per-query work bounded regardless of platform size.

Three things start to matter:

**1. `messages` growth and the unanswered report.** `messages_unanswered_createdAt_idx` does
not lead with a tenant column — `messages` has no `tenantId`, reaching tenancy only through
`conversations`. So the report scans a platform-wide index and then joins to filter by
tenant. At 10× that is a slow dashboard query.

*Fix:* denormalise `tenantId` onto `messages` and change the index to
`(tenantId, unanswered, createdAt)`. This is the same denormalisation already applied to
`chunks`, for the same reason, and the only argument against doing it now is that it has not
hurt yet.

**2. `ef_search` tuning.** Default 40 gives good recall at 10k vectors. At 100k, recall
degrades gently unless it is raised. This is a query-time `SET`, so it can be tuned per
request and rolled back instantly — the cheapest knob in §6 and the first to reach for.

**3. Ingestion queue fairness.** One FIFO Redis list with one consumer means a tenant
uploading 200 documents blocks every other tenant's uploads behind them. Fairness is a
multi-tenant *requirement*, not an optimisation, and a single list has no notion of it.

*Fix:* a per-tenant round-robin over a set of per-tenant lists, or a scheduling key. This is
the first architectural change I would make, ahead of anything in the database.

### At 100× — ~1M chunks per tenant, ~10M platform-wide

Now the design genuinely changes.

**1. Partition `chunks` by `tenantId`.** The single highest-value change, and it is
natural here because **every retrieval query already filters on `tenantId`** — partition
pruning comes free with no query rewrite at all.

```sql
CREATE TABLE chunks (…) PARTITION BY HASH ("tenantId");
```

What it buys: each partition gets its own HNSW index, sized to one tenant's data, so a huge
tenant cannot degrade a small tenant's query performance. Index maintenance (`REINDEX`,
`VACUUM`) becomes per-partition and therefore actually possible during business hours. And
tenant deletion could become `DROP TABLE` on a partition rather than a cascading delete of a
million rows.

What it costs: partition management, a `tenantId` requirement on every query (already true),
and cross-partition queries becoming expensive (there are none).

**2. HNSW memory becomes the binding constraint.** 1M chunks × 3KB = 3 GB of vectors, plus
graph overhead, on one instance. Options, in the order I would consider them:

| Option | Trade |
|---|---|
| More RAM | Simplest, buys a lot of headroom, and is genuinely the right first answer |
| Partitioning (above) | Splits the problem into independently-sized pieces |
| Read replica for retrieval | Vector search on a replica, writes on the primary. Retrieval tolerates slight staleness — a document ingested two seconds ago not being answerable yet is fine. |
| Drop to a smaller dimension | Already at 768; going lower costs real quality. Not the lever. |
| A dedicated vector engine | Finally justified. This is the point where `01-ARCHITECTURE.md` §7's rejection of Pinecone/Qdrant would be revisited honestly. |

**3. `messages` needs a retention policy.** It grows forever and nothing currently trims it.
At 100× it is the largest table in the database and nobody is reading messages from two
years ago.

*Fix:* a retention window per plan tier, `messages` partitioned by month with old partitions
detached and archived to object storage, and the unanswered report moved to a materialised
view refreshed on a schedule rather than computed live.

**4. `usage_counters` stays fine.** One row per tenant per month. At 10,000 tenants and five
years that is 600,000 rows, which is nothing. This table was designed correctly and does not
change.

**5. Connection pooling becomes mandatory.** PgBouncer in transaction mode, and this is
where the RLS decision in §8 is vindicated — `SET LOCAL app.tenant_id` and transaction-mode
pooling are a genuinely dangerous combination, and the design that puts `tenantId` in the
query instead is unaffected by it.

### What does not change

The schema shape. Every table earns its place, every column has a reason, and the isolation
rule scales linearly because it is enforced in a `WHERE` clause and an index rather than by
anything that needs coordination. **The changes above are all operational — partitioning,
retention, pooling, memory — not redesigns.** That is the property worth defending: the
model is right, and scale is a matter of where the data physically sits.

---

## 11. Related documents

- `01-ARCHITECTURE.md` — components, request and ingestion flows, rejected alternatives,
  what breaks first at scale.
- `02-RAG-EXPLAINED.md` — embeddings, chunking, hybrid search, RRF with worked numbers,
  the anti-hallucination layers, bilingual answering.
