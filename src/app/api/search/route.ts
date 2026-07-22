/**
 * Runs on every request: it embeds with CLIP and queries Postgres, so there is
 * nothing here to cache or prerender.
 */
export const dynamic = 'force-dynamic'

import { DEFAULT_RADIUS } from '@/lakebase/modes'
import { InputError, isMode, runSearch, type Mode } from '@/lib/search'
import { MAX_UPLOAD_BYTES, tooLargeMessage } from '@/lib/upload'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const modeParam = params.get('mode')
  const mode: Mode = isMode(modeParam) ? modeParam : 'semantic'
  const q = params.get('q') ?? ''
  const photoId = params.get('photo') ?? ''
  const radiusParam = Number(params.get('radius'))
  const radius = Number.isFinite(radiusParam) && radiusParam > 0 ? radiusParam : DEFAULT_RADIUS
  if (!q.trim() && !photoId) return json({ cards: [], took: 0 })
  try {
    const outcome = await runSearch({ mode, q, photoId, radius })
    return json(outcome)
  } catch (err) {
    return failure(err)
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const file = form.get('image')
    if (!(file instanceof File) || file.size === 0) return json({ error: 'no image uploaded' }, 400)
    if (!file.type.startsWith('image/')) return json({ error: `${file.type || 'that file'} is not an image` }, 415)
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: tooLargeMessage(file.size) }, 413)
    const modeParam = form.get('mode')
    const requested: Mode = isMode(modeParam) ? modeParam : 'semantic'
    const mode: Mode = requested === 'keyword' ? 'semantic' : requested
    const radiusParam = Number(form.get('radius'))
    const radius = Number.isFinite(radiusParam) && radiusParam > 0 ? radiusParam : DEFAULT_RADIUS
    const outcome = await runSearch({ mode, file, radius })
    return json(outcome)
  } catch (err) {
    return failure(err)
  }
}

/**
 * A bad request is the caller's problem and says so with a 4xx; anything else
 * is ours and keeps its 500. Only an InputError's message is safe to hand back,
 * because it was written for a human. Everything else could be a driver or
 * filesystem internal, so it is logged and replaced.
 */
function failure(err: unknown) {
  if (err instanceof InputError) return json({ error: err.message }, err.status)
  console.error('[api/search]', err)
  return json({ error: 'Search failed. This one is on the server, not on you.' }, 500)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}
