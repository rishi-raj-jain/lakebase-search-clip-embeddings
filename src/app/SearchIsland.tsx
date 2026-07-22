'use client'

import dynamic from 'next/dynamic'

/**
 * Search, rendered only in the browser.
 *
 * Its entire initial state is read from `location`, which does not exist on the
 * server, so a server render would produce markup that never matches the first
 * client render: `?mode=radius` draws the slider row on the client and not on
 * the server. Prerendering it to throw it away and warn about the mismatch
 * buys nothing, so `ssr: false` skips it. The shell around it is still fully
 * server-rendered, and the component paints a skeleton on mount.
 */
const Search = dynamic(() => import('@/components/Search').then((m) => m.Search), { ssr: false })

export function SearchIsland() {
  return <Search />
}
