import { httpDb } from '@/db/index'
import { getCachedEmbedding, getPhotoFilename, putCachedEmbedding, type Db } from '@/db/queries'
import type { CaptionHit, PhotoHit } from '@/db/sql'
import { searchCaptions, searchPhotos, searchRadius, type QueryVector } from '@/lakebase/ann'
import { searchCaptionsBm25 } from '@/lakebase/bm25'
import { DEFAULT_RADIUS, type Mode } from '@/lakebase/modes'
import { imageUrl } from '@/lib/storage'

// Mode metadata lives in its own module so the browser bundle can import it
// without pulling in the database and model code below. Re-exported here so
// existing server-side importers keep working.
export * from '@/lakebase/modes'

export type ResultCard = {
  /**
   * Unique within a result set, unlike `id`.
   *
   * In captions mode `id` is the *photo* id, and one photo can match on several
   * of its five captions, so `id` repeats. Anything rendering these as a keyed
   * list needs a per-row identity, which is what this is.
   */
  key: string
  id: string
  url: string
  caption: string
  score: number
  scoreLabel: string
  width: number
  height: number
}

export type Timings = {
  /** Postgres round trip: the ORDER BY ... LIMIT against the Lakebase index. */
  queryMs: number
}

export type SearchOutcome = {
  cards: ResultCard[]
  timings: Timings
  /** Set when the query was an image rather than text. */
  queryImage?: { id: string; url: string; caption: string }
}

export type SearchInput = {
  mode: Mode
  q?: string
  photoId?: string
  file?: File
  radius?: number
  limit?: number
}

/**
 * A problem with what the caller asked for, not with us.
 *
 * These carry an HTTP status because the distinction is invisible otherwise:
 * every failure used to surface as a 500 with whatever internal message
 * happened to be thrown, so "that file is not a JPEG" and "Postgres is down"
 * looked identical to the user and to any monitoring.
 */
export class InputError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'InputError'
  }
}

/** Bounded, because it is echoed back to the browser. */
const brief = (value: string, max = 64) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** Monotonic ms, so a clock adjustment mid-request cannot produce a negative. */
const now = () => performance.now()
const since = (t: number) => Math.round(now() - t)

const EMPTY: Timings = { queryMs: 0 }

/**
 * A text query's 512-d vector, from the cache when we have seen the string
 * before and from CLIP when we have not.
 *
 * The cache lookup is one indexed round trip against a primary key. The miss
 * path is a 242MB model load on a cold instance, so the two are not remotely
 * comparable in cost, and the hit rate is high in practice: the page fires the
 * same default query on every load and the example links are fixed.
 *
 * A write failure is swallowed. It costs the next request a re-embed, which is
 * strictly better than failing a search that has already succeeded.
 */
async function embedQuery(db: Db, text: string): Promise<number[]> {
  const cached = await getCachedEmbedding(db, text)
  if (cached) return cached

  const { embedText } = await import('@/lib/clip')
  const embedding = await embedText(text)
  await putCachedEmbedding(db, text, embedding).catch(() => {})
  return embedding
}

export async function runSearch(input: SearchInput): Promise<SearchOutcome> {
  const db = httpDb()
  const limit = input.limit ?? 24

  // Keyword search never builds an embedding. That is the whole point of having
  // it here next to the vector modes.
  if (input.mode === 'keyword') {
    if (!input.q?.trim()) return { cards: [], timings: EMPTY }
    const tq = now()
    const hits = await searchCaptionsBm25(db, input.q, { limit })
    const queryMs = since(tq)
    return { cards: await captionCards(hits), timings: { queryMs } }
  }

  // Everything else needs a 512-d query vector. When the query is a photo we
  // already store, we pass its *id* rather than its vector so the embedding is
  // resolved inside the same statement: one round trip, not two.
  let source: QueryVector
  let queryImage: SearchOutcome['queryImage']
  let excludeId: string | undefined

  if (input.file && input.file.size > 0) {
    const bytes = new Uint8Array(await input.file.arrayBuffer())
    const { embedImage } = await import('@/lib/clip')
    try {
      source = {
        embedding: (await embedImage(new Blob([bytes], { type: input.file.type || 'image/jpeg' }))).embedding,
      }
    } catch (err) {
      // Decoding is where a bad upload actually fails, and the message it
      // throws is a libvips internal ("VipsJpeg: premature end of JPEG
      // image"). Not the user's problem to read.
      throw new InputError('That file could not be read as an image. Try a JPEG or PNG.', 415)
    }
  } else if (input.photoId) {
    source = { photoId: input.photoId }
    excludeId = input.photoId
  } else if (input.q?.trim()) {
    source = { embedding: await embedQuery(db, input.q) }
  } else {
    return { cards: [], timings: EMPTY }
  }

  const tq = now()
  // The preview lookup is independent of the search, so run them together
  // rather than paying two serial round trips.
  const [hits, queryFilename] = await Promise.all([
    input.mode === 'captions'
      ? searchCaptions(db, source, { limit })
      : input.mode === 'radius'
        ? searchRadius(db, source, { radius: input.radius ?? DEFAULT_RADIUS, limit: 60, excludeId })
        : searchPhotos(db, source, { limit, excludeId }),
    input.photoId ? getPhotoFilename(db, input.photoId) : Promise.resolve(null),
  ])
  const queryMs = since(tq)

  // An id that is not in the corpus makes vec()'s subselect return NULL, and
  // `embedding <=> NULL` is NULL, so the ORDER BY has nothing to sort on and
  // Postgres hands back arbitrary rows. Silently plausible, entirely wrong.
  // The filename lookup above already tells us, so use it.
  if (input.photoId && !queryFilename) {
    throw new InputError(`No photo with id ${brief(input.photoId)} in this corpus.`, 404)
  }

  const cards = input.mode === 'captions' ? await captionCards(hits as CaptionHit[]) : await photoCards(hits as PhotoHit[])
  if (input.photoId && queryFilename) {
    queryImage = {
      id: input.photoId,
      url: await imageUrl(queryFilename),
      caption: 'Query image',
    }
  }

  return { cards, timings: { queryMs }, queryImage }
}

async function photoCards(hits: PhotoHit[]): Promise<ResultCard[]> {
  return Promise.all(
    hits.map(async (h) => ({
      key: h.id,
      id: h.id,
      url: await imageUrl(h.filename),
      caption: h.caption ?? '',
      score: h.distance,
      scoreLabel: `${h.distance.toFixed(3)} cos`,
      width: h.width,
      height: h.height,
    })),
  )
}

async function captionCards(hits: CaptionHit[]): Promise<ResultCard[]> {
  return Promise.all(
    hits.map(async (h) => ({
      // The caption row's own id, so two captions of one photo stay distinct.
      key: String(h.id),
      id: h.photoId,
      url: await imageUrl(h.filename),
      caption: h.body,
      score: h.score,
      // BM25 scores come back negative; show the magnitude, which reads the way
      // people expect a relevance score to read.
      scoreLabel: h.score < 0 ? `${Math.abs(h.score).toFixed(2)} bm25` : `${h.score.toFixed(3)} cos`,
      width: 0,
      height: 0,
    })),
  )
}
