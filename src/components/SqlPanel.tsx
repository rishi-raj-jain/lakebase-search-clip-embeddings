'use client'

import { highlightSql } from '@/lib/sql-highlight'

/**
 * Cobalt's one dark band: the SQL that produced the results on screen.
 *
 * It follows the mode, not the results, so switching mode relabels it even
 * before the new rows land.
 */
export function SqlPanel({ sql, am, took }: { sql: string; am: string; took: number | null }) {
  return (
    <figure className="bg-graphite my-4 overflow-hidden rounded-md">
      <figcaption className="border-graphite-2 text-on-graphite-dim flex items-center justify-between gap-4 border-b px-4 py-2 font-mono text-xs tracking-[0.06em] uppercase">
        <span>{am}</span>
        {took !== null && <span className="border-signal text-signal rounded-full border px-2 whitespace-nowrap">{took} ms</span>}
      </figcaption>
      {/* Wide SQL scrolls inside its own box; the page never scrolls sideways. */}
      <pre className="sql-code text-on-graphite overflow-x-auto p-4 font-mono text-[0.8125rem]/[1.7]">
        <code dangerouslySetInnerHTML={{ __html: highlightSql(sql) }} />
      </pre>
    </figure>
  )
}
