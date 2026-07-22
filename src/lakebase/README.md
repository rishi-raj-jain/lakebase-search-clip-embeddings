# src/lakebase

Everything in this app that is actually about **Lakebase Search** is in this
directory. Four files, ~350 lines. If you are here to see how the indexes work,
you can ignore the rest of the repo.

| file                         | what it holds                                   |
| ---------------------------- | ----------------------------------------------- |
| [`indexes.ts`](./indexes.ts) | the `CREATE INDEX` DDL for both access methods  |
| [`ann.ts`](./ann.ts)         | vector search: `<=>` top-k and `<<=>>` radius   |
| [`bm25.ts`](./bm25.ts)       | keyword search: `<@>` and `to_bm25query`        |
| [`modes.ts`](./modes.ts)     | the four UI modes and the SQL each one displays |

## The two access methods

```sql
create index photos_embedding_ann on photos
using lakebase_ann (embedding vector_cosine_ops)
with (build_mode = 'standard');

create index captions_tsv_bm25 on captions
using lakebase_bm25 (tsv tsvector_bm25_ops)
with (k1 = 1.2, b = 0.75);
```

Both are built **after** the data is loaded, by `npm run db:index`. That order is
not optional: an ANN index built on an empty table has no partitions to probe,
and BM25 scoring depends on corpus-wide document-length statistics.

## The three query shapes

**Top-k nearest neighbour.** Ordinary ANN, and identical to what you would
write against pgvector's HNSW or IVF. Swapping the index type changes the plan
and the recall, not the query.

```sql
select id, filename, embedding <=> $1 as distance
from photos order by embedding <=> $1 limit 24;
```

**Radius.** The one shape pgvector cannot answer from an index. `WHERE
embedding <=> $1 < 0.2` is a _filter_: the index sorts by distance and cannot
seek by it, so you scan the table. `lakebase_ann` registers `<<=>>` as a
strategy on `vector_cosine_ops`, so the bound is pushed into the index and only
the matching region is read.

```sql
select id, filename from photos
where embedding <<=>> sphere($1, $2)   -- indexed radius
order by embedding <=> $1 limit 60;
```

**BM25.** Note that `to_bm25query` takes the _index name_ as an argument,
because scoring needs that index's corpus statistics. A plain `tsvector @@
tsquery` match has no equivalent; it knows nothing about the corpus. `<@>`
returns a **negative** score, so ascending order is most-relevant-first, which
matches the vector operators rather than fighting them.

```sql
select body, tsv <@> to_bm25query(to_tsvector('english', $1), 'captions_tsv_bm25') as score
from captions order by score limit 24;
```

## Calibration is corpus-specific

The radius default (`DEFAULT_RADIUS` in `modes.ts`) is 0.18, and that number was
measured, not guessed. Over this corpus, photo-to-photo nearest-neighbour cosine
distance is:

| percentile | distance |
| ---------- | -------- |
| p05        | 0.14     |
| p50        | 0.25     |
| p95        | 0.35     |

So 0.15 is a true near-duplicate threshold that correctly returns _nothing_ for
most photos. By 0.30 every one of the twenty densest photos hits the 60-row cap,
at which point the threshold is not discriminating and the mode degenerates into
a plain top-k.

One trap worth knowing: a **text** query never lands closer than ~0.66 to any
image, because CLIP's text and image towers occupy separate cones of the shared
space. Ranking across modalities is meaningful; absolute distance thresholds are
not. Radius mode is therefore only useful photo-to-photo, and the UI says so
rather than showing an empty grid.

## What is deliberately not here

`src/db/` holds the connection and the ordinary lookups (corpus counts, the
photo picker, the query-embedding cache), plain Postgres with no vector operators.
`src/lib/` holds the CLIP embedding, S3 presigning and the browser code. None of
that is Lakebase-specific, and none of it is needed to understand the above.
