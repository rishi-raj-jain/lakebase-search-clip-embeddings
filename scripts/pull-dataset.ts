/**
 * Pull nlphuji/flickr30k from the Hugging Face parquet conversion and push the
 * JPEGs into Neon Storage.
 *
 * The dataset repo itself ships a single 4.4GB zip, which you cannot take a
 * slice of. The auto-converted parquet is 9 shards of 3,800 rows, and each
 * shard is cut into row groups of 100, so with HTTP range requests we fetch
 * exactly as many row groups as `--limit` asks for and stop. Pulling 2,000
 * photos moves ~270MB, not 4.4GB.
 *
 * Images go to the bucket (the app serves them from there via presigned URLs)
 * and, unless --no-cache, also to data/images so the embed pass can read pixels
 * back without re-downloading. Metadata goes to data/metadata.jsonl.
 *
 *   npx tsx scripts/pull-dataset.ts --limit 2000
 *   npx tsx scripts/pull-dataset.ts --limit all --concurrency 16
 */
import { putImage } from '@/lib/storage'
import { DATA_DIR, IMAGES_DIR, METADATA_FILE, fileExists, formatDuration, parseArgs } from '@scripts/lib/util'
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const SHARD_COUNT = 9
const shardUrl = (i: number) => `https://huggingface.co/api/datasets/nlphuji/flickr30k/parquet/TEST/test/${i}.parquet`

export type PhotoMeta = {
  id: string
  filename: string
  split: string
  captions: string[]
}

/** An AsyncBuffer backed by HTTP range requests against a Hugging Face URL. */
async function remoteParquet(url: string): Promise<AsyncBuffer> {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`)
  const byteLength = Number(head.headers.get('content-length'))
  if (!byteLength) throw new Error(`no content-length for ${url}`)

  return {
    byteLength,
    async slice(start: number, end?: number) {
      const stop = (end ?? byteLength) - 1
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${stop}` } })
      if (!res.ok) throw new Error(`GET ${url} bytes=${start}-${stop} -> ${res.status}`)
      return res.arrayBuffer()
    },
  }
}

/** Run `worker` over items with a fixed number of uploads in flight. */
async function pooled<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        await worker(items[cursor++]!)
      }
    }),
  )
}

async function main() {
  const args = parseArgs()
  const limitArg = args.limit ?? '2000'
  const limit = limitArg === 'all' ? Infinity : Number(limitArg)
  if (Number.isNaN(limit) || limit <= 0) throw new Error(`bad --limit: ${limitArg}`)
  const concurrency = Number(args.concurrency ?? 12)
  const keepCache = args['no-cache'] !== 'true'

  await mkdir(DATA_DIR, { recursive: true })
  if (keepCache) await mkdir(IMAGES_DIR, { recursive: true })

  // Resume: keep whatever a previous run already pulled.
  const seen = new Set<string>()
  if (await fileExists(METADATA_FILE)) {
    for (const line of (await readFile(METADATA_FILE, 'utf8')).split('\n')) {
      if (line.trim()) seen.add((JSON.parse(line) as PhotoMeta).id)
    }
    console.log(`resuming, ${seen.size} photos already pulled`)
  }

  const out = createWriteStream(METADATA_FILE, { flags: 'a' })
  const write = (records: PhotoMeta[]) =>
    new Promise<void>((resolve, reject) => out.write(records.map((r) => JSON.stringify(r)).join('\n') + '\n', (err) => (err ? reject(err) : resolve())))

  let total = seen.size
  let uploaded = 0
  const started = Date.now()

  for (let shard = 0; shard < SHARD_COUNT && total < limit; shard++) {
    const url = shardUrl(shard)
    const file = await remoteParquet(url)
    const meta = await parquetMetadataAsync(file)
    console.log(`shard ${shard}: ${meta.num_rows} rows in ${meta.row_groups.length} row groups ` + `(${(file.byteLength / 1e6).toFixed(0)}MB total)`)

    let rowStart = 0
    for (const group of meta.row_groups) {
      if (total >= limit) break
      const rowEnd = rowStart + Number(group.num_rows)

      // `utf8: false` stops hyparquet decoding every BYTE_ARRAY as a string.
      // image.bytes is raw JPEG and gets destroyed by that (every byte above
      // 0x7f becomes U+FFFD); the text columns carry a UTF8 converted_type, so
      // they still come back as strings either way.
      const rows = await parquetReadObjects({ file, compressors, rowStart, rowEnd, utf8: false })
      rowStart = rowEnd

      const pending: { meta: PhotoMeta; bytes: Uint8Array<ArrayBuffer> }[] = []
      for (const row of rows) {
        if (total + pending.length >= limit) break
        const filename = String(row.filename)
        const id = filename.replace(/\.jpg$/i, '')
        if (seen.has(id)) continue

        // Parquet decoding always yields a plain ArrayBuffer-backed array; the
        // guard below is what actually holds this cast up.
        const bytes = row.image.bytes as Uint8Array<ArrayBuffer>
        // Guard against a future hyparquet default flipping back under us.
        if (!(bytes instanceof Uint8Array)) {
          throw new Error(`image.bytes for ${filename} is ${typeof bytes}, expected Uint8Array`)
        }
        seen.add(id)
        pending.push({
          bytes,
          meta: {
            id,
            filename,
            split: String(row.split),
            captions: (row.caption as string[]).map((c) => String(c).trim()),
          },
        })
      }
      if (pending.length === 0) continue

      await pooled(pending, concurrency, async ({ meta, bytes }) => {
        await putImage(meta.filename, bytes)
        if (keepCache) await writeFile(`${IMAGES_DIR}/${meta.filename}`, bytes)
        uploaded++
      })

      // Only record metadata once the bytes are safely in the bucket, so a
      // resumed run never skips a photo it failed to upload.
      await write(pending.map((p) => p.meta))
      total += pending.length

      const rate = uploaded / ((Date.now() - started) / 1000)
      console.log(`  ${total} photos (${rate.toFixed(1)} uploads/s)`)
    }
  }

  await new Promise<void>((resolve) => out.end(resolve))
  console.log(`\ndone in ${formatDuration(Date.now() - started)}: ${total} photos`)
  console.log(`  bucket:   ${process.env.S3_BUCKET}/flickr30k/`)
  if (keepCache) console.log(`  cache:    ${IMAGES_DIR}`)
  console.log(`  metadata: ${METADATA_FILE}`)
  console.log('next: npm run dataset:embed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
