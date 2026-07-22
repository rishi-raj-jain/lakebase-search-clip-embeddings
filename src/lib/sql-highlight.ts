/**
 * Cobalt's one dark band: the SQL that produced the results on screen.
 * Highlighting is a small regex pass, enough to read, not a tokenizer.
 *
 * Shared by the server component and the browser, because switching mode
 * rewrites the panel without a navigation and both sides must produce the
 * same markup.
 */
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const KEYWORDS = /\b(select|from|where|order by|limit|as|and|or|join|on)\b/gi

export function highlightSql(sql: string): string {
  return (
    escapeHtml(sql)
      // Comments first, so keywords inside them are left alone.
      .replace(/(--[^\n]*)/g, '<span class="c">$1</span>')
      .replace(/('[^']*')/g, '<span class="s">$1</span>')
      .replace(/(\$\d+)/g, '<span class="n">$1</span>')
      .replace(KEYWORDS, '<span class="k">$&</span>')
  )
}
