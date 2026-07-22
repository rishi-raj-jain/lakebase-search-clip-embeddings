'use client'

import { useEffect, useState } from 'react'

/**
 * Corpus counts for the header.
 *
 * Its own island rather than part of Search, because it sits in the <header>
 * outside <main> and shares no state with the search. Hidden until it resolves
 * rather than rendering zeroes, so the bar never shows a wrong number.
 */
export function CorpusStats() {
  const [stats, setStats] = useState<{ photos: number; captions: number } | null>(null)

  useEffect(() => {
    // A missing readout is not worth surfacing an error over.
    fetch('/api/stats')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setStats(data))
      .catch(() => {})
  }, [])

  if (!stats) return null

  return (
    // The caption count is the first thing to go when the bar gets tight;
    // without this the readout is clipped by overflow-x:clip at 375px.
    <span className="meta flex min-w-0 flex-wrap justify-end gap-x-2">
      <span className="whitespace-nowrap">{stats.photos.toLocaleString()} photos</span>
      <span className="hidden whitespace-nowrap sm:inline">· {stats.captions.toLocaleString()} captions</span>
    </span>
  )
}
