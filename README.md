# Image search over CLIP embeddings with Lakebase Search

Search 31k Flickr photos by text, by another image, or by caption — from a single
`vector(512)` column on Neon Postgres, indexed with `lakebase_ann` and
`lakebase_bm25`.

This is the pgvector image-search tutorial rebuilt on Lakebase Search. The SQL is
deliberately identical to what you would write against pgvector, right up to the
last query shape — radius search — which Lakebase can serve from an index and
pgvector cannot.

**Stack**: Astro 7 · Tailwind v4 · Drizzle ORM · `@neondatabase/serverless` ·
Neon Storage (S3) · CLIP ViT-B/32 via transformers.js. No Python.

---

## What you end up with

| Query             | How                                                         | Index                    |
| ----------------- | ----------------------------------------------------------- | ------------------------ |
| Text → image      | Embed the phrase with CLIP's text tower, rank photo vectors | `lakebase_ann`           |
| Image → image     | Take a photo's stored vector, rank photo vectors            | `lakebase_ann`           |
| Image → caption   | Same vector, rank the 5× larger caption corpus              | `lakebase_ann`           |
| Keyword → caption | BM25 over caption lexemes, no embedding at all              | `lakebase_bm25`          |
| Near-duplicates   | Every photo inside a cosine radius                          | `lakebase_ann` (`<<=>>`) |

The first three are the _same query_ against different tables. CLIP puts its
vision and text towers in one 512-dimension space, so once you hold a vector it
no longer matters which encoder produced it.

---

## Setup

Live: **https://lakebase-search-clip-embeddings-tau.vercel.app**

Requires Node 22+ and a Neon project with `lakebase_vector` and `lakebase_text`
enabled.

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL + the Neon Storage keys
npm run setup             # pull → embed → migrate → load → index
npm run dev
```

`npm run setup` defaults to 2,000 photos, which is enough to see every query
shape work and takes about five minutes on a laptop. For the full 31,014:

```bash
npm run dataset:pull -- --limit all
npm run dataset:embed
npm run dataset:load
npm run db:index -- --drop
```

Every step is resumable — re-running skips what is already done — so a failed
pull or a closed laptop costs you nothing.

---

## The scripts

| Command                         | What it does                                            |
| ------------------------------- | ------------------------------------------------------- |
| `npm run dataset:pull`          | Flickr30k → Neon Storage + `data/metadata.jsonl`        |
| `npm run dataset:embed`         | CLIP over images and captions → `data/embeddings.jsonl` |
| `npm run db:migrate`            | Drizzle migrations — tables only                        |
| `npm run dataset:load`          | Embeddings → Postgres over one connection               |
| `npm run db:index`              | Builds the three Lakebase indexes                       |
| `npm run db:stats`              | Partition layout, index sizes, current GUCs             |
| `npm run query -- --text "..."` | Every query shape, from the terminal                    |

The app itself adds two things the scripts don't: queries are debounced 100 ms
and served from `/api/search` with shimmer skeletons and in-flight cancellation,
and you can upload your own image to search against the corpus — it is embedded
and discarded, never stored. The first render is still server-side, so the page
works with JavaScript off.

### Pulling without downloading 4.4 GB

The dataset repo ships one 4.4 GB zip you cannot take a slice of. Hugging Face's
auto-converted parquet is 9 shards of 3,800 rows, each cut into row groups of
100 — so `pull-dataset.ts` uses HTTP range requests to fetch exactly as many row
groups as `--limit` asks for. Pulling 2,000 photos moves ~270 MB.

One trap worth knowing: hyparquet decodes every `BYTE_ARRAY` as UTF-8 by
default, which silently destroys JPEG bytes (every byte above `0x7f` becomes
`U+FFFD`). The script passes `utf8: false`. The text columns carry a `UTF8`
converted type, so they still come back as strings either way.

### Normalisation is not optional

CLIP's projection heads do not produce unit vectors — raw norms run around 8–12
and vary with image content. `vector_cosine_ops` divides by the norms itself, so
_ranking_ survives either way, but the distances you read back are meaningless
unless the inputs are normalised, and an inner-product index would rank by
magnitude instead of angle. Everything is L2-normalised at write time
([`src/lib/clip.ts`](src/lib/clip.ts)).

---

## Where the indexes live, and why not in Drizzle

Drizzle owns the tables. [`scripts/create-indexes.ts`](scripts/create-indexes.ts)
owns the indexes. Two reasons:

1. **drizzle-kit does not model these access methods.** `lakebase_ann` and
   `lakebase_bm25` are extension-provided AMs with their own opclasses and their
   own `WITH` options (`build_mode`, `k1`, `b`). A generated migration will not
   round-trip them.
2. **Order matters.** drizzle-kit creates indexes alongside tables, and both of
   these want a populated table. An ANN index built on zero rows has no
   partitions to probe; BM25 scoring depends on corpus-wide document-length
   statistics. Insert first, index second.

```sql
create index photos_embedding_ann on photos
  using lakebase_ann (embedding vector_cosine_ops) with (build_mode = 'standard');

create index captions_tsv_bm25 on captions
  using lakebase_bm25 (tsv tsvector_bm25_ops) with (k1 = 1.2, b = 0.75);
```

## Two things about BM25 that will bite you

`to_bm25query()` takes the **index** as its second argument, not a text config —
BM25 scoring needs that index's corpus statistics:

```sql
tsv <@> to_bm25query(to_tsvector('english', $1), 'captions_tsv_bm25')
```

And `<@>` returns a **negative** score, so `order by score` ascending is
most-relevant-first. That matches the vector operators rather than fighting them,
but it reads backwards the first time.

## Radius search — the one pgvector cannot index

```sql
select id from photos
where embedding <<=>> sphere($1::vector, 0.15);
```

Against pgvector, `where embedding <=> $1 < 0.15` is a _filter_: the index sorts
by distance and cannot seek by it, so you scan the table. `lakebase_ann`
registers `<<=>>` as a strategy on `vector_cosine_ops`, so the bound is pushed
into the index and only the matching region is read. The practical use is "find
every near-duplicate of this photo" — an unbounded result set where you care
about the threshold, not a top-k.

`sphere()` is not in the Databricks docs at the time of writing; it is in the
extension. Version-stamp anything you build on it.

**Pick the radius from your own corpus.** CLIP image vectors occupy a narrow
cone, so the useful range is far tighter than intuition suggests. Measured over
these 2,000 photos (nearest-neighbour distance, 300-photo sample):

| min   | p05   | p25   | median | max   |
| ----- | ----- | ----- | ------ | ----- |
| 0.080 | 0.146 | 0.216 | 0.253  | 0.398 |

So `0.15` is a genuine near-duplicate threshold — and it correctly returns
**nothing** for most photos, because most photos have no near-duplicate. `~0.25`
is the "visually similar" band. A radius that works here will not transfer to a
corpus with a different embedding model or subject mix; measure first. The UI
exposes the radius as a slider for exactly this reason.

## Two CLIP gotchas the distances will show you

**Cross-modal distances look terrible and are fine.** A text query matching the
right photo still scores ~0.66 cosine, because the text and image towers occupy
different regions of the shared space (the "modality gap"). Ranking is correct;
the absolute number is not comparable to image-image distances. Don't threshold
across modalities.

**Ligatures will lie to you.** Most coding fonts render `<=` and `=>` as arrow
glyphs, which turns `<=>` and `<<=>>` into something you cannot type. Anywhere
this project shows an operator it sets `font-variant-ligatures: none`.

## Where the time actually goes

The app reports `embed / query / sign / total` separately, against the
connection's round-trip floor, because a single number lies. Measured warm on
2,000 photos from a laptop to a `us-east-1` Neon endpoint:

|                       | embed | query  | network floor | total  |
| --------------------- | ----- | ------ | ------------- | ------ |
| Semantic (text→image) | 6 ms  | 271 ms | 271 ms        | 287 ms |
| Keyword (BM25)        | 0 ms  | 271 ms | 271 ms        | 279 ms |
| Image→image           | 0 ms  | 286 ms | 271 ms        | 301 ms |
| Image→caption         | 0 ms  | 294 ms | 271 ms        | 307 ms |
| Radius                | 0 ms  | 307 ms | 271 ms        | 311 ms |

An empty `select 1` on that connection costs **271 ms**. `EXPLAIN ANALYZE` on
the server puts the radius query at **16.9 ms**. So essentially the whole
"query" figure is geography, and none of it is the index — which is exactly why
the app shows the floor next to the number.

Deploying to Vercel in the same region as the database proves it. Same code,
same corpus, same indexes:

|                              | network floor | query     | total      |
| ---------------------------- | ------------- | --------- | ---------- |
| Laptop → `us-east-1`         | 271 ms        | 271 ms    | 287 ms     |
| Vercel `us-east-1` → same DB | **7 ms**      | **14 ms** | **106 ms** |

The floor fell 39×, and `queryMs` landed at 14-70 ms — right where
`EXPLAIN ANALYZE` said the index was all along. Nothing about the schema, the
indexes, or the SQL changed. **If your vector search feels slow, measure the
round trip before you touch the index.**

Two things follow, and both are in the code:

- **A warm CLIP forward pass is ~6 ms**, not the hundreds of ms the first call
  suggests. The first request pays a one-time ~600 MB model load.
- **Round trips matter more than query complexity.** When the query is a photo
  already in the table, `db/queries.ts` passes its _id_ and resolves the vector
  in a subselect rather than fetching 8 KB of vector out and sending it back.
  That took image→image and radius from two serial round trips to one — radius
  went from 2,712 ms to 307 ms, with no index change at all.

## Tuning

`npm run db:stats` prints what `lakebase_ann_index_info()` reports. Read the
`lists` array first:

```
photos_embedding_ann  [lakebase_ann]  on photos  696 kB
  epsilon (default): 1.900
  partitions:        none (flat scan)
```

Empty `lists` means the corpus is too small for the index to partition, every
query is already scanning everything, and no `lakebase_ann.probes` value will
change a result. **Tuning guides do not work on a toy table.** Load the full
31k before drawing conclusions about probes or recall.

`lakebase_ann.probes` takes one value per entry in `lists`, and it is a session
GUC — tuning is per-connection, not per-index.

## Storage

Images live in Neon Storage, which is S3-compatible: the ordinary AWS SDK talks
to it, and the only things that differ are the endpoint and `forcePathStyle`
(virtual-host style is not served). The bucket is private, so the app hands the
browser presigned URLs — signing is local HMAC with no round trip, so a grid of
24 results costs nothing measurable, and the bytes travel storage → browser
without passing back through the Astro server.

## Deploying

`@astrojs/vercel` with `maxDuration: 60`. The one thing that needs handling:
transformers.js ships no weights — it downloads `text_model.onnx` (242 MB) and
`vision_model.onnx` (335 MB) from the HuggingFace CDN on first use, and its
default cache path inside `node_modules` is read-only on a serverless
filesystem. `src/lib/clip.ts` redirects it to `/tmp` when `VERCEL` is set.

That works, but the cost is real and per-instance, not one-time:

|                           | cold       | warm       |
| ------------------------- | ---------- | ---------- |
| Semantic text (`embedMs`) | ~13 s      | 32–48 ms   |
| Image upload (`embedMs`)  | ~8.8 s     | ~300 ms    |
| Keyword / photo-id modes  | unaffected | unaffected |

Every cold lambda pays the download again. The modes driven by a stored
`photo_id` — image→image, image→caption, radius — and BM25 never load the model
at all, so they stay at ~50-100 ms cold or warm. If you need the text path to be
uniformly fast, pin the weights into the deployment or move embedding to a
service that stays warm.

One gotcha when testing the deployed API by hand: Astro's `security.checkOrigin`
is on by default, so `POST /api/search` returns **403 Cross-site POST form
submissions are forbidden** without a matching `Origin` header. The browser
sends it; `curl` does not. Add `-H "Origin: <your-deployment>"`.

## Versions

`lakebase_text` 0.1.0-dev and `lakebase_vector` 1.0.0-dev on Postgres 18.4, with
`vector` 0.8.1. Both extensions are pre-release and `lakebase_text` is
documented as beta — expect defaults to move.
