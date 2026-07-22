/**
 * Small helpers shared by everything that writes SQL here. Nothing in this file
 * is Lakebase-specific; see src/lakebase/ for that.
 */

/**
 * Collects bind values and hands back the `$n` placeholder for each.
 *
 * Queries in this project are plain SQL strings, so the one thing that must
 * never happen is a user value reaching the text. Every interpolation goes
 * through `add()`, which returns a placeholder and keeps the value in the
 * array. The only things built by concatenation are fixed fragments the query
 * files own.
 */
export function binder() {
  const values: unknown[] = []
  return {
    values,
    add(value: unknown): string {
      values.push(value)
      return `$${values.length}`
    },
  }
}

export type Binder = ReturnType<typeof binder>

export type PhotoHit = {
  id: string
  filename: string
  width: number
  height: number
  distance: number
  caption: string
}

export type CaptionHit = {
  id: number
  photoId: string
  filename: string
  body: string
  score: number
}

/** The HTTP driver returns numerics as strings; make the shape honest. */
export function normaliseHit(r: PhotoHit): PhotoHit {
  return {
    ...r,
    width: Number(r.width),
    height: Number(r.height),
    distance: Number(r.distance),
  }
}

/** The first caption for a photo, as a correlated subselect. */
export const CAPTION_SUBSELECT = `(select c.body from captions c where c.photo_id = p.id order by c.idx limit 1)`
