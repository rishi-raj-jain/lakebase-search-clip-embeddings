/**
 * The Lakebase indexes: the access methods this whole demo exists to show.
 *
 * These live here rather than in the schema for two reasons. Both want a
 * populated table, an ANN index built on zero rows has no partitions to probe
 * and BM25 scoring depends on corpus-wide document-length statistics, so they
 * are created after the load by scripts/create-indexes.ts. And keeping the DDL
 * beside ann.ts and bm25.ts means the operator, the opclass and the query that
 * uses them are all readable in one place.
 */

export type IndexSpec = {
  name: string
  /** `concurrently` is passed in, because it cannot run inside a transaction. */
  ddl: (concurrently: string) => string
  note: string
}

export const INDEXES: IndexSpec[] = [
  {
    name: 'photos_embedding_ann',
    note: 'image vectors: the index behind text→image and image→image search',
    // vector_cosine_ops is what registers both <=> (ordering) and <<=>>
    // (the radius bound) as usable index strategies. See lakebase/ann.ts.
    ddl: (c) => `
      create index ${c} photos_embedding_ann on photos
      using lakebase_ann (embedding vector_cosine_ops)
      with (build_mode = 'standard')`,
  },
  {
    name: 'captions_embedding_ann',
    note: 'caption vectors: the index behind image→caption search',
    ddl: (c) => `
      create index ${c} captions_embedding_ann on captions
      using lakebase_ann (embedding vector_cosine_ops)
      with (build_mode = 'standard')`,
  },
  {
    name: 'captions_tsv_bm25',
    note: 'caption lexemes: keyword search to compare against the semantic result',
    // k1 controls term-frequency saturation, b controls length normalisation.
    // Flickr captions are short and uniform in length, so full normalisation
    // (b = 0.75, the default) is doing very little work here; left explicit so
    // it is obvious what to turn when you move to a corpus where it matters.
    //
    // The index name is not incidental: to_bm25query() takes it as an argument,
    // because scoring needs this index's corpus statistics. See lakebase/bm25.ts.
    ddl: (c) => `
      create index ${c} captions_tsv_bm25 on captions
      using lakebase_bm25 (tsv tsvector_bm25_ops)
      with (k1 = 1.2, b = 0.75)`,
  },
]

/** Asserted before building, so a missing extension reads better than "access method does not exist". */
export const REQUIRED_EXTENSIONS = ['vector', 'lakebase_vector', 'lakebase_text']
