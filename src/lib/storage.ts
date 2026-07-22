import { AwsClient } from 'aws4fetch'

/**
 * Neon Storage is S3-compatible, so all this needs is SigV4 over `fetch`.
 *
 * aws4fetch rather than the AWS SDK: the only S3 operations here are GET, PUT
 * and presigning, which are three signed HTTP requests. The SDK brings a
 * command/middleware stack and hundreds of kilobytes to express that, and it
 * gets loaded on every search because presigning result URLs is in the hot
 * path. This is ~7KB and speaks the same protocol.
 *
 * Two things differ from AWS proper: the endpoint, and that virtual-host style
 * (bucket.endpoint) is not served. Every URL below is path style, which is what
 * the SDK's `forcePathStyle: true` used to buy.
 */
const IMAGE_PREFIX = 'flickr30k'

let cached: AwsClient | null = null

function client(): AwsClient {
  cached ??= new AwsClient({
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
    // Both are guesses from the hostname otherwise, and a Neon Storage endpoint
    // is not a hostname aws4fetch can guess from. State them.
    service: 's3',
    region: process.env.AWS_REGION ?? 'us-east-2',
  })
  return cached
}

export function bucket(): string {
  return process.env.S3_BUCKET ?? 'storage-test'
}

const objectKey = (filename: string) => `${IMAGE_PREFIX}/${filename}`

const bucketUrl = () => `${requireEnv('AWS_ENDPOINT_URL_S3').replace(/\/+$/, '')}/${bucket()}`

/** Path style: `<endpoint>/<bucket>/<key>`. */
function objectUrl(filename: string): string {
  return `${bucketUrl()}/${objectKey(filename)}`
}

/**
 * Every image filename already in the bucket.
 *
 * The loader uses this to work out what it still has to upload. Paginated,
 * because ListObjectsV2 caps a response at 1,000 keys and the full corpus is
 * 31,014, so a single unpaged call would silently report a fraction of what is
 * there and re-upload the rest.
 */
export async function listImages(): Promise<Set<string>> {
  const names = new Set<string>()
  const prefix = `${IMAGE_PREFIX}/`
  let token: string | undefined

  do {
    const url = new URL(bucketUrl())
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    url.searchParams.set('max-keys', '1000')
    if (token) url.searchParams.set('continuation-token', token)

    const res = await client().fetch(url.toString())
    if (!res.ok) throw new Error(`list ${prefix} failed: ${res.status} ${await res.text()}`)
    const xml = await res.text()

    for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length))
    }
    // Absent on the last page, which is what ends the loop.
    token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
  } while (token)

  return names
}

/**
 * `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, whose buffer type
 * widens to `ArrayBufferLike` and so admits `SharedArrayBuffer`. A shared
 * buffer is not a valid `BodyInit`, and this is the honest way to say so.
 */
export async function putImage(filename: string, body: Uint8Array<ArrayBuffer>) {
  const res = await client().fetch(objectUrl(filename), {
    method: 'PUT',
    body,
    headers: { 'content-type': 'image/jpeg' },
  })
  if (!res.ok) {
    throw new Error(`PUT ${objectKey(filename)} failed: ${res.status} ${await res.text()}`)
  }
}

export async function getImageBytes(filename: string): Promise<Uint8Array> {
  const res = await client().fetch(objectUrl(filename))
  if (!res.ok) {
    throw new Error(`GET ${objectKey(filename)} failed: ${res.status}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * The bucket is private, so the browser cannot hit object URLs directly.
 * Presigning is local HMAC with no round trip to storage, so signing a grid of
 * 24 results costs nothing measurable, and the bytes then travel
 * storage→browser without passing back through the Astro server.
 *
 * `signQuery` puts the signature in the query string instead of an
 * Authorization header, which is what makes the result pasteable into an
 * `<img src>`.
 */
export async function imageUrl(filename: string, expiresIn = 3600): Promise<string> {
  const url = new URL(objectUrl(filename))
  // Set explicitly: aws4fetch defaults S3 presigns to 86400, which is far
  // longer than these URLs should live.
  url.searchParams.set('X-Amz-Expires', String(expiresIn))
  const signed = await client().sign(url.toString(), { method: 'GET', aws: { signQuery: true } })
  return signed.url
}

export async function imageUrls(filenames: string[], expiresIn = 3600): Promise<string[]> {
  return Promise.all(filenames.map((f) => imageUrl(f, expiresIn)))
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.`)
  return value
}
