# src/lakebase

This directory holds the Lakebase Search code, four files of about 350 lines. If
you are here to see how the indexes work, you can skip the rest of the repo.

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

Both are built after the data is loaded, by `npm run db:index`. Build them in
that order: an ANN index created on an empty table has no partitions to probe,
and BM25 scoring depends on corpus-wide document-length statistics.

## The three query shapes

**Top-k nearest neighbour.** Ordinary ANN, and identical to what you would
write against pgvector's HNSW or IVF. Swapping the index type changes the plan
and the recall while the query stays the same.

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
tsquery` match has no equivalent, since it knows nothing about the corpus. `<@>`
returns a negative score, so ascending order gives you the most relevant rows
first, the same direction the vector operators sort in.

```sql
select body, tsv <@> to_bm25query(to_tsvector('english', $1), 'captions_tsv_bm25') as score
from captions order by score limit 24;
```

## Calibration is corpus-specific

The radius default (`DEFAULT_RADIUS` in `modes.ts`) is 0.18, taken from
measurements over this corpus. Photo-to-photo nearest-neighbour cosine distance
here is:

| percentile | distance |
| ---------- | -------- |
| p05        | 0.14     |
| p50        | 0.25     |
| p95        | 0.35     |

So 0.15 is a true near-duplicate threshold, and for most photos it correctly
returns nothing. By 0.30 every one of the twenty densest photos hits the 60-row
cap, so the threshold stops discriminating and the mode behaves like a plain
top-k.

There is a trap here. A text query never lands closer than about 0.66 to any
image, because CLIP's text and image towers occupy separate cones of the shared
space. Relative ranking across modalities still works, but absolute distance
thresholds do not transfer. Radius mode therefore only applies photo to photo,
and the UI explains that instead of returning an empty grid.

## What is deliberately not here

`src/db/` holds the connection and the ordinary lookups (corpus counts, the
photo picker, the query-embedding cache), plain Postgres with no vector operators.
`src/lib/` holds the CLIP embedding, S3 presigning and the browser code. That
code is generic, and you can read everything above without it.
