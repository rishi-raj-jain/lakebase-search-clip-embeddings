/**
 * Report what lakebase_ann actually built, and what there is to tune.
 *
 *   npm run db:stats
 *   npm run db:stats -- --prewarm
 *
 * `lakebase_ann_index_info` returns the partition layout as JSON. The `lists`
 * array is the thing to read: it is empty until the corpus is large enough for
 * the index to partition, and `lakebase_ann.probes` takes one value per entry
 * in it. On a few hundred rows you will see `lists: []`, which means every
 * query is already scanning everything and no probe setting will change a
 * result: tuning only becomes real once this array is populated.
 */
import { connect } from '@/db/index'
import { formatDuration, parseArgs } from '@scripts/lib/util'

type AnnInfo = {
  default_epsilon?: number
  default_probes?: number[]
  lists?: number[]
}

async function main() {
  const args = parseArgs()
  const { client, db } = await connect()

  try {
    const counts = await db.query<{ photos: string; captions: string }>(
      `select (select count(*) from photos) as photos,
              (select count(*) from captions) as captions`,
    )
    console.log(`corpus: ${counts[0]!.photos} photos, ${counts[0]!.captions} captions\n`)

    const indexes = await db.query<{
      indexname: string
      tablename: string
      amname: string
      size: string
    }>(`
      select i.relname as indexname,
             t.relname as tablename,
             a.amname,
             pg_size_pretty(pg_relation_size(i.oid)) as size
      from pg_class i
      join pg_index x on x.indexrelid = i.oid
      join pg_class t on t.oid = x.indrelid
      join pg_am a on a.oid = i.relam
      where a.amname like 'lakebase%'
      order by i.relname
    `)

    if (indexes.length === 0) {
      console.log('no lakebase indexes found, run `npm run db:index`')
      return
    }

    for (const idx of indexes) {
      console.log(`${idx.indexname}  [${idx.amname}]  on ${idx.tablename}  ${idx.size}`)

      if (idx.amname === 'lakebase_ann') {
        const rows = await db.query<{ info: string }>(`select lakebase_ann_index_info($1::regclass) as info`, [idx.indexname])
        const info = JSON.parse(rows[0]!.info) as AnnInfo
        const lists = info.lists ?? []
        console.log(`  epsilon (default): ${info.default_epsilon?.toFixed(3) ?? 'n/a'}`)
        console.log(`  partitions:        ${lists.length === 0 ? 'none (flat scan)' : lists.join(', ')}`)
        console.log(`  probes:            ${info.default_probes?.length ? info.default_probes.join(', ') : 'unset'}`)
        if (lists.length === 0) {
          console.log('  note: too few rows to partition. Load more photos before drawing any\n' + '        conclusion about probes or recall.')
        }

        if (args.prewarm) {
          const started = Date.now()
          await db.query(`select lakebase_ann_prewarm($1::regclass)`, [idx.indexname])
          console.log(`  prewarmed in ${formatDuration(Date.now() - started)}`)
        }
      }
      console.log()
    }

    // The GUCs you would actually reach for, and their current session values.
    const settings = await db.query<{ name: string; setting: string }>(`
      select name, setting from pg_settings
      where name like 'lakebase%'
      order by name
    `)
    console.log('settings (session):')
    for (const s of settings) {
      console.log(`  ${s.name.padEnd(32)} ${s.setting === '' ? '(unset)' : s.setting}`)
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
