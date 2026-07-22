'use client'

import { Picker } from '@/components/Picker'
import { Results, Skeleton } from '@/components/Results'
import { SqlPanel } from '@/components/SqlPanel'
import { UploadPreview } from '@/components/UploadPreview'
import { useSearch } from '@/components/useSearch'
import { DEFAULT_QUERY, MODE_AM, MODE_HINTS, MODE_LABELS, MODE_SQL, MODES } from '@/lakebase/modes'
import { useState } from 'react'

const NOTE = 'my-4 rounded-sm border border-rule border-l-2 border-l-rule-strong p-4 text-sm text-ink-3'

/**
 * The interactive half of the page: the form, the results and the picker.
 *
 * The rest of app/page.tsx is a Server Component that never rehydrates. This is
 * one island rather than three because the form drives the results, and
 * splitting them would mean inventing a cross-island channel to carry state
 * that a single component holds for free.
 */
export function Search() {
  const { query, outcome, busy, error, serverFault, keywordWithPhoto, hasQuery, update, usePhoto } = useSearch()
  const [pickerOpen, setPickerOpen] = useState(false)

  /**
   * Radius mode has two very different empty states. A text query can *never*
   * match: CLIP text vectors sit ~0.66 from the nearest image at best, so no
   * radius in the slider's range reaches one. A photo returning nothing is the
   * honest answer for most photos, and the fix is to widen the slider.
   */
  function emptyMessage(): string {
    if (query.mode !== 'radius') {
      return 'Nothing matched. Try a broader phrase, or a mode that searches meaning rather than words.'
    }
    if (!query.photoId && !query.file) {
      return (
        'Near-duplicates measures distance between images, and a text query is never close to one: ' +
        'the nearest photo to any phrase sits around 0.66 cosine away, past the end of this slider. ' +
        'Pick a photo with "more like this" first, or upload one.'
      )
    }
    return (
      `No photo sits within ${query.radius.toFixed(2)} cosine of this one, which is the honest answer for most photos. ` +
      'Nearest-neighbour distance over this corpus is ~0.14 at the 5th percentile and ~0.25 at the median, ' +
      'so widen the slider to reach the similar band.'
    )
  }

  return (
    <>
      <form role="search" onSubmit={(event) => event.preventDefault()} className="border-rule bg-paper-2 rounded-md border" aria-busy={busy}>
        <div className="border-rule flex flex-wrap items-center gap-2 border-b p-3">
          <label className="sr-only" htmlFor="q">
            Search query
          </label>
          {/* Border-width never changes between states, only its colour (gate 39) */}
          <input
            id="q"
            name="q"
            type="search"
            value={query.q}
            placeholder={DEFAULT_QUERY}
            autoComplete="off"
            autoFocus
            // Typing replaces any image or photo query.
            onInput={(event) => update({ q: (event.currentTarget as HTMLInputElement).value, photoId: '', file: null }, { debounce: true })}
            className="border-rule-strong bg-paper text-ink placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-accent h-11 min-w-0 flex-auto rounded-sm border px-4 transition-colors duration-100 ease-out outline-none"
          />
          {/* Opens the picker rather than the file dialog directly: an upload is
              one of two ways to search by image, and the other one is both
              cheaper and the only one that can be put in a shareable URL. */}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="border-rule-strong bg-paper text-ink-2 hover:border-ink-4 hover:text-ink focus-visible:outline-accent inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-sm border px-4 leading-none whitespace-nowrap transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M14.5 2h-13A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 14.5 2Zm.5 10.5a.5.5 0 0 1-.5.5H10l-2.6-3.47a.5.5 0 0 0-.79-.01L5 11.5 3.9 10.2a.5.5 0 0 0-.78.02L1 13v-9.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v9.5ZM5.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
            </svg>
            <span className="text-sm">Image</span>
          </button>
          <button
            type="submit"
            className="border-accent bg-accent text-accent-ink hover:border-accent-hover hover:bg-accent-hover inline-flex h-11 items-center justify-center rounded-sm border px-6 leading-none font-medium whitespace-nowrap transition-colors duration-100 ease-out active:translate-y-px"
          >
            Search
          </button>
        </div>

        {query.file && <UploadPreview file={query.file} />}

        <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-3">
          <legend className="sr-only">Retrieval mode</legend>
          {MODES.map((m) => (
            <label
              key={m}
              className="text-ink-3 hover:bg-paper-3 hover:text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-wash has-[:checked]:text-ink has-focus-visible:outline-accent inline-flex cursor-pointer items-baseline gap-2 rounded-sm border border-transparent px-2 py-1 text-sm transition-colors duration-100 ease-out has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-[:checked]:font-medium"
            >
              <input type="radio" name="mode" value={m} checked={m === query.mode} onChange={() => update({ mode: m })} className="mode-radio" />
              <span>{MODE_LABELS[m]}</span>
              <span className="no-liga text-ink-4 font-mono text-xs">{MODE_AM[m]}</span>
            </label>
          ))}
        </fieldset>

        {query.mode === 'radius' && (
          <div className="border-rule flex flex-wrap items-center gap-3 border-t px-3 py-3">
            <label className="meta" htmlFor="radius">
              cosine radius
            </label>
            <input
              id="radius"
              name="radius"
              type="range"
              min="0.05"
              max="0.6"
              step="0.01"
              value={String(query.radius)}
              onInput={(event) => update({ radius: Number((event.currentTarget as HTMLInputElement).value) }, { debounce: true })}
              className="accent-accent h-11 min-w-0 flex-auto"
            />
            <output className="text-accent-text font-mono text-sm tabular-nums" htmlFor="radius">
              {query.radius.toFixed(2)}
            </output>
            {/* The slider is a distance, so bigger means looser, the opposite of
                what a "more results" control usually implies. */}
            <p className="text-ink-3 basis-full text-sm">
              Higher is looser: it widens the distance a photo may sit from this one, so more but less alike. ~0.15 is near-identical, ~0.25 merely similar, above ~0.30 everything
              matches.
            </p>
          </div>
        )}

        <p className="text-ink-3 px-3 pb-3 text-sm">{MODE_HINTS[query.mode]}</p>
      </form>

      <Picker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPickPhoto={(id) => {
          setPickerOpen(false)
          usePhoto(id)
        }}
        onUpload={(file) => {
          setPickerOpen(false)
          update({ file, q: '', photoId: '' })
        }}
      />

      {error && (
        <p className={`${NOTE} border-l-danger text-danger-ink`}>
          <strong>Query failed.</strong> {error}
          {serverFault && (
            <>
              <br />
              If the indexes are missing, run <code className="bg-paper-3 text-ink rounded-[3px] px-1.5 py-0.5 font-mono text-[0.85em]">npm run db:index</code>. If the tables are
              empty, run <code className="bg-paper-3 text-ink rounded-[3px] px-1.5 py-0.5 font-mono text-[0.85em]">npm run setup</code>.
            </>
          )}
        </p>
      )}

      {keywordWithPhoto && <p className={NOTE}>Keyword mode ranks caption lexemes, so it has nothing to match an image against. Type a query, or switch to a vector mode.</p>}

      {busy && <Skeleton />}

      {!busy && !error && outcome && outcome.cards.length > 0 && <Results mode={query.mode} outcome={outcome} onSimilar={usePhoto} />}

      {!busy && !error && outcome && outcome.cards.length === 0 && <p className={NOTE}>{emptyMessage()}</p>}

      {/* Nothing asked for: show the SQL the current mode would run. */}
      {!busy && !error && !hasQuery && !keywordWithPhoto && <SqlPanel sql={MODE_SQL[query.mode]} am={MODE_AM[query.mode]} took={null} />}
    </>
  )
}
