/**
 * Build the Lakebase Search indexes.
 *
 * Why this lives outside create-schema.ts
 * ---------------------------------------
 * Order. Both of these want a populated table: an ANN index built on zero rows
 * has no partitions to probe, and BM25 scoring depends on corpus-wide
 * document-length statistics. Creating them alongside the tables would produce
 * indexes that are technically present and practically useless.
 *
 * So: create-schema.ts owns the tables, this script owns the indexes, and it
 * runs after the load.
 *
 *   npx tsx scripts/create-indexes.ts
 *   npx tsx scripts/create-indexes.ts --drop      # rebuild from scratch
 *   npx tsx scripts/create-indexes.ts --concurrently
 */
import { connect } from '@/db/index'
import { INDEXES, REQUIRED_EXTENSIONS } from '@/lakebase/indexes'
import { formatDuration, parseArgs } from '@scripts/lib/util'

async function main() {
  const args = parseArgs()
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block; the driver
  // sends these as individual statements, so it is safe, just slower.
  const concurrently = args.concurrently ? 'concurrently' : ''

  const { client, db } = await connect()
  try {
    // Both extensions ship preinstalled on Neon, but assert rather than assume:
    // a failure here is far easier to read than "access method does not exist".
    const exts = await db.query<{ extname: string; extversion: string }>(`select extname, extversion from pg_extension where extname = any($1::text[]) order by extname`, [
      REQUIRED_EXTENSIONS,
    ])
    const found = new Set(exts.map((e) => e.extname))
    for (const required of REQUIRED_EXTENSIONS) {
      if (!found.has(required)) {
        throw new Error(`extension "${required}" is not installed on this database. ` + `Lakebase Search is available on Neon projects with the extension enabled.`)
      }
    }
    console.log('extensions:')
    for (const e of exts) console.log(`  ${e.extname} ${e.extversion}`)

    const counts = await db.query<{ photos: string; captions: string }>(
      `select (select count(*) from photos) as photos,
              (select count(*) from captions) as captions`,
    )
    const { photos: nPhotos, captions: nCaptions } = counts[0]!
    console.log(`rows: ${nPhotos} photos, ${nCaptions} captions`)
    if (Number(nPhotos) === 0) {
      throw new Error('photos table is empty, run `npm run dataset:load` before indexing')
    }

    for (const spec of INDEXES) {
      if (args.drop) {
        await db.query(`drop index if exists ${spec.name}`)
      }
      const started = Date.now()
      process.stdout.write(`building ${spec.name} (${spec.note})... `)
      try {
        await db.query(spec.ddl(concurrently))
        console.log(formatDuration(Date.now() - started))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/already exists/.test(message)) {
          console.log('already exists (use --drop to rebuild)')
        } else {
          throw err
        }
      }
    }

    // Sizes are worth publishing alongside the tutorial.
    const sizes = await db.query<{ indexname: string; size: string }>(`
      select indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) as size
      from pg_indexes
      where schemaname = 'public' and tablename in ('photos', 'captions')
      order by pg_relation_size(indexname::regclass) desc
    `)
    console.log('\nindex sizes:')
    for (const s of sizes) console.log(`  ${s.indexname.padEnd(28)} ${s.size}`)

    console.log('\nnext: npm run db:stats   (partition layout + probe tuning)')
    console.log('      npm run query -- --text "a dog running on the beach"')
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
