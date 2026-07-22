/**
 * Create the tables.
 *
 * This is the whole schema, in the SQL Postgres actually runs. There is no ORM
 * and no migration history: the corpus is loaded from scratch by `npm run
 * setup`, so a generated diff between two versions of a schema was never
 * something this project could use.
 *
 * Every statement is `if not exists`, so running it twice is a no-op and
 * running it against a populated database leaves the data alone.
 *
 * The Lakebase indexes are deliberately not here. They have to be built against
 * a populated table, so they live in create-indexes.ts and run after the load.
 *
 *   npx tsx scripts/create-schema.ts
 *   npx tsx scripts/create-schema.ts --drop   # tear down first, destroys data
 */
import { httpDb } from '@/db/index'
import { formatDuration, parseArgs } from '@scripts/lib/util'

/** CLIP ViT-B/32 projects both towers into the same 512-dimension space. */
const CLIP_DIMS = 512

const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: 'extension vector',
    sql: `create extension if not exists vector`,
  },
  {
    // Flickr's own image id, e.g. "1000092795" from 1000092795.jpg.
    label: 'table photos',
    sql: `
      create table if not exists photos (
        id        text primary key,
        filename  text not null,
        width     integer not null,
        height    integer not null,
        -- The dataset's original train/val/test split, kept so results stay traceable.
        split     text not null,
        -- Output of the CLIP vision tower, L2-normalised at write time.
        embedding vector(${CLIP_DIMS}) not null
      )`,
  },
  {
    label: 'index photos_split_idx',
    sql: `create index if not exists photos_split_idx on photos (split)`,
  },
  {
    label: 'table captions',
    sql: `
      create table if not exists captions (
        id        serial primary key,
        photo_id  text not null references photos(id) on delete cascade,
        -- Which of the five captions this is, 0-4.
        idx       smallint not null,
        body      text not null,
        -- Output of the CLIP *text* tower for the same caption, so caption
        -- vectors and photo vectors are directly comparable.
        embedding vector(${CLIP_DIMS}) not null,
        -- Generated, so BM25 never indexes a stale lexeme set.
        tsv       tsvector generated always as (to_tsvector('english', body)) stored
      )`,
  },
  {
    label: 'index captions_photo_idx_key',
    sql: `create unique index if not exists captions_photo_idx_key on captions (photo_id, idx)`,
  },
  {
    // Text query to its CLIP vector, so a repeated search never runs the model.
    // Keyed on the normalised query text, so the primary key is the whole
    // index. No ANN index here and there should not be one: this is exact-match
    // lookup on text, never a similarity search.
    label: 'table query_embeddings',
    sql: `
      create table if not exists query_embeddings (
        query      text primary key,
        embedding  vector(${CLIP_DIMS}) not null,
        created_at timestamptz not null default now()
      )`,
  },
]

/** Reverse order, so foreign keys never block a drop. */
const DROP_ORDER = ['query_embeddings', 'captions', 'photos']

/**
 * Over HTTP, not a WebSocket session. Every statement here is independent and
 * idempotent, so there is nothing to hold a connection open for: no
 * transaction, no `SET`, no `CREATE INDEX CONCURRENTLY`. That makes this the
 * one setup script with nothing to clean up.
 */
async function main() {
  const args = parseArgs()
  const db = httpDb()
  const started = Date.now()

  if ('drop' in args) {
    for (const table of DROP_ORDER) {
      await db.query(`drop table if exists ${table} cascade`)
      console.log(`  dropped ${table}`)
    }
  }

  for (const { label, sql } of STATEMENTS) {
    await db.query(sql)
    console.log(`  ${label}`)
  }

  const rows = await db.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`,
  )
  console.log(`\nschema ready in ${formatDuration(Date.now() - started)}: ${rows.map((r) => r.table_name).join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
