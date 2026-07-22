import type { Db } from '@/db/index'
import { binder, CAPTION_SUBSELECT } from '@/db/sql'

/**
 * Ordinary Postgres. Nothing here touches a Lakebase index or a vector
 * operator: these are the lookups the app needs to render a page.
 *
 * The retrieval this project is actually demonstrating lives in src/lakebase/.
 */

export type { Db }

/** Just the filename, for rendering the query-image preview. No vector. */
export async function getPhotoFilename(db: Db, id: string): Promise<string | null> {
  const rows = await db.query<{ filename: string }>(`select filename from photos where id = $1`, [id])
  return rows[0]?.filename ?? null
}

/** Fetch one photo's stored embedding, for the image→* query shapes. */
export async function getPhotoEmbedding(db: Db, id: string): Promise<{ id: string; filename: string; embedding: number[] } | null> {
  const rows = await db.query<{ id: string; filename: string; embedding: string }>(`select id, filename, embedding::text as embedding from photos where id = $1`, [id])
  const row = rows[0]
  if (!row) return null
  return { id: row.id, filename: row.filename, embedding: JSON.parse(row.embedding) }
}

/**
 * Photos that sit in unusually dense neighbourhoods, measured over this corpus:
 * each has neighbours inside 0.15 cosine, where the median photo has none.
 *
 * They lead the picker because near-duplicate mode is otherwise undemonstrable.
 * Pick an average photo and the honest answer at a strict radius is "nothing",
 * which reads as a broken feature rather than a real result. Surfacing these
 * first means the first thing anyone tries actually shows the mode working.
 */
const DENSE_PHOTO_IDS = ['1020651753', '1523984678', '1019604187', '1358892595', '1348891916', '128912885']

export type SamplePhoto = { id: string; filename: string; caption: string }

/**
 * A page of photos for the image picker: the dense ones first, then a random
 * spread so the grid is not the same six pictures every time.
 */
export async function samplePhotos(db: Db, { limit = 24, match = '' }: { limit?: number; match?: string } = {}): Promise<SamplePhoto[]> {
  // Ids are Flickr's, always digits, and they are also the filename stem. So
  // stripping everything else both sanitises the LIKE pattern (no stray % or _
  // acting as a wildcard) and lets someone paste "1020651753.jpg" or a whole
  // URL and still get the match they meant.
  const digits = match.replace(/\D/g, '')
  const b = binder()

  if (digits) {
    return db.query<SamplePhoto>(
      `select p.id, p.filename, ${CAPTION_SUBSELECT} as caption
       from photos p
       where p.id like ${b.add(`%${digits}%`)}
       order by (p.id like ${b.add(`${digits}%`)}) desc, p.id
       limit ${b.add(limit)}`,
      b.values,
    )
  }

  return db.query<SamplePhoto>(
    `select p.id, p.filename, ${CAPTION_SUBSELECT} as caption
     from photos p
     order by (p.id = any(${b.add(DENSE_PHOTO_IDS)}::text[])) desc, random()
     limit ${b.add(limit)}`,
    b.values,
  )
}

export async function randomPhotoId(db: Db): Promise<string | null> {
  const rows = await db.query<{ id: string }>(`select id from photos order by random() limit 1`)
  return rows[0]?.id ?? null
}

/**
 * The cache key. Case and spacing should not fork the cache, but nothing else
 * is touched: CLIP is sensitive to wording, so "dog on beach" and "a dog on the
 * beach" are genuinely different queries and must stay different rows.
 */
export function normaliseQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Look up a previously embedded query. A miss is ordinary, not an error.
 *
 * Cast to text on the way out because the driver hands vectors back as strings
 * anyway, and JSON.parse of '[a,b,c]' is the cheapest way to a number[].
 */
export async function getCachedEmbedding(db: Db, text: string): Promise<number[] | null> {
  const rows = await db.query<{ embedding: string }>(`select embedding::text as embedding from query_embeddings where query = $1`, [normaliseQuery(text)])
  const row = rows[0]
  return row ? JSON.parse(row.embedding) : null
}

/**
 * Store a freshly computed embedding.
 *
 * `on conflict do nothing` because two concurrent misses for the same query is
 * the normal case on a cold start, and they compute identical vectors. Neither
 * needs to win.
 */
export async function putCachedEmbedding(db: Db, text: string, embedding: number[]): Promise<void> {
  await db.query(`insert into query_embeddings (query, embedding) values ($1, $2::vector) on conflict (query) do nothing`, [normaliseQuery(text), JSON.stringify(embedding)])
}

export type CorpusStats = { photos: number; captions: number }

/**
 * The corpus is loaded once by `npm run setup` and never written to at runtime,
 * so these two counts are effectively constants, but they sit in the header of
 * every page, which made them a serial round trip in front of the first byte.
 * Memoised for the life of the instance: a warm lambda renders the header with
 * no database access at all, and a cold one pays it once.
 *
 * The window is deliberately long. Nothing in the request path can change these
 * numbers; only a re-run of the loader can, and that is a deploy-shaped event.
 */
const STATS_TTL_MS = 10 * 60 * 1000
let statsCache: { at: number; value: CorpusStats } | null = null
let statsInflight: Promise<CorpusStats> | null = null

export async function corpusStats(db: Db): Promise<CorpusStats> {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value
  // Concurrent requests on a cold instance share one query rather than racing.
  statsInflight ??= (async () => {
    try {
      const rows = await db.query<{ photos: string; captions: string }>(
        `select (select count(*) from photos) as photos,
                (select count(*) from captions) as captions`,
      )
      const value = { photos: Number(rows[0]?.photos ?? 0), captions: Number(rows[0]?.captions ?? 0) }
      statsCache = { at: Date.now(), value }
      return value
    } finally {
      statsInflight = null
    }
  })()
  return statsInflight
}
