import { SearchIsland } from '@/app/SearchIsland'
import { CorpusStats } from '@/components/CorpusStats'

/**
 * The static shell. A Server Component with no data fetching, so it renders
 * once at build time and nothing here can put a database round trip in front of
 * the first byte.
 *
 * Everything that is not an island is inert HTML: the wordmark, the heading,
 * the "Try ..." links and the footer. The two islands fetch their own data, and
 * Search reads the query out of the URL on mount, so deep links still work.
 */
const shell = 'mx-auto w-full max-w-6xl px-4 sm:px-8'
const note = 'my-4 rounded-sm border border-rule border-l-2 border-l-rule-strong p-4 text-sm text-ink-3'
const code = 'rounded-[3px] bg-paper-3 px-1.5 py-0.5 font-mono text-[0.85em] text-ink'
const link = 'text-accent-text underline decoration-1 underline-offset-2'

export default function Page() {
  return (
    <>
      {/* N9 · edge-aligned: wordmark hard-left, corpus readout hard-right */}
      <header className={`${shell} border-rule flex items-center justify-between gap-4 border-b py-4`}>
        <a href="/" className="font-display text-ink text-[0.9375rem] font-semibold tracking-[-0.02em] whitespace-nowrap no-underline">
          CLIP <span className="text-signal">×</span> Lakebase
        </a>
        <CorpusStats />
      </header>

      <main className={shell}>
        {/* Bottom-heavy padding pulls the header into the panel below it (gate 44) */}
        <div className="grid grid-cols-1 items-end gap-4 pt-6 pb-8 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:gap-8 md:pt-8 md:pb-12">
          <h1 className="text-display-s">Search 512 dimensions three ways.</h1>
          <p className="text-ink-3 max-w-[46ch]">
            Every photo and every caption is a CLIP vector in one <code className={code}>vector(512)</code> column. The same query runs against{' '}
            <code className={code}>lakebase_ann</code> for meaning and <code className={code}>lakebase_bm25</code> for words, so you can watch them disagree.
          </p>
        </div>

        <SearchIsland />

        <p className={note}>
          Try{' '}
          <a className={link} href="/?q=dogs+running+in+a+grassy+field">
            dogs running in a grassy field
          </a>
          ,{' '}
          <a className={link} href="/?q=man+in+a+red+shirt+on+a+bicycle">
            man in a red shirt on a bicycle
          </a>
          , or the same words in{' '}
          <a className={link} href="/?q=bicycle&mode=keyword">
            keyword mode
          </a>{' '}
          to see BM25 pick different photos. For near-duplicates, start from{' '}
          <a className={link} href="/?photo=1020651753&mode=radius&radius=0.15">
            this dog
          </a>
          .
        </p>
      </main>

      {/* Ft2 · inline single line */}
      <footer className={`${shell} border-rule flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-6 pb-12`}>
        <span className="meta">Flickr30k · CLIP ViT-B/32 · Neon Postgres 18</span>
        <span className="meta flex items-center gap-3">
          <a href="https://rishi.app" className="text-ink-2 hover:text-accent-text no-underline transition-colors duration-100 ease-out">
            made by Rishi
          </a>
          <a
            href="https://github.com/rishi-raj-jain/lakebase-search-clip-embeddings"
            rel="noopener"
            className="text-ink-3 hover:text-accent-text inline-flex transition-colors duration-100 ease-out"
          >
            <span className="sr-only">Source on GitHub</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </span>
      </footer>
    </>
  )
}
