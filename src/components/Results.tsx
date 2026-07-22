'use client'

import { SqlPanel } from '@/components/SqlPanel'
import { MODE_AM, MODE_SQL, type Mode } from '@/lakebase/modes'
import type { ResultCard, SearchOutcome } from '@/lib/search'

const CARD_IMG = 'block h-full w-full object-cover'

function Card({ card, onSimilar }: { card: ResultCard; onSimilar: (id: string) => void }) {
  return (
    <li className="border-rule bg-paper-2 hover:border-accent flex min-w-0 flex-col overflow-hidden rounded-md border transition-colors duration-100 ease-out">
      <div className="bg-paper-3 relative aspect-[4/3] overflow-hidden">
        <img src={card.url} alt={card.caption} loading="lazy" decoding="async" className={CARD_IMG} />
        <span className="bg-graphite text-on-graphite absolute top-2 right-2 rounded-sm px-2 py-0.5 font-mono text-xs">{card.scoreLabel}</span>
      </div>
      <div className="text-ink-2 flex flex-1 flex-col gap-2 p-3 text-sm">
        <span className="text-ink-4 font-mono text-xs">{card.id}</span>
        <span>{card.caption}</span>
        {/* A real href, so it can be opened in a new tab, but handled in place. */}
        <a
          href={`/?mode=semantic&photo=${card.id}`}
          onClick={(event) => {
            event.preventDefault()
            onSimilar(card.id)
          }}
          className="text-accent-text hover:border-accent active:text-accent-hover mt-auto self-start border-b border-transparent font-mono text-xs whitespace-nowrap no-underline transition-colors duration-100 ease-out"
        >
          more like this →
        </a>
      </div>
    </li>
  )
}

/** Shown while a query is in flight, including the one fired on load. */
export function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="flex flex-wrap gap-4 pt-6 pb-4">
        {[64, 80].map((w) => (
          <span key={w} className="shimmer h-3 rounded-sm" style={{ width: `${w}px` }} />
        ))}
      </div>
      <div className="shimmer my-4 h-32 rounded-md" />
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-4 p-0 pb-12">
        {Array.from({ length: 12 }, (_, i) => (
          <li key={i} className="border-rule bg-paper-2 flex min-w-0 flex-col overflow-hidden rounded-md border">
            <div className="shimmer aspect-[4/3]" />
            <div className="flex flex-col gap-2 p-3">
              <span className="shimmer h-2.5 w-16 rounded-sm" />
              <span className="shimmer h-2.5 w-full rounded-sm" />
              <span className="shimmer h-2.5 w-3/5 rounded-sm" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Results({ mode, outcome, onSimilar }: { mode: Mode; outcome: SearchOutcome; onSimilar: (id: string) => void }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-6 pb-4">
        <span className="meta">{outcome.cards.length} results</span>
        <span className="meta">
          query <strong className="text-accent-text font-medium">{outcome.timings.queryMs}</strong> ms
        </span>
      </div>

      {outcome.queryImage && (
        <div className="border-accent bg-accent-wash my-4 flex items-center gap-4 rounded-md border p-3">
          <img src={outcome.queryImage.url} alt="" width="84" height="64" className="h-16 w-21 rounded-sm object-cover" />
          <span className="meta">query image · {outcome.queryImage.id}</span>
        </div>
      )}

      <SqlPanel sql={MODE_SQL[mode]} am={MODE_AM[mode]} took={outcome.timings.queryMs} />

      {/* minmax(0, …) so image tracks can shrink below intrinsic width (gate 50) */}
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-4 p-0 pb-12">
        {outcome.cards.map((card) => (
          <Card key={card.key} card={card} onSimilar={onSimilar} />
        ))}
      </ul>
    </div>
  )
}
