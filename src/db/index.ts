import { Client, neon, neonConfig } from '@neondatabase/serverless'

export function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.')
  return url
}

/**
 * The one thing the rest of the app needs from a connection: run parameterised
 * SQL, get rows back.
 *
 * The two drivers below disagree about the shape of a result. The HTTP one
 * hands back rows directly, the WebSocket one wraps them in `{ rows }`, so this
 * normalises them. Queries are written as plain SQL text with `$1` placeholders
 * and a values array, which is what both drivers speak natively.
 */
export type Db = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
}

/**
 * HTTP client, and the only one the deployed app uses.
 *
 * `neon()` sends each query as a single low-latency `fetch` to Neon's SQL-over-
 * HTTP endpoint. There is no connection to open, pool, or leak, which is the
 * whole reason it suits a serverless function: every request here is one
 * self-contained statement, and a WebSocket handshake per invocation would cost
 * more than the query.
 *
 * Everything at runtime goes through this: lib/search.ts and both API routes.
 *
 * What you give up is the session. No interactive transaction, no `SET`, no
 * `CREATE INDEX CONCURRENTLY`. Only the setup scripts need those, and they use
 * `connect()` below.
 */
export function httpDb(): Db {
  const sql = neon(connectionString())
  return {
    query: <T>(text: string, params: unknown[] = []) => sql.query(text, params) as Promise<T[]>,
  }
}

/**
 * A single WebSocket session, for setup scripts only. Never reached by the
 * deployed app.
 *
 * Each of the four callers needs something HTTP structurally cannot do:
 *
 *   load.ts           `begin` / `commit` around each batch, so a crash never
 *                     leaves a photo without its captions
 *   create-indexes.ts `create index concurrently`, which cannot run inside a
 *                     transaction and so cannot be a one-shot statement
 *   query.ts          `set lakebase_ann.probes`, a per-session GUC that is gone
 *                     the moment the connection closes
 *   index-info.ts     the same `set`, plus `lakebase_ann_prewarm`, which warms
 *                     the cache for *this* session
 *
 * create-schema.ts deliberately does not appear here: plain idempotent DDL
 * needs no session, so it runs over `httpDb()`.
 *
 * These are strictly sequential jobs, so one connection is all they should ever
 * hold. No pool. Caller owns it and must `await client.end()`.
 */
export async function connect(): Promise<{ client: Client; db: Db }> {
  // Node has no global WebSocket the driver will accept, so hand it `ws`.
  if (!neonConfig.webSocketConstructor) {
    const ws = (await import('ws')).default
    neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket
  }
  const client = new Client({ connectionString: connectionString() })
  await client.connect()
  return {
    client,
    db: {
      query: async <T>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[],
    },
  }
}
