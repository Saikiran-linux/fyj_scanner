/**
 * Strip HTML to plain text. We don't need a full DOM parser — job
 * descriptions are short and the embedder only cares about words, not
 * structure. This handles the cases that show up in practice across
 * Greenhouse / Ashby / Lever / SmartRecruiters payloads:
 *
 *   - <script>/<style> blocks → dropped entirely (script payloads
 *     polluting embeddings is a real risk on some careers sites).
 *   - <br> and block-level closers → newline.
 *   - All other tags → removed; their text content is kept.
 *   - Numeric and named HTML entities → decoded.
 *   - Whitespace collapsed; max 2 consecutive newlines preserved.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  trade: '™',
  copy: '©',
  reg: '®',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(input) {
  if (input == null) return '';
  let s = String(input);

  // Greenhouse's boards-api ships `content` with the markup *entity-encoded*
  // (e.g. `&lt;p&gt;…&lt;/p&gt;`) rather than as raw tags. If we strip tags
  // first, the regex matches nothing and entity-decoding later re-introduces
  // the tags into the "plain text" output. Decode entities *up front* so the
  // tag stripper sees real `<…>` and can remove them. We then decode again at
  // the end to catch entities that lived inside text content (e.g. `&amp;`).
  s = decodeEntities(s);

  // Drop script/style blocks before any other processing so their text
  // content doesn't end up in the output.
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Convert structural tags to newlines so paragraphs stay separated.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|li|h[1-6]|tr|td|th|section|article)\s*>/gi, '\n');

  // Strip everything else.
  s = s.replace(/<[^>]+>/g, '');

  s = decodeEntities(s);

  // Collapse whitespace: spaces/tabs → single space, but preserve up to
  // two newlines so list / paragraph structure survives.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}
