import type { Db } from '@/db/index'
import { binder, CAPTION_SUBSELECT, normaliseHit, type Binder, type CaptionHit, type PhotoHit } from '@/db/sql'
import { DEFAULT_RADIUS } from '@/lakebase/modes'

/**
 * Vector search over `lakebase_ann`.
 *
 * Everything here is an approximate-nearest-neighbour query against the index
 * created in lakebase/indexes.ts. Two operators do all the work:
 *
 *   <=>     cosine distance. Ordering by it is a top-k ANN scan.
 *   <<=>>   the radius operator. `WHERE embedding <<=>> sphere($1, $2)` pushes
 *           a distance *bound* into the index, which plain pgvector cannot do.
 *
 * That second one is the interesting half of this demo, see searchRadius.
 */

/**
 * A query vector is either one we computed (a text or upload embedding) or one
 * already sitting in the table (an existing photo).
 */
export type QueryVector = { embedding: number[] } | { photoId: string }

/**
 * pgvector wants its literal as '[a,b,c]'. Bound as a parameter and cast, so
 * the plan is reused and nothing is string-concatenated into SQL.
 *
 * When the query *is* a stored photo, emit a subselect instead of shipping the
 * vector out and back. A 512-d vector is ~8KB of JSON each way, and fetching it
 * first costs a whole extra round trip, which on a cross-region HTTP connection
 * is far more than the index scan itself.
 *
 * The returned fragment is reused wherever the vector appears in a statement,
 * so the value binds once however many times it is referenced.
 */
function vec(source: QueryVector, b: Binder): string {
  return 'photoId' in source ? `(select embedding from photos where id = ${b.add(source.photoId)})` : `${b.add(JSON.stringify(source.embedding))}::vector`
}

/**
 * Text→image and image→image are the *same query*. CLIP puts both towers in one
 * space, so once you hold a 512-d vector it no longer matters which encoder
 * produced it. That is the whole trick, and it is why there is one function
 * here rather than two.
 *
 * Note the SQL is exactly what you would write against pgvector's HNSW or IVF:
 * `ORDER BY embedding <=> $1 LIMIT n`. Swapping the index type changes the plan
 * and the recall, not the query.
 */
export async function searchPhotos(db: Db, source: QueryVector, { limit = 24, excludeId }: { limit?: number; excludeId?: string } = {}): Promise<PhotoHit[]> {
  const b = binder()
  const query = vec(source, b)
  const where = excludeId ? `where p.id <> ${b.add(excludeId)}` : ''
  const rows = await db.query<PhotoHit>(
    `select p.id,
            p.filename,
            p.width,
            p.height,
            p.embedding <=> ${query} as distance,
            ${CAPTION_SUBSELECT} as caption
     from photos p
     ${where}
     order by p.embedding <=> ${query}
     limit ${b.add(limit)}`,
    b.values,
  )
  return rows.map(normaliseHit)
}

/**
 * Image→caption. Same vector, different table: rank the 5x larger caption
 * corpus against a photo's own embedding to see how the model describes it.
 */
export async function searchCaptions(db: Db, source: QueryVector, { limit = 24 }: { limit?: number } = {}): Promise<CaptionHit[]> {
  const b = binder()
  const query = vec(source, b)
  const rows = await db.query<CaptionHit>(
    `select c.id,
            c.photo_id as "photoId",
            p.filename,
            c.body,
            c.embedding <=> ${query} as score
     from captions c
     join photos p on p.id = c.photo_id
     order by c.embedding <=> ${query}
     limit ${b.add(limit)}`,
    b.values,
  )
  return rows.map((r) => ({ ...r, score: Number(r.score) }))
}

/**
 * Radius search: every photo within `radius` cosine distance of the query.
 *
 * This is the one query shape here that pgvector cannot answer from an index.
 * `WHERE embedding <=> $1 < 0.1` against pgvector is a filter: the index sorts
 * by distance and cannot seek by it, so you scan. lakebase_ann registers
 * `<<=>>` as a strategy on vector_cosine_ops, so the bound is pushed into the
 * index and only the matching region is read.
 *
 * The practical use is "find every near-duplicate of this photo": an unbounded
 * result set where you care about the threshold, not about a top-k.
 *
 * Picking a radius needs the corpus's own distance scale. CLIP image vectors
 * occupy a narrow cone, so the numbers are tighter than intuition suggests.
 * Measured over this corpus, photo-to-photo nearest-neighbour distance is p05
 * 0.14, p50 0.25, p95 0.35. So 0.15 is a true near-duplicate threshold that
 * correctly returns *nothing* for most photos, and 0.20 is the band where the
 * densest neighbourhoods return a readable handful.
 *
 * Anything at or above 0.25 saturates: on the twenty densest photos every one
 * of them hits the 60-row cap by 0.30, at which point the threshold is not
 * discriminating and the mode looks like a plain top-k. Measure before you
 * pick, and never carry a radius across corpora.
 *
 * Note this is only meaningful photo-to-photo. A text query never lands closer
 * than ~0.66 to any image (the CLIP modality gap), so no radius in the useful
 * range can match one. See DEFAULT_RADIUS in lakebase/modes.ts.
 */
export async function searchRadius(
  db: Db,
  source: QueryVector,
  { radius = DEFAULT_RADIUS, limit = 60, excludeId }: { radius?: number; limit?: number; excludeId?: string } = {},
): Promise<PhotoHit[]> {
  const b = binder()
  const query = vec(source, b)
  const sphere = `sphere(${query}, ${b.add(radius)}::real)`
  const exclude = excludeId ? `and p.id <> ${b.add(excludeId)}` : ''
  const rows = await db.query<PhotoHit>(
    `select p.id,
            p.filename,
            p.width,
            p.height,
            p.embedding <=> ${query} as distance,
            ${CAPTION_SUBSELECT} as caption
     from photos p
     where p.embedding <<=>> ${sphere}
       ${exclude}
     order by p.embedding <=> ${query}
     limit ${b.add(limit)}`,
    b.values,
  )
  return rows.map(normaliseHit)
}
