/**
 * Exercise every query shape from the terminal.
 *
 *   npm run query -- --text "a dog running on the beach"
 *   npm run query -- --text "red bicycle" --bm25       # keyword, for contrast
 *   npm run query -- --photo 1000092795                # image → image
 *   npm run query -- --photo 1000092795 --captions     # image → caption
 *   npm run query -- --photo 1000092795 --radius 0.15  # near-duplicates
 *   npm run query -- --file ./some-photo.jpg           # your own image
 */
import { connect } from '@/db/index'
import { corpusStats, getPhotoEmbedding, randomPhotoId } from '@/db/queries'
import { searchCaptions, searchPhotos, searchRadius } from '@/lakebase/ann'
import { searchCaptionsBm25 } from '@/lakebase/bm25'
import { embedImage, embedText } from '@/lib/clip'
import { parseArgs } from '@scripts/lib/util'

async function main() {
  const args = parseArgs()
  const limit = Number(args.limit ?? 10)
  const { client, db } = await connect()

  try {
    const stats = await corpusStats(db)
    console.log(`corpus: ${stats.photos} photos, ${stats.captions} captions\n`)

    // Probe counts are a session GUC, so tuning is per-connection, not per-index.
    if (args.probes) {
      // A GUC name cannot be a bind parameter, and the value is ours from argv.
      await db.query(`set lakebase_ann.probes to '${Number(args.probes)}'`)
      console.log(`lakebase_ann.probes = ${args.probes}`)
    }

    // --- work out the query vector -------------------------------------------
    let embedding: number[]
    let label: string
    let excludeId: string | undefined

    if (args.text) {
      // BM25 is the one path that never touches an embedding.
      if (args.bm25) {
        const started = Date.now()
        const hits = await searchCaptionsBm25(db, args.text, { limit })
        console.log(`bm25 "${args.text}": ${Date.now() - started}ms`)
        for (const h of hits) {
          console.log(`  ${h.score.toFixed(4)}  ${h.photoId}  ${h.body}`)
        }
        return
      }
      embedding = await embedText(args.text)
      label = `text "${args.text}"`
    } else if (args.file) {
      embedding = (await embedImage(args.file)).embedding
      label = `file ${args.file}`
    } else {
      const id = args.photo ?? (await randomPhotoId(db))
      if (!id) throw new Error('no photos in the database, run the loader first')
      const photo = await getPhotoEmbedding(db, id)
      if (!photo) throw new Error(`photo ${id} not found`)
      embedding = photo.embedding
      label = `photo ${photo.id} (${photo.filename})`
      // A photo is always its own nearest neighbour at distance 0; drop it.
      excludeId = photo.id
    }

    // --- run it ---------------------------------------------------------------
    if (args.captions) {
      const started = Date.now()
      const hits = await searchCaptions(db, { embedding }, { limit })
      console.log(`${label} → captions: ${Date.now() - started}ms`)
      for (const h of hits) {
        console.log(`  ${h.score.toFixed(4)}  ${h.photoId}  ${h.body}`)
      }
      return
    }

    if (args.radius) {
      const radius = Number(args.radius)
      const started = Date.now()
      const hits = await searchRadius(db, { embedding }, { radius, limit: 60, excludeId })
      console.log(`${label} → photos within ${radius} cosine: ${hits.length} matches, ` + `${Date.now() - started}ms`)
      for (const h of hits) {
        console.log(`  ${h.distance.toFixed(4)}  ${h.id}  ${truncate(h.caption)}`)
      }
      return
    }

    const started = Date.now()
    const hits = await searchPhotos(db, { embedding }, { limit, excludeId })
    console.log(`${label} → photos: ${Date.now() - started}ms`)
    for (const h of hits) {
      console.log(`  ${h.distance.toFixed(4)}  ${h.id}  ${truncate(h.caption)}`)
    }
  } finally {
    await client.end()
  }
}

const truncate = (s: string | null, n = 70) => (!s ? '' : s.length <= n ? s : s.slice(0, n - 1) + '…')

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
