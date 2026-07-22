/**
 * Mode metadata: the four retrieval modes and everything the UI says about
 * them. Pure data with no database or model imports, because both the server
 * page and the browser bundle need it. The client has to relabel the SQL
 * panel and the hint when you switch modes, and it cannot pull in `search.ts`
 * without dragging Postgres and onnxruntime along with it.
 */
export const MODES = ['semantic', 'keyword', 'captions', 'radius'] as const
export type Mode = (typeof MODES)[number]

/**
 * Shown as the input's placeholder and run on first load, so the page opens on
 * results rather than an empty grid.
 *
 * Chosen by measurement, not taste. A text query can never have near-duplicates
 * of its own (the CLIP modality gap puts it ~0.66 from any image), so the thing
 * that matters is whether its *results* do: click "more like this" on one, hit
 * Near-duplicates, and something should come back. Over this corpus all eight
 * top results for this phrase have at least one neighbour inside DEFAULT_RADIUS,
 * and the first has seven. The previous default, 'a dog running on the beach',
 * managed four of eight, so half the time the mode looked broken.
 *
 * Worth re-measuring if the corpus changes.
 */
export const DEFAULT_QUERY = 'dogs running in a grassy field'

export const MODE_LABELS: Record<Mode, string> = {
  semantic: 'Semantic',
  keyword: 'Keyword (BM25)',
  captions: 'Captions',
  radius: 'Near-duplicates',
}

export const MODE_HINTS: Record<Mode, string> = {
  semantic: 'CLIP vectors, lakebase_ann: matches meaning, not words',
  keyword: 'BM25 over caption lexemes, lakebase_bm25: matches words, not meaning',
  captions: 'The same query vector against the 5x larger caption corpus',
  radius: 'Every photo inside a cosine radius: the shape pgvector cannot index. Pick a photo first, then move the slider.',
}

/** The access method each mode actually leans on, shown on the tab. */
export const MODE_AM: Record<Mode, string> = {
  semantic: 'lakebase_ann',
  keyword: 'lakebase_bm25',
  captions: 'lakebase_ann',
  radius: 'lakebase_ann',
}

/**
 * The SQL behind each mode, kept in sync with db/queries.ts by hand so the page
 * can show the reader what it just ran. Trimmed of the joins and projections
 * that would only add noise.
 */
export const MODE_SQL: Record<Mode, string> = {
  semantic: `select id, filename, embedding <=> $1 as distance
from photos
order by embedding <=> $1
limit 24;`,
  keyword: `select body,
       tsv <@> to_bm25query(
         to_tsvector('english', $1),
         'captions_tsv_bm25'
       ) as score
from captions
order by score          -- <@> is negative: ascending = best
limit 24;`,
  captions: `select body, embedding <=> $1 as score
from captions
order by embedding <=> $1
limit 24;`,
  radius: `select id, filename
from photos
where embedding <<=>> sphere($1, $2)   -- indexed radius
order by embedding <=> $1
limit 60;`,
}

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

/**
 * Measured photo-to-photo nearest-neighbour distance over this corpus is p05
 * 0.14, p50 0.25, p95 0.35, which is why the useful range is so much tighter
 * than the 1.0 the metric allows.
 *
 * 0.18 sits in the band where the answer is still a threshold. At 0.25 the
 * twenty densest photos all return 44-60 rows and by 0.30 every one of them
 * hits the 60-row cap, so the slider stops discriminating and the mode reads as
 * a plain top-k. Lower is the honest default even though it returns nothing for
 * most photos, because that *is* the answer for most photos.
 */
export const DEFAULT_RADIUS = 0.18

/** Parses a radius from a URL param or form field, falling back to the default. */
export function parseRadius(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RADIUS
}
