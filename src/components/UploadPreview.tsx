'use client'

import { useEffect, useState } from 'react'

/**
 * Preview of an uploaded query image. Never leaves the browser except as bytes
 * to embed, and nothing is stored.
 *
 * The object URL is created in an effect rather than during render: rendering
 * would mint a fresh one on every re-render and leak every previous one, since
 * nothing would ever revoke them.
 */
export function UploadPreview({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  return (
    <div className="border-rule flex flex-wrap items-center gap-3 border-t px-3 py-3">
      {src && <img src={src} alt="" width="56" height="42" className="h-10 w-14 rounded-sm object-cover" />}
      <span className="meta">{file.name}</span>
      <span className="meta text-ink-4">embedded in-browser upload · not stored</span>
    </div>
  )
}
