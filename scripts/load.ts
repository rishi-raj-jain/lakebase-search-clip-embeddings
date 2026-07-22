/**
 * Push embeddings into Neon over a single @neondatabase/serverless connection.
 *
 * Load order matters. Both lakebase indexes are built afterwards by
 * scripts/create-indexes.ts, never before: building an ANN index on an empty
 * table gives it nothing to partition on, and BM25 needs the corpus present to
 * compute document-length statistics. Insert first, index second.
 *
 *   npx tsx scripts/load.ts --batch 250 --truncate
 */
import { connect, type Db } from '@/db/index'
import type { PhotoEmbedding } from '@scripts/embed'
import { EMBEDDINGS_FILE, batched, fileExists, formatDuration, parseArgs, readJsonl } from '@scripts/lib/util'

/**
 * Multi-row INSERT ... ON CONFLICT DO NOTHING, built from a row array.
 *
 * Postgres caps a statement at 65535 bound parameters, so callers chunk by
 * (columns x rows). Vectors go over as their '[a,b,c]' text form and are cast
 * per row, which is what the driver would do anyway.
 */
async function insertRows(db: Db, table: string, columns: string[], rows: unknown[][], casts: Record<number, string> = {}) {
  if (rows.length === 0) return
  const values: unknown[] = []
  const tuples = rows.map((row) => {
    const placeholders = row.map((value, i) => {
      values.push(value)
      return `$${values.length}${casts[i] ?? ''}`
    })
    return `(${placeholders.join(',')})`
  })
  await db.query(`insert into ${table} (${columns.join(',')}) values ${tuples.join(',')} on conflict do nothing`, values)
}

async function main() {
  const args = parseArgs()
  const batchSize = Number(args.batch ?? 250)

  if (!(await fileExists(EMBEDDINGS_FILE))) {
    throw new Error(`${EMBEDDINGS_FILE} not found, run: npm run dataset:embed`)
  }

  const { client, db } = await connect()
  const started = Date.now()

  try {
    if (args.truncate) {
      console.log('truncating photos + captions')
      await db.query(`truncate table captions, photos restart identity cascade`)
    }

    let photoCount = 0
    let captionCount = 0

    for await (const batch of batched(readJsonl<PhotoEmbedding>(EMBEDDINGS_FILE), batchSize)) {
      // One transaction per batch: a crash mid-load leaves no photo without its
      // captions, so a re-run with `on conflict do nothing` resumes cleanly.
      await db.query('begin')
      try {
        await insertRows(
          db,
          'photos',
          ['id', 'filename', 'width', 'height', 'split', 'embedding'],
          batch.map((p) => [p.id, p.filename, p.width, p.height, p.split, JSON.stringify(p.embedding)]),
          { 5: '::vector' },
        )

        const captionRows = batch.flatMap((p) => p.captions.map((c) => [p.id, c.idx, c.body, JSON.stringify(c.embedding)]))
        // 4 bound params per caption row; stay well under the 65535 limit.
        for (const chunk of chunks(captionRows, 1000)) {
          await insertRows(db, 'captions', ['photo_id', 'idx', 'body', 'embedding'], chunk, { 3: '::vector' })
        }
        captionCount += captionRows.length
        await db.query('commit')
      } catch (err) {
        await db.query('rollback')
        throw err
      }

      photoCount += batch.length
      console.log(`  ${photoCount} photos / ${captionCount} captions`)
    }

    console.log(`\nanalyzing`)
    await db.query(`analyze photos`)
    await db.query(`analyze captions`)

    const [{ photos: p, captions: c }] = await db.query<{ photos: string; captions: string }>(
      `select (select count(*) from photos) as photos,
              (select count(*) from captions) as captions`,
    )

    console.log(`\nloaded in ${formatDuration(Date.now() - started)}`)
    console.log(`  photos:   ${p}`)
    console.log(`  captions: ${c}`)
    console.log('next: npm run db:index')
  } finally {
    await client.end()
  }
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
