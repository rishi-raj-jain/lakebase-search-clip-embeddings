import { createReadStream } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DATA_DIR = `${ROOT}/data`
/**
 * Local scratch copy of the JPEGs. Neon Storage holds the real ones; this
 * exists only so the embed pass can re-read pixels without paying for a
 * download per photo, and it is safe to delete afterwards.
 */
export const IMAGES_DIR = `${DATA_DIR}/images`
export const METADATA_FILE = `${DATA_DIR}/metadata.jsonl`
export const EMBEDDINGS_FILE = `${DATA_DIR}/embeddings.jsonl`

/** Bare `--key value` / `--key=value` / `--flag` parser. */
export function parseArgs(argv = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[arg.slice(2)] = next
        i++
      } else {
        out[arg.slice(2)] = 'true'
      }
    }
  }
  return out
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Stream a .jsonl file a record at a time. The embeddings file runs to
 * hundreds of megabytes, so nothing here reads a whole file into memory.
 */
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  if (!(await fileExists(path))) return
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line) as T
  }
}

/** Yield fixed-size batches from any async iterable. */
export async function* batched<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = []
  for await (const item of source) {
    batch.push(item)
    if (batch.length >= size) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** Keep the JSONL readable and roughly a third smaller than full float64 text. */
export function roundVector(v: number[], places = 6): number[] {
  const f = 10 ** places
  return v.map((x) => Math.round(x * f) / f)
}
