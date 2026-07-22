/**
 * Pull nlphuji/flickr30k from the Hugging Face parquet conversion and push the
 * JPEGs into Neon Storage.
 */
import { listImages, putImage } from '@/lib/storage'
import { DATA_DIR, IMAGES_DIR, METADATA_FILE, fileExists, formatDuration, parseArgs } from '@scripts/lib/util'
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const SHARD_COUNT = 9
/** Rows in the full Flickr30k conversion, used to size the progress bar. */
const TOTAL_ROWS = 31_014
const shardUrl = (i: number) => `https://huggingface.co/api/datasets/nlphuji/flickr30k/parquet/TEST/test/${i}.parquet`

export type PhotoMeta = {
  id: string
  filename: string
  split: string
  captions: string[]
}

/**
 * A single-line progress bar.
 *
 * Redraws in place on a terminal. When stdout is redirected to a file it falls
 * back to one line every few seconds, because a log full of carriage returns is
 * unreadable and a run that prints nothing for twenty minutes looks hung.
 */
function progress(label: string, done: number, total: number, startedAt: number) {
  const frac = total > 0 ? Math.min(1, done / total) : 0
  const elapsed = (Date.now() - startedAt) / 1000
  const rate = elapsed > 0 ? done / elapsed : 0
  const etaSec = rate > 0 ? (total - done) / rate : 0
  const eta = etaSec > 90 ? `${Math.round(etaSec / 60)}m` : `${Math.round(etaSec)}s`
  const width = 32
  const filled = Math.round(frac * width)
  const bar = '='.repeat(Math.max(0, filled - 1)) + (filled > 0 && filled < width ? '>' : filled === width ? '=' : '')
  const line =
    `  ${label} [${bar.padEnd(width)}] ${String(Math.round(frac * 100)).padStart(3)}%  ` + `${done.toLocaleString()}/${total.toLocaleString()}  ${rate.toFixed(1)}/s  eta ${eta}`

  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}`)
  } else if (done >= total || Date.now() - lastLogged > 5000) {
    lastLogged = Date.now()
    console.log(line)
  }
}
let lastLogged = 0

/** Finish a TTY progress line so the next output starts cleanly. */
const endProgress = () => process.stdout.isTTY && process.stdout.write('\n')

/**
 * Retry with exponential backoff and jitter.
 *
 * Two things this covers that nothing else does. The parquet range requests are
 * plain `fetch` with no retry of their own, and a single dropped connection
 * partway through a 500MB shard would otherwise kill a run that is most of the
 * way done. And while aws4fetch retries 5xx and 429 for uploads, a network
 * error makes `fetch` reject rather than return, which escapes its loop.
 *
 * Jitter matters when 250 uploads fail together: without it they all wake at
 * the same moment and hit the service again in lockstep.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      if (i === attempts - 1) break
      const wait = Math.min(30_000, 500 * 2 ** i) + Math.random() * 250
      const why = err instanceof Error ? err.message.slice(0, 80) : String(err)
      console.log(`  retry ${i + 1}/${attempts - 1} ${label} in ${Math.round(wait)}ms: ${why}`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw last
}

/** An AsyncBuffer backed by HTTP range requests against a Hugging Face URL. */
async function remoteParquet(url: string): Promise<AsyncBuffer> {
  const head = await withRetry(`HEAD ${url}`, async () => {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (!res.ok) throw new Error(`HEAD -> ${res.status}`)
    return res
  })
  const byteLength = Number(head.headers.get('content-length'))
  if (!byteLength) throw new Error(`no content-length for ${url}`)

  return {
    byteLength,
    async slice(start: number, end?: number) {
      const stop = (end ?? byteLength) - 1
      return withRetry(`bytes=${start}-${stop}`, async () => {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${stop}` } })
        if (!res.ok) throw new Error(`GET -> ${res.status}`)
        return res.arrayBuffer()
      })
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
  const batchSize = Number(args.batch ?? 1000)
  const uploadBatch = Number(args['upload-batch'] ?? 250)
  if (batchSize <= 0 || uploadBatch <= 0) throw new Error('--batch and --upload-batch must be positive')
  const skipUpload = 'skip-upload' in args
  const uploadOnly = 'upload-only' in args

  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(IMAGES_DIR, { recursive: true })

  if (uploadOnly) {
    await uploadPass(concurrency, uploadBatch)
    return
  }

  // Resume: keep whatever a previous run already pulled.
  const seen = new Set<string>()
  if (await fileExists(METADATA_FILE)) {
    for (const line of (await readFile(METADATA_FILE, 'utf8')).split('\n')) {
      if (line.trim()) seen.add((JSON.parse(line) as PhotoMeta).id)
    }
    console.log(`resuming, ${seen.size} photos already pulled`)
  }

  const seenAtStart = seen.size
  const out = createWriteStream(METADATA_FILE, { flags: 'a' })
  const write = (records: PhotoMeta[]) =>
    new Promise<void>((resolve, reject) => out.write(records.map((r) => JSON.stringify(r)).join('\n') + '\n', (err) => (err ? reject(err) : resolve())))

  let total = seen.size
  // Rows scanned across all shards, used to skip whole row groups a previous
  // run already consumed. Rows come out in a fixed order and one row is one
  // photo, so the first `seenAtStart` of them are by definition already done.
  let scanned = 0
  const started = Date.now()
  console.log(`\n[1/2] decoding shards to ${IMAGES_DIR}`)

  for (let shard = 0; shard < SHARD_COUNT && total < limit; shard++) {
    const url = shardUrl(shard)
    const file = await remoteParquet(url)
    const meta = await parquetMetadataAsync(file)
    const shardRows = Number(meta.num_rows)

    // Resuming: a shard entirely below the high-water mark holds nothing new.
    // Skipping it here costs one HEAD and a metadata read rather than pulling
    // hundreds of megabytes over the network to discard every row.
    if (scanned + shardRows <= seenAtStart) {
      scanned += shardRows
      continue
    }

    console.log(`shard ${shard}: ${shardRows} rows (${(file.byteLength / 1e6).toFixed(0)}MB total)`)

    // Start exactly where the last run stopped rather than at row 0.
    let rowStart = Math.max(0, seenAtStart - scanned)
    scanned += shardRows

    while (rowStart < shardRows && total < limit) {
      const rowEnd = Math.min(rowStart + batchSize, shardRows)

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

      // Local only. Writing to disk is what makes a photo "pulled"; whether it
      // has reached the bucket is pass two's business and is tracked there.
      await pooled(pending, concurrency, async ({ meta, bytes }) => {
        await writeFile(`${IMAGES_DIR}/${meta.filename}`, bytes)
      })

      await write(pending.map((p) => p.meta))
      total += pending.length

      progress('decoding', total, Math.min(limit, TOTAL_ROWS), started)
    }
  }

  endProgress()
  await new Promise<void>((resolve) => out.end(resolve))
  console.log(`  decoded ${total} photos in ${formatDuration(Date.now() - started)}`)

  if (skipUpload) {
    console.log('\n--skip-upload set, stopping before the bucket')
    console.log(`  cache:    ${IMAGES_DIR}`)
    console.log(`  metadata: ${METADATA_FILE}`)
    return
  }

  await uploadPass(concurrency, uploadBatch)

  console.log(`\ndone in ${formatDuration(Date.now() - started)}: ${total} photos`)
  console.log(`  bucket:   ${process.env.S3_BUCKET}/flickr30k/`)
  console.log(`  cache:    ${IMAGES_DIR}`)
  console.log(`  metadata: ${METADATA_FILE}`)
  console.log('next: npm run dataset:embed')
}

/**
 * Pass two: push everything on disk that the bucket does not already have.
 *
 * Resume comes from the bucket itself rather than a local marker file, so this
 * stays correct however the previous run died, and re-running it costs one
 * listing instead of 31,014 redundant PUTs.
 *
 * Uploads go out in fixed batches. Every batch finishes before the next starts,
 * which keeps the number of open sockets bounded and gives an honest progress
 * line: a rate printed from a sliding window would report work that is still in
 * flight as though it had landed.
 */
async function uploadPass(concurrency: number, batchSize: number) {
  console.log(`\n[2/2] uploading to ${process.env.S3_BUCKET}/flickr30k/`)

  const onDisk = (await readFile(METADATA_FILE, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as PhotoMeta).filename)

  const inBucket = await listImages()
  const missing = onDisk.filter((f) => !inBucket.has(f))
  console.log(`  ${inBucket.size} already in the bucket, ${missing.length} to upload`)
  if (missing.length === 0) return

  const started = Date.now()
  let done = 0

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize)
    await pooled(batch, concurrency, async (filename) => {
      const bytes = await readFile(`${IMAGES_DIR}/${filename}`)
      const body = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as Uint8Array<ArrayBuffer>
      await withRetry(filename, () => putImage(filename, body))
    })
    done += batch.length
    progress('uploading', done, missing.length, started)
  }

  endProgress()
  console.log(`  ${done} uploaded in ${formatDuration(Date.now() - started)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
