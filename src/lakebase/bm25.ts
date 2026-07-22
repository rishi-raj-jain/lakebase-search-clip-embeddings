import type { Db } from '@/db/index'
import { binder, type CaptionHit } from '@/db/sql'

/**
 * Keyword search over `lakebase_bm25`.
 *
 * The point of having this next to ann.ts is that the same user query runs
 * against both, over the same captions, and they disagree. Semantic mode
 * matches meaning and will happily return a photo whose caption shares no word
 * with the query; BM25 matches lexemes and will not.
 */

/**
 * Two things to know about the SQL below.
 *
 * `to_bm25query` takes the *index* as its second argument, because BM25 scoring
 * needs that index's corpus statistics: document frequencies and the average
 * document length. This is why the index has to exist before the query makes
 * sense, and it has no pgvector or plain-tsvector equivalent, a `tsvector @@
 * tsquery` match knows nothing about the corpus.
 *
 * And `<@>` returns a **negative** score, so ascending order is
 * most-relevant-first. That matches the vector operators rather than fighting
 * them: every query in this project sorts ascending and takes the head.
 */
export async function searchCaptionsBm25(db: Db, text: string, { limit = 24 }: { limit?: number } = {}): Promise<CaptionHit[]> {
  const b = binder()
  const rows = await db.query<CaptionHit>(
    `select c.id,
            c.photo_id as "photoId",
            p.filename,
            c.body,
            c.tsv <@> to_bm25query(to_tsvector('english', ${b.add(text)}), 'captions_tsv_bm25') as score
     from captions c
     join photos p on p.id = c.photo_id
     order by score
     limit ${b.add(limit)}`,
    b.values,
  )
  return rows.map((r) => ({ ...r, score: Number(r.score) }))
}
