'use client'

import { MAX_UPLOAD_BYTES, tooLargeMessage } from '@/lib/upload'
import { useEffect, useRef, useState } from 'react'

type SampleCard = { id: string; url: string; caption: string }

const GRID = 'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(140px,100%),1fr))] gap-3 p-0'

/**
 * Search-by-image picker.
 *
 * Two ways in, and they are very different in cost. An upload runs the CLIP
 * vision tower; picking a photo already in the corpus resolves its stored
 * vector inside the search statement and never loads the model. The corpus path
 * is also the only one that survives in a URL, which is why it gets the larger
 * half of the dialog.
 *
 * Native <dialog>, so focus trapping, Esc to close, inertness of the page
 * behind it and the top layer are the browser's job rather than ours.
 */
export function Picker({ open, onClose, onPickPhoto, onUpload }: { open: boolean; onClose: () => void; onPickPhoto: (id: string) => void; onUpload: (file: File) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [match, setMatch] = useState('')
  const [cards, setCards] = useState<SampleCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Kept apart from `error`, which belongs to the catalogue below: a rejected
  // upload has to appear next to the thing that rejected it.
  const [uploadError, setUploadError] = useState<string | null>(null)

  // showModal() is imperative; mirror the prop onto it.
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  /**
   * Fetched on open rather than at load: the picker is optional, and its
   * presigned URLs would start expiring the moment we pulled them. Typing
   * refilters server-side, because 2,000 photos is more than belongs in the
   * page, debounced and aborting so a fast typist cannot land stale results.
   */
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setError(null)
      try {
        const res = await fetch(`/api/samples?match=${encodeURIComponent(match)}`, { signal: controller.signal })
        const data = (await res.json()) as { cards?: SampleCard[]; error?: string }
        if (controller.signal.aborted) return
        if (!res.ok || data.error || !data.cards) throw new Error(data.error ?? `samples failed with ${res.status}`)
        if (data.cards.length === 0) {
          setCards([])
          setError(`No photo id contains "${match}".`)
        } else {
          setCards(data.cards)
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        // Retryable: the upload half of the dialog works regardless.
        setError(err instanceof Error ? err.message : String(err))
      }
    }, 100)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [open, match])

  return (
    <dialog
      ref={ref}
      aria-labelledby="picker-title"
      onClose={onClose}
      // Clicking the backdrop closes. The dialog's box is its only child, so a
      // click landing on the dialog element itself was outside it.
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
      className="border-rule bg-paper text-ink-2 backdrop:bg-graphite/55 m-auto max-h-[min(44rem,calc(100dvh-4rem))] w-[min(46rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border p-0 open:flex"
    >
      <div className="border-rule flex items-center justify-between gap-4 border-b px-4 py-3">
        <h2 id="picker-title" className="text-ink m-0 text-base font-medium">
          Search by image
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="text-ink-3 hover:bg-paper-3 hover:text-ink focus-visible:outline-accent -mr-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-sm border border-transparent transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {/* Upload. The bytes are embedded and thrown away, never stored. */}
        <label className="border-rule-strong hover:border-accent hover:bg-accent-wash has-focus-visible:outline-accent flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-center transition-colors duration-100 ease-out has-focus-visible:outline-2 has-focus-visible:outline-offset-2">
          <span className="text-ink text-sm font-medium">Upload an image</span>
          <span className="meta text-ink-4">embedded in the browser request · not stored</span>
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              const input = event.currentTarget as HTMLInputElement
              const file = input.files?.[0]
              // Clear it, or picking the same file again is not a change and
              // the browser fires nothing. Upload a photo, search for something
              // else, then upload that photo again: without this, dead button.
              input.value = ''
              if (!file) return
              // Checked here so the answer is immediate. Sending it would mean
              // waiting out the whole upload for a rejection that was certain
              // from the moment the file was chosen.
              if (file.size > MAX_UPLOAD_BYTES) {
                setUploadError(tooLargeMessage(file.size))
                return
              }
              setUploadError(null)
              onUpload(file)
            }}
          />
        </label>

        {uploadError && <p className="text-danger-ink border-l-danger border-rule mt-3 rounded-sm border border-l-2 p-3 text-sm">{uploadError}</p>}

        {/* Every result card shows its Flickr id, so an id is the one handle on
            a corpus photo a user already has. */}
        <div className="border-rule mt-5 border-t pt-5">
          <label className="meta text-ink-3 mb-2 block" htmlFor="photo-id">
            or search by photo id
          </label>
          <p className="text-ink-3 mb-2 text-sm">Type any part of an id to narrow the catalogue below, or enter one in full and hit Search.</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="photo-id"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="1020651753"
              value={match}
              onInput={(event) => setMatch((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (match.trim()) onPickPhoto(match.trim())
              }}
              className="border-rule-strong bg-paper text-ink placeholder:text-ink-4 hover:border-ink-4 focus-visible:border-accent h-10 min-w-0 flex-auto rounded-sm border px-3 font-mono text-sm transition-colors duration-100 ease-out outline-none"
            />
            <button
              type="button"
              onClick={() => match.trim() && onPickPhoto(match.trim())}
              className="border-rule-strong bg-paper text-ink-2 hover:border-ink-4 hover:text-ink focus-visible:outline-accent inline-flex h-10 cursor-pointer items-center rounded-sm border px-4 text-sm leading-none whitespace-nowrap transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Search
            </button>
          </div>
        </div>

        <div className="border-rule my-5 flex items-center gap-3 border-t">
          <span className="meta bg-paper text-ink-4 -mt-2 pr-2">or pick one from the corpus</span>
        </div>

        {error && <p className="text-danger-ink border-l-danger border-rule my-2 rounded-sm border border-l-2 p-3 text-sm">{error}</p>}

        {cards === null ? (
          <ul className={GRID} aria-hidden="true">
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i} className="shimmer aspect-[4/3] rounded-sm" />
            ))}
          </ul>
        ) : (
          <ul className={GRID}>
            {cards.map((card) => (
              <li key={card.id} className="min-w-0">
                <button
                  type="button"
                  title={card.caption}
                  // The caption is the only description a screen reader gets.
                  aria-label={`Search by this photo: ${card.caption || card.id}`}
                  onClick={() => onPickPhoto(card.id)}
                  className="border-rule hover:border-accent focus-visible:outline-accent block w-full cursor-pointer overflow-hidden rounded-sm border p-0 transition-colors duration-100 ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <img src={card.url} alt="" loading="lazy" decoding="async" className="block aspect-[4/3] w-full object-cover" />
                  <span className="bg-paper-2 text-ink-4 block truncate px-2 py-1 text-left font-mono text-xs">{card.id}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
