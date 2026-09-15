/**
 * HTML → plain text, for the description fields ATS APIs return as markup.
 *
 * Shared by the adapters rather than written twice, because the *output* of this
 * function is what stage A reads: two subtly different cleaners would mean two
 * subtly different untrusted blobs, and a filter tuned against one of them.
 *
 * Block-level tags become spaces rather than being deleted, so that
 * `<li>Remote</li><li>US only</li>` does not collapse into `RemoteUS only` and
 * slip past a rule that expects a word boundary.
 */

/** Named entities that actually appear in job postings. Numeric forms are decoded below. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * `&lt;p&gt;` → `<p>`. Exported for the one source that needs it on its own.
 *
 * Greenhouse returns its `content` field entity-encoded, so the markup has to
 * be decoded *before* the tags can be stripped — `htmlToText` alone would strip
 * nothing and hand stage A a description full of literal `<div class="...">`.
 * Every other adapter gets this for free at the end of `htmlToText`, which is
 * where it belongs for text that was only ever text.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&([a-z0-9#]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

export function htmlToText(html: string, budget: number): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, budget);
}
