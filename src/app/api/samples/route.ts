export const dynamic = 'force-dynamic'

import { httpDb } from '@/db/index'
import { samplePhotos } from '@/db/queries'
import { imageUrls } from '@/lib/storage'

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 60

/**
 * Photos to choose from in the image picker.
 *
 * Searching by image needs an image, and the two ways to get one are very
 * different in cost: an upload runs the CLIP vision tower, while picking a
 * photo already in the corpus resolves its stored vector inside the search
 * statement and never loads the model. This endpoint backs the cheap path.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const requested = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
  try {
    // Present but empty means "the user cleared the box", which is a real
    // filter state and must not silently fall back to the random sample.
    const match = url.searchParams.get('match') ?? ''
    const photos = await samplePhotos(httpDb(), { limit, match })
    const urls = await imageUrls(photos.map((p) => p.filename))
    const cards = photos.map((p, i) => ({ id: p.id, url: urls[i]!, caption: p.caption ?? '' }))
    return new Response(JSON.stringify({ cards }), {
      headers: {
        'content-type': 'application/json',
        // Presigned URLs inside expire in an hour, so this window stays well
        // under that. Private, because the URLs are scoped to this response.
        'cache-control': 'private, max-age=300',
      },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
}
