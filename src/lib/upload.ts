/**
 * The upload size limit, shared by the browser and the API route so the two can
 * never disagree about what is allowed.
 *
 * 4.5MB is Vercel's request body cap, not a number we picked. Past it the
 * platform rejects the request before the function runs and answers with a
 * plain-text error rather than our JSON, so the app never gets to explain
 * itself. The browser therefore checks first and refuses locally, which is also
 * instant: no waiting out an upload that was never going to arrive.
 */
export const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024

export const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** The message both sides show, so the wording does not drift between them. */
export const tooLargeMessage = (bytes: number) =>
  `That image is ${formatMb(bytes)}. The limit is ${formatMb(MAX_UPLOAD_BYTES)}, so it cannot be uploaded. Try a smaller one, or resize it first.`
