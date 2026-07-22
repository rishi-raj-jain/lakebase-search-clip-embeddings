export const dynamic = 'force-dynamic'

import { httpDb } from '@/db/index'
import { corpusStats } from '@/db/queries'

export async function GET() {
  try {
    const stats = await corpusStats(httpDb())
    return new Response(JSON.stringify(stats), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400',
      },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
}
