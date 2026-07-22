import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor,
} from '@huggingface/transformers'

export const MODEL_ID = 'Xenova/clip-vit-base-patch32'
export const CLIP_DIMS = 512

// transformers.js caches weights inside node_modules by default, which is
// read-only on a serverless filesystem. /tmp is the only writable path there,
// and it survives for the life of a warm instance, so the download happens
// once per cold start, not once per request.
if (process.env.VERCEL) {
  env.cacheDir = '/tmp/transformers-cache'
}

/**
 * CLIP is two encoders trained to land in one space: a ViT for images and a
 * transformer for text. `...WithProjection` gives you the projected 512-d
 * output (the layer the contrastive loss actually operated on) rather than
 * the pooled hidden state, which is *not* comparable across towers.
 *
 * Both towers are loaded lazily and kept as singletons: the ~600MB of weights
 * downloads once into the transformers.js cache and stays in memory for the
 * life of the process.
 */
let textTower: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null = null
let visionTower: Promise<{ processor: Processor; model: PreTrainedModel }> | null = null

function loadTextTower() {
  textTower ??= (async () => ({
    tokenizer: await AutoTokenizer.from_pretrained(MODEL_ID),
    model: await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' }),
  }))()
  return textTower
}

function loadVisionTower() {
  visionTower ??= (async () => ({
    processor: await AutoProcessor.from_pretrained(MODEL_ID),
    model: await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: 'fp32' }),
  }))()
  return visionTower
}

/**
 * CLIP's projection heads are not constrained to produce unit vectors; raw
 * norms here run around 8-12 and vary with image content. `vector_cosine_ops`
 * divides by the norms itself so *ranking* survives either way, but the
 * distances you read back only mean something if the inputs are normalised,
 * and any inner-product index would rank by magnitude instead of by angle.
 * Normalising once at write time makes both correct and lets you swap
 * cosine for ip without touching the data.
 */
function normalise(v: ArrayLike<number>): number[] {
  let sumSquares = 0
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!
  const norm = Math.sqrt(sumSquares)
  if (norm === 0) throw new Error('cannot normalise a zero vector')
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
  return out
}

/** Embed text with the text tower. Handles a batch in one forward pass. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const { tokenizer, model } = await loadTextTower()
  // CLIP's context window is 77 tokens; Flickr captions fit, but truncate so a
  // long user query fails soft instead of throwing.
  const inputs = tokenizer(texts, { padding: true, truncation: true })
  const { text_embeds } = await model(inputs)
  return unbatch(text_embeds, texts.length)
}

export async function embedText(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0]!
}

export type ImageInput = string | Blob | RawImage

async function toRawImage(input: ImageInput): Promise<RawImage> {
  if (input instanceof RawImage) return input
  if (typeof input === 'string') return RawImage.read(input)
  return RawImage.fromBlob(input)
}

/**
 * Embed images with the vision tower. Returns the embedding alongside the
 * source dimensions, which the loader stores so the UI can lay out a grid
 * without re-reading every file.
 */
export async function embedImages(inputs: ImageInput[]): Promise<{ embedding: number[]; width: number; height: number }[]> {
  if (inputs.length === 0) return []
  const { processor, model } = await loadVisionTower()
  const images = await Promise.all(inputs.map(toRawImage))
  const pixels = await processor(images)
  const { image_embeds } = await model(pixels)
  const embeddings = unbatch(image_embeds, images.length)
  return embeddings.map((embedding, i) => ({
    embedding,
    width: images[i]!.width,
    height: images[i]!.height,
  }))
}

export async function embedImage(input: ImageInput) {
  return (await embedImages([input]))[0]!
}

/** Split a [batch, 512] tensor into normalised rows. */
function unbatch(tensor: { data: ArrayLike<number> }, batchSize: number): number[][] {
  const flat = tensor.data
  const dims = flat.length / batchSize
  if (dims !== CLIP_DIMS) {
    throw new Error(`expected ${CLIP_DIMS}-d embeddings, model returned ${dims}`)
  }
  const rows: number[][] = []
  for (let i = 0; i < batchSize; i++) {
    rows.push(normalise(Array.prototype.slice.call(flat, i * dims, (i + 1) * dims)))
  }
  return rows
}

export { RawImage }
