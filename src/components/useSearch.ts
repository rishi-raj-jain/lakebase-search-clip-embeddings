'use client'

import { DEFAULT_QUERY, isMode, parseRadius, type Mode } from '@/lakebase/modes'
import type { SearchOutcome } from '@/lib/search'
import { useCallback, useEffect, useRef, useState } from 'react'

const DEBOUNCE_MS = 100

/**
 * The whole search cycle: query state, the URL it round-trips through, and the
 * fetch.
 *
 * The page ships as a static shell carrying no query state, so the URL is the
 * only place first-load state can come from. Everything below follows from
 * that: hydrate once on mount, then keep the address bar in step.
 */
export type Query = {
  q: string
  photoId: string
  mode: Mode
  radius: number
  /** An uploaded image is the query; it cannot live in the URL. */
  file: File | null
}

const EMPTY_QUERY: Query = { q: '', photoId: '', mode: 'semantic', radius: parseRadius(null), file: null }

/**
 * Read the query the page was opened with.
 *
 * Astro prerenders this island to static HTML before shipping it, and there is
 * no `location` on the server. The prerendered markup is thrown away on
 * hydration anyway, so the server just gets a neutral state and the real read
 * happens in the browser.
 */
function fromUrl(): Query {
  if (typeof location === 'undefined') return EMPTY_QUERY
  const url = new URLSearchParams(location.search)
  const q = url.get('q')?.trim() ?? ''
  const photoId = url.get('photo') ?? ''
  const m = url.get('mode')
  return {
    // Land on a worked example rather than an empty grid. It goes into the box
    // itself, not just the placeholder, so it is visible and editable.
    q: q || (photoId ? '' : DEFAULT_QUERY),
    photoId,
    mode: isMode(m) ? m : 'semantic',
    radius: parseRadius(url.get('radius')),
    file: null,
  }
}

function toParams(query: Query): URLSearchParams {
  const p = new URLSearchParams()
  if (query.q.trim()) p.set('q', query.q.trim())
  if (query.photoId) p.set('photo', query.photoId)
  p.set('mode', query.mode)
  if (query.mode === 'radius') p.set('radius', String(query.radius))
  return p
}

export type SearchState = {
  query: Query
  outcome: SearchOutcome | null
  busy: boolean
  error: string | null
  /** Keyword mode ranks lexemes, so it has nothing to match a photo against. */
  keywordWithPhoto: boolean
}

/**
 * Not every response is ours.
 *
 * A body larger than the platform's request cap never reaches the function:
 * Vercel answers "Request Entity Too Large" as plain text, and calling
 * `res.json()` on that throws a SyntaxError whose message ("Unexpected token
 * 'R'") is what the user ends up reading. Anything that is not JSON is treated
 * as "no body" and described from the status code instead.
 */
async function readJson(res: Response): Promise<(SearchOutcome & { error?: string }) | null> {
  try {
    return (await res.json()) as SearchOutcome & { error?: string }
  } catch {
    return null
  }
}

function describeStatus(status: number): string {
  if (status === 413) return 'That image is too large to upload. Try a smaller one.'
  if (status === 404) return 'Not found.'
  if (status >= 500) return 'Search failed. This one is on the server, not on you.'
  return `Search failed with ${status}.`
}

export function useSearch() {
  const [query, setQuery] = useState<Query>(fromUrl)
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null)
  const [busy, setBusy] = useState(true)
  // `serverFault` separates "you asked for something impossible" from "we
  // broke": only the latter deserves the run-the-setup-scripts advice.
  const [error, setError] = useState<string | null>(null)
  const [serverFault, setServerFault] = useState(false)

  const inFlight = useRef<AbortController | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Typing should debounce; clicking a mode or a photo should not.
  const immediate = useRef(true)

  const hasQuery = Boolean(query.q.trim() || query.photoId || query.file)
  const keywordWithPhoto = query.mode === 'keyword' && !query.q.trim() && Boolean(query.photoId || query.file)

  const run = useCallback(async (current: Query) => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setBusy(true)
    setError(null)
    setServerFault(false)

    try {
      const params = toParams(current)
      let res: Response
      if (current.file) {
        const body = new FormData()
        body.set('image', current.file)
        body.set('mode', current.mode)
        if (current.mode === 'radius') body.set('radius', String(current.radius))
        res = await fetch('/api/search', { method: 'POST', body, signal: controller.signal })
      } else {
        res = await fetch(`/api/search?${params}`, { signal: controller.signal })
      }

      const data = await readJson(res)
      // A newer request landed first; drop this one.
      if (controller.signal.aborted) return
      if (!res.ok || !data || data.error) {
        setError(data?.error ?? describeStatus(res.status))
        setServerFault(res.status >= 500)
        setOutcome(null)
        return
      }
      setOutcome(data)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
      // The request never landed, so this is network or server, not input.
      setServerFault(true)
      setOutcome(null)
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null
        setBusy(false)
      }
    }
  }, [])

  // One effect owns both the address bar and the fetch, so they can never
  // disagree about what is on screen.
  useEffect(() => {
    if (typeof location === 'undefined') return
    const params = toParams(query)
    const qs = params.toString()
    // A cleared box with the default mode means "nothing asked for", so the URL
    // goes back to bare `/` rather than carrying an empty query.
    const bare = !hasQuery && query.mode === 'semantic'
    history.replaceState(null, '', bare || !qs ? '/' : `/?${qs}`)

    if (!hasQuery || keywordWithPhoto) {
      inFlight.current?.abort()
      inFlight.current = null
      setOutcome(null)
      setBusy(false)
      return
    }

    if (immediate.current) {
      immediate.current = false
      void run(query)
      return
    }
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => void run(query), DEBOUNCE_MS)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [query, hasQuery, keywordWithPhoto, run])

  /** Merge a change into the query. Typing debounces; everything else does not. */
  const update = useCallback((patch: Partial<Query>, opts: { debounce?: boolean } = {}) => {
    immediate.current = !opts.debounce
    setQuery((prev) => ({ ...prev, ...patch }))
  }, [])

  /**
   * Search by a photo already in the corpus. This is the cheap path: the vector
   * is stored, so it resolves inside the search statement and never loads the
   * model, and unlike an upload it survives in the URL.
   */
  const usePhoto = useCallback(
    (photoId: string) => {
      const trimmed = photoId.trim()
      if (trimmed) update({ photoId: trimmed, q: '', file: null })
    },
    [update],
  )

  return { query, outcome, busy, error, serverFault, keywordWithPhoto, hasQuery, update, usePhoto }
}
