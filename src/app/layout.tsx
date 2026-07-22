import '@/app/app.css'
import type { Metadata } from 'next'
import { Google_Sans, Google_Sans_Code } from 'next/font/google'

/**
 * next/font downloads these at build time, self-hosts them as our own assets
 * and derives a metric-matched fallback so the swap does not reflow. Nothing
 * here costs a request-time round trip, and no font file is fetched from
 * Google by the browser.
 *
 * `subsets: ['latin']` is what keeps that honest: without it every
 * unicode-range subset (Cyrillic, Greek, Vietnamese) is preloaded and the
 * browser fetches faces this page will never draw.
 */
const sans = Google_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
  fallback: ['ui-sans-serif', 'system-ui', 'sans-serif'],
})

const code = Google_Sans_Code({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-code',
  fallback: ['ui-monospace', 'SF Mono', 'monospace'],
})

export const metadata: Metadata = {
  title: 'Image search over CLIP embeddings · Lakebase Search on Neon',
  description: 'Search Flickr30k photos by text, by image, or by caption: one vector column, three Lakebase indexes, on Neon Postgres.',
  icons: { icon: 'data:,' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${code.variable}`}>
      <body>{children}</body>
    </html>
  )
}
