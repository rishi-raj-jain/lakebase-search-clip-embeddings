/**
 * Embed every pulled photo and every caption with CLIP ViT-B/32.
 *
 * Both towers project into the same 512-d space, so one `vector(512)` column
 * holds image vectors and caption vectors alike and a text query can be
 * compared against a photo directly. Everything is L2-normalised on the way
 * out; see the note in src/lib/clip.ts.
 *
 * Runs on CPU with no Python. Resumable: re-running skips any photo already in
 * data/embeddings.jsonl.
 *
 *   npx tsx scripts/embed.ts --batch 32
 */
import { embedImages, embedTexts, MODEL_ID, type ImageInput } from '@/lib/clip'
import { getImageBytes } from '@/lib/storage'
import { batched, EMBEDDINGS_FILE, fileExists, formatDuration, IMAGES_DIR, METADATA_FILE, parseArgs, readJsonl, roundVector } from '@scripts/lib/util'
import type { PhotoMeta } from '@scripts/pull-dataset'
import { createWriteStream } from 'node:fs'

export type PhotoEmbedding = {
  id: string
  filename: string
  split: string
  width: number
  height: number
  embedding: number[]
  captions: { idx: number; body: string; embedding: number[] }[]
}

async function main() {
  const args = parseArgs()
  const batchSize = Number(args.batch ?? 32)

  if (!(await fileExists(METADATA_FILE))) {
    throw new Error(`${METADATA_FILE} not found, run: npm run dataset:pull`)
  }

  // Resume by id.
  const done = new Set<string>()
  for await (const row of readJsonl<{ id: string }>(EMBEDDINGS_FILE)) done.add(row.id)
  if (done.size) console.log(`resuming, ${done.size} photos already embedded`)

  const pending = (async function* () {
    for await (const meta of readJsonl<PhotoMeta>(METADATA_FILE)) {
      if (!done.has(meta.id)) yield meta
    }
  })()

  console.log(`loading ${MODEL_ID} (first run downloads ~600MB)...`)
  const out = createWriteStream(EMBEDDINGS_FILE, { flags: 'a' })
  const started = Date.now()
  let count = 0

  for await (const batch of batched(pending, batchSize)) {
    // Prefer the local cache the pull step left behind; fall back to the bucket
    // so this still runs on a machine that only ever had the metadata.
    const sources = await Promise.all(batch.map((m) => resolveImage(m.filename)))

    // Vision tower: one forward pass for the whole batch.
    const images = await embedImages(sources)

    // Text tower: all five captions of every photo in the batch, flattened into
    // one pass, then sliced back apart.
    const flatCaptions = batch.flatMap((m) => m.captions)
    const captionVectors = await embedTexts(flatCaptions)

    let cursor = 0
    const lines: string[] = []
    for (let i = 0; i < batch.length; i++) {
      const meta = batch[i]!
      const image = images[i]!
      const captions = meta.captions.map((body, idx) => ({
        idx,
        body,
        embedding: roundVector(captionVectors[cursor++]!),
      }))
      const record: PhotoEmbedding = {
        id: meta.id,
        filename: meta.filename,
        split: meta.split,
        width: image.width,
        height: image.height,
        embedding: roundVector(image.embedding),
        captions,
      }
      lines.push(JSON.stringify(record))
    }

    await new Promise<void>((resolve, reject) => out.write(lines.join('\n') + '\n', (err) => (err ? reject(err) : resolve())))

    count += batch.length
    const elapsed = Date.now() - started
    const rate = count / (elapsed / 1000)
    console.log(`  embedded ${count + done.size} photos ` + `(${rate.toFixed(1)}/s, ${formatDuration(elapsed)} elapsed)`)
  }

  await new Promise<void>((resolve) => out.end(resolve))
  console.log(`\ndone in ${formatDuration(Date.now() - started)} -> ${EMBEDDINGS_FILE}`)
  console.log('next: npm run db:migrate && npm run dataset:load')
}

async function resolveImage(filename: string): Promise<ImageInput> {
  const local = `${IMAGES_DIR}/${filename}`
  if (await fileExists(local)) return local
  const bytes = await getImageBytes(filename)
  return new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
