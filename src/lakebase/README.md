# src/lakebase

This directory holds the Lakebase Search code (of four files):

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

`npm run db:index` creates both, once the loader has finished. Build them in that order: an ANN index over an empty table has no rows to partition, so it cannot probe anything, and BM25 needs the whole corpus present before it can compute document-length statistics.

## The three query shapes

**Top-k nearest neighbour**: You would write this exact query against pgvector's HNSW or IVF. Swapping the index type changes the plan and the recall while the query stays the same.

```sql
select id, filename, embedding <=> $1 as distance
from photos order by embedding <=> $1 limit 24;
```

**Radius**: Against pgvector, `WHERE embedding <=> $1 < 0.2` only filters: the index sorts by distance but cannot seek by it, so Postgres scans the table. `lakebase_ann` registers `<<=>>` as a strategy on `vector_cosine_ops`, which pushes the bound into the index so it reads only the matching region.

```sql
select id, filename from photos
where embedding <<=>> sphere($1, $2)   -- indexed radius
order by embedding <=> $1 limit 60;
```

**BM25**: `to_bm25query` takes the index name as an argument, because it reads that index's corpus statistics to score a row. A plain `tsvector @@ tsquery` match offers no equivalent, since it knows nothing about the corpus. `<@>` returns a negative score, so ascending order puts the most relevant rows first.

```sql
select body, tsv <@> to_bm25query(to_tsvector('english', $1), 'captions_tsv_bm25') as score
from captions order by score limit 24;
```