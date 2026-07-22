/**
 * Precompute CLIP vectors for the queries the app is guaranteed to run.
 *
 * The page fires DEFAULT_QUERY on every single load, so without this every cold
 * instance downloads 242MB of ONNX weights to embed one string constant. The
 * example links are fixed too. Seeding them means a fresh deployment serves its
 * first searches straight from Postgres and never touches the model.
 *
 * Safe to re-run: the insert is `on conflict do nothing`.
 */
import { httpDb } from '@/db/index'
import { getCachedEmbedding, putCachedEmbedding } from '@/db/queries'
import { DEFAULT_QUERY } from '@/lakebase/modes'
import { embedText } from '@/lib/clip'

/**
 * DEFAULT_QUERY is 'a dog running on the beach', the one the page runs on every
 * load. It is referenced rather than written out so the two can never drift.
 * The rest are the "Try ..." links in app/page.tsx.
 */
const SEED_QUERIES = [DEFAULT_QUERY, 'man in a red shirt on a bicycle', 'bicycle']

async function main() {
  const db = httpDb()
  let embedded = 0
  let skipped = 0

  for (const query of SEED_QUERIES) {
    if (await getCachedEmbedding(db, query)) {
      console.log(`  cached   "${query}"`)
      skipped++
      continue
    }
    const started = Date.now()
    await putCachedEmbedding(db, query, await embedText(query))
    console.log(`  embedded "${query}" in ${Date.now() - started}ms`)
    embedded++
  }

  console.log(`\n${embedded} embedded, ${skipped} already cached`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
